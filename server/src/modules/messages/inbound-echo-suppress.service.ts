import { SendStatus } from "@prisma/client";
import { prisma } from "../../common/config/prisma.js";
import { env } from "../../common/config/env.js";
import { bigramDiceCoefficient, normalizeTextForEchoCompare } from "../../common/utils/text.js";

/** 入站（已规范化）与出站正文是否应判定为「复述/回声」 */
export function inboundMatchesOutboundEcho(params: {
  normalizedInboundText: string;
  outboundContent: string;
}): boolean {
  const ni = normalizeTextForEchoCompare(params.normalizedInboundText);
  const no = normalizeTextForEchoCompare(params.outboundContent);
  if (!ni || !no) return false;
  if (ni === no) return true;

  const minL = env.INBOUND_ECHO_CONTAIN_MIN_CHARS;
  if (ni.length >= minL && no.includes(ni)) return true;
  if (no.length >= minL && ni.includes(no)) return true;

  if (ni.length < minL || no.length < minL) return false;
  return bigramDiceCoefficient(ni, no) >= env.INBOUND_ECHO_DICE_THRESHOLD;
}

/**
 * 若入站正文与近期出站高度一致（含文首 @ 剥离、包含关系、Dice 相似），视为复述/回声，避免再次自动回复。
 * 可选要求发言人名为空（ECHO_REQUIRE_BLANK_SENDER），收紧误匹配。
 */
export async function findOutboundEchoMatch(params: {
  robotId: string;
  groupId: string;
  normalizedInboundText: string;
  senderName?: string | null;
}): Promise<{ matched: boolean; outboundMessageId?: string }> {
  if (!env.INBOUND_ECHO_SUPPRESS_ENABLED) return { matched: false };

  const t = params.normalizedInboundText;
  if (!t) return { matched: false };

  if (env.INBOUND_ECHO_REQUIRE_BLANK_SENDER && (params.senderName ?? "").trim().length > 0) {
    return { matched: false };
  }

  const since = new Date(Date.now() - env.INBOUND_ECHO_LOOKBACK_MINUTES * 60 * 1000);
  const take = env.INBOUND_ECHO_MAX_OUTBOUNDS;

  const rows = await prisma.outboundMessage.findMany({
    where: {
      robotId: params.robotId,
      groupId: params.groupId,
      OR: [
        {
          sendStatus: SendStatus.success,
          OR: [{ sentAt: { gte: since } }, { sentAt: null, createdAt: { gte: since } }]
        },
        {
          sendStatus: { in: [SendStatus.pending, SendStatus.pending_executor] },
          createdAt: { gte: since }
        }
      ]
    },
    orderBy: [{ createdAt: "desc" }],
    take,
    select: { id: true, content: true, sendStatus: true }
  });

  for (const row of rows) {
    if (inboundMatchesOutboundEcho({ normalizedInboundText: t, outboundContent: row.content ?? "" })) {
      return { matched: true, outboundMessageId: row.id };
    }
  }
  return { matched: false };
}
