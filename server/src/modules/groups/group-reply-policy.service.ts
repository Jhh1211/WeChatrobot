import type { Group, Prisma, RetrievalMode } from "@prisma/client";
import { prisma } from "../../common/config/prisma.js";
import type { ReplyLlmProviderMode } from "../config/runtime-config.service.js";
import { normalizeReplyLlmProvider } from "../config/runtime-config.service.js";

export type EffectiveGroupReplyPolicy = {
  autoReplyEnabled: boolean;
  replyProfileId: string | null;
  knowledgeCollectionId: string | null;
  retrievalMode: RetrievalMode;
  knowledgeFirst: boolean;
  cannedFirst: boolean;
  scoreThreshold: number | null;
  cooldownSeconds: number | null;
  riskInterceptEnabled: boolean;
  humanTakeover: boolean;
  policyRowEnabled: boolean;
  /** null=继承运行配置；否则覆盖 */
  replyLlmProvider: ReplyLlmProviderMode | null;
  /** 同发言人（昵称）短期对话进 LLM；用户键仅为客户端上报的 senderName */
  sameSenderContextEnabled: boolean;
  sameSenderContextWindowMinutes: number;
  sameSenderContextMaxUserMessages: number;
  sameSenderContextMaxBotMessages: number;
  sameSenderContextMaxTotalChars: number;
};

export async function getEffectiveGroupPolicy(groupId: string, group: Group): Promise<EffectiveGroupReplyPolicy> {
  const row = await prisma.groupReplyPolicy.findUnique({ where: { groupId } });
  const rawProv = row?.replyLlmProvider;
  return {
    autoReplyEnabled: row?.autoReplyEnabled ?? group.autoReplyEnabled,
    replyProfileId: row?.replyProfileId ?? null,
    knowledgeCollectionId: row?.knowledgeCollectionId ?? null,
    retrievalMode: row?.retrievalMode ?? "keyword_first",
    knowledgeFirst: row?.knowledgeFirst ?? true,
    cannedFirst: row?.cannedFirst ?? true,
    scoreThreshold: row?.scoreThreshold ?? null,
    cooldownSeconds: row?.cooldownSeconds ?? null,
    riskInterceptEnabled: row?.riskInterceptEnabled ?? true,
    humanTakeover: row?.humanTakeover ?? false,
    policyRowEnabled: row?.enabled ?? true,
    replyLlmProvider:
      rawProv != null && String(rawProv).trim() !== "" ? normalizeReplyLlmProvider(String(rawProv)) : null,
    sameSenderContextEnabled: row?.sameSenderContextEnabled ?? true,
    sameSenderContextWindowMinutes: row?.sameSenderContextWindowMinutes ?? 5,
    sameSenderContextMaxUserMessages: row?.sameSenderContextMaxUserMessages ?? 8,
    sameSenderContextMaxBotMessages: row?.sameSenderContextMaxBotMessages ?? 5,
    sameSenderContextMaxTotalChars: row?.sameSenderContextMaxTotalChars ?? 3500
  };
}

export async function upsertGroupReplyPolicy(
  groupId: string,
  data: Prisma.GroupReplyPolicyUncheckedCreateInput
) {
  return prisma.groupReplyPolicy.upsert({
    where: { groupId },
    create: { ...data, groupId },
    update: data
  });
}
