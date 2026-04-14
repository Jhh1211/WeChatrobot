import type { InboundMessage } from "@prisma/client";
import { SendStatus } from "@prisma/client";
import { prisma } from "../../common/config/prisma.js";
import type { EffectiveGroupReplyPolicy } from "../groups/group-reply-policy.service.js";

/** 与客户端上报的发言人昵称对齐：去首尾空白、折叠连续空白 */
export function normalizeSenderKey(name: string | null | undefined): string {
  if (name == null) return "";
  return name.replace(/\s+/g, " ").trim();
}

function clipText(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return t.slice(0, max) + "…";
}

function isLikelyUserInbound(m: { isFromRobot: boolean; semanticKind: string | null }): boolean {
  if (m.isFromRobot) return false;
  const k = m.semanticKind;
  if (k === "system_notice" || k === "self_text") return false;
  return true;
}

export type SameSenderContextMeta = {
  senderKey: string;
  userLines: number;
  botLines: number;
  windowMinutes: number;
  truncated: boolean;
  emptyTimeline: boolean;
};

export type SameSenderContextResult = {
  /** 拼在 burst 合并文案之前的参考块；无则 null */
  prefix: string | null;
  meta: SameSenderContextMeta | null;
};

/**
 * 拉取锚点消息之前、时间窗内同群同昵称用户入站 + 本助手 outbound，供 LLM 理解连续追问。
 * @param excludeInboundIds 当前 burst 批次内的入站 id，避免与 buildBurstMergeContext 重复
 */
export async function buildSameSenderConversationContext(params: {
  groupId: string;
  anchor: InboundMessage;
  policy: EffectiveGroupReplyPolicy;
  excludeInboundIds: readonly string[];
}): Promise<SameSenderContextResult> {
  const { policy, anchor, groupId, excludeInboundIds } = params;

  if (!policy.sameSenderContextEnabled) {
    return { prefix: null, meta: null };
  }

  const senderKey = normalizeSenderKey(anchor.senderName);
  if (!senderKey) {
    return { prefix: null, meta: null };
  }

  const anchorTs = anchor.inboundCapturedAt ?? anchor.sentAt ?? anchor.createdAt;
  const windowMs = policy.sameSenderContextWindowMinutes * 60_000;
  const windowStart = new Date(anchorTs.getTime() - windowMs);

  const excl = new Set(excludeInboundIds);
  excl.add(anchor.id);

  const inboundWindow = await prisma.inboundMessage.findMany({
    where: {
      groupId,
      createdAt: { gte: windowStart, lte: anchorTs },
      isFromRobot: false
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      senderName: true,
      messageText: true,
      semanticKind: true,
      isFromRobot: true,
      createdAt: true
    }
  });

  const userCandidates = inboundWindow.filter(
    (m) =>
      !excl.has(m.id) &&
      isLikelyUserInbound(m) &&
      normalizeSenderKey(m.senderName) === senderKey &&
      (m.messageText?.trim().length ?? 0) > 0
  );

  const maxU = policy.sameSenderContextMaxUserMessages;
  const userPicked = userCandidates.slice(-maxU);

  const outboundWindow = await prisma.outboundMessage.findMany({
    where: {
      groupId,
      createdAt: { gte: windowStart, lte: anchorTs },
      sendStatus: { in: [SendStatus.success, SendStatus.pending_executor, SendStatus.pending] }
    },
    orderBy: { createdAt: "desc" },
    take: policy.sameSenderContextMaxBotMessages,
    select: { content: true, createdAt: true, sentAt: true }
  });
  const botPicked = [...outboundWindow].reverse();

  type Line = { t: number; role: "user" | "assistant"; text: string };
  const lines: Line[] = [];
  for (const m of userPicked) {
    lines.push({
      t: m.createdAt.getTime(),
      role: "user",
      text: clipText(m.messageText!, 520)
    });
  }
  for (const o of botPicked) {
    const ts = (o.sentAt ?? o.createdAt).getTime();
    lines.push({ t: ts, role: "assistant", text: clipText(o.content, 900) });
  }
  lines.sort((a, b) => a.t - b.t);

  const metaBase: SameSenderContextMeta = {
    senderKey,
    userLines: userPicked.length,
    botLines: botPicked.length,
    windowMinutes: policy.sameSenderContextWindowMinutes,
    truncated: false,
    emptyTimeline: lines.length === 0
  };

  if (lines.length === 0) {
    return { prefix: null, meta: metaBase };
  }

  const header = `【同群同发言人「${senderKey}」近 ${policy.sameSenderContextWindowMinutes} 分钟对话摘录】（昵称匹配；用于理解连续追问）`;
  const body = lines.map((l) => (l.role === "user" ? `用户：${l.text}` : `助手：${l.text}`)).join("\n");

  let prefix = `${header}\n${body}`;
  let truncated = false;
  const max = policy.sameSenderContextMaxTotalChars;
  if (prefix.length > max) {
    prefix = prefix.slice(0, max) + "\n…(摘录已截断)";
    truncated = true;
  }

  return {
    prefix,
    meta: { ...metaBase, truncated, emptyTimeline: false }
  };
}
