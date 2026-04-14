import { prisma } from "../../common/config/prisma.js";
import { env } from "../../common/config/env.js";

/**
 * 同群、同规范化正文在短窗内重复入站（多为 UI 抖动/重复事件），按己方处理以免二次 burst。
 */
export async function findRecentInboundDuplicate(params: {
  groupId: string;
  robotId: string;
  normalizedText: string;
}): Promise<{ duplicate: boolean; priorInboundId?: string }> {
  const windowSec = env.INBOUND_SHORT_DEDUPE_SECONDS;
  if (windowSec <= 0 || !params.normalizedText) return { duplicate: false };

  const since = new Date(Date.now() - windowSec * 1000);
  const prior = await prisma.inboundMessage.findFirst({
    where: {
      groupId: params.groupId,
      robotId: params.robotId,
      messageTextNormalized: params.normalizedText,
      createdAt: { gte: since }
    },
    orderBy: { createdAt: "desc" },
    select: { id: true }
  });
  if (!prior) return { duplicate: false };
  return { duplicate: true, priorInboundId: prior.id };
}
