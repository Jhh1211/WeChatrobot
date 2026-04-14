import { SendStatus, type Group, type InboundMessage, type ReplyProfile, type RetrievalMode } from "@prisma/client";
import { prisma } from "../../common/config/prisma.js";
import {
  DEFAULT_ARK_BOT_BASE_URL,
  getEffectiveRuntimeConfig,
  type ReplyLlmProviderMode
} from "../config/runtime-config.service.js";
import { getEffectiveGroupPolicy } from "../groups/group-reply-policy.service.js";
import { matchCannedReplyRule } from "../rules/canned-rule.engine.js";
import { retrieveChunks } from "../knowledge/knowledge-chunk.service.js";
import { generateLlmReplyJson } from "../../integrations/llm/llm.runtime.js";
import { normalizeText, truncateByLength } from "../../common/utils/text.js";
import { env } from "../../common/config/env.js";
import { outboundSendQueue } from "../../queue/connection.js";
import { JOB_NAMES } from "../../queue/names.js";
import { logger } from "../../common/logger/pino.js";
import type { ReplyLatencyTracker } from "./reply-latency.js";
import type { SameSenderContextMeta } from "../conversations/same-sender-context.service.js";

export type ReplyPipelineMeta = {
  matchedCannedRuleId: string | null;
  matchedKnowledgeIds: string[];
  replyProfileId: string | null;
  retrievalMode: string;
  knowledgeSnippets: Array<{ title: string; content: string; score: number }>;
  promptPreview: string;
  llmResponsePreview: string | null;
  replySource: string;
};

const FALLBACK_SYSTEM =
  "你是企业微信群助理。必须使用简体中文回复，简洁、专业、友好。不要编造事实；不确定时请建议联系人工。严格遵守字数上限。";

async function resolveProfile(
  policyProfileId: string | null,
  runtimeDefaultId: string | null
): Promise<ReplyProfile | null> {
  if (policyProfileId) {
    const p = await prisma.replyProfile.findFirst({ where: { id: policyProfileId, enabled: true } });
    if (p) return p;
  }
  if (runtimeDefaultId) {
    const p = await prisma.replyProfile.findFirst({ where: { id: runtimeDefaultId, enabled: true } });
    if (p) return p;
  }
  return prisma.replyProfile.findFirst({ where: { enabled: true }, orderBy: { createdAt: "asc" } });
}

function resolveLlmRuntimeForReply(
  rt: Awaited<ReturnType<typeof getEffectiveRuntimeConfig>>,
  policyReplyLlm: ReplyLlmProviderMode | null
): {
  cfg: import("../../integrations/llm/llm.runtime.js").LlmRuntimeConfig;
  provider: ReplyLlmProviderMode;
} {
  const mode: ReplyLlmProviderMode = policyReplyLlm ?? rt.replyLlmProvider;
  const standardCfg = {
    baseUrl: rt.llmBaseUrl.replace(/\/$/, ""),
    apiKey: rt.llmApiKey,
    model: rt.llmModel
  };
  if (mode !== "ark_bot") {
    return { cfg: standardCfg, provider: "standard" };
  }
  const model = rt.arkBotModel?.trim();
  const apiKey = (rt.arkBotApiKey ?? "").trim();
  const baseUrl = (rt.arkBotBaseUrl || DEFAULT_ARK_BOT_BASE_URL).replace(/\/$/, "");
  if (!model || !apiKey) {
    logger.warn(
      {
        msg: "reply_llm_ark_bot_misconfigured_using_standard",
        hasArkModel: Boolean(model),
        hasArkKey: Boolean(apiKey)
      },
      "ark_bot selected but arkBotModel or arkBotApiKey empty; fallback to standard LLM"
    );
    return { cfg: standardCfg, provider: "standard" };
  }
  return { cfg: { baseUrl, apiKey, model }, provider: "ark_bot" };
}

function buildSystemPrompt(profile: ReplyProfile | null, rt: Awaited<ReturnType<typeof getEffectiveRuntimeConfig>>) {
  const lang = profile?.language || rt.defaultLanguage || "zh-CN";
  const base = profile?.systemPrompt || FALLBACK_SYSTEM;
  const style = profile?.stylePrompt || rt.defaultStyleHint || "语气自然，像真人运营。";
  const emoji = profile?.emojiPolicy ? `表情策略：${profile.emojiPolicy}。` : "";
  const mention = profile?.mentionPolicy ? `提及他人策略：${profile.mentionPolicy}。` : "";
  return [`语言偏好：${lang}。`, base, style, emoji, mention].filter(Boolean).join("\n");
}

export async function generateReplyCore(params: {
  message: InboundMessage;
  group: Group;
  intent: string;
  /** 聚合/拼接后的用户侧文案，供 LLM；缺省用 message.messageText */
  userMessageForLlm?: string;
  /** 知识检索用规范化文本；缺省用 message.messageTextNormalized */
  normalizedForRetrieval?: string;
  latency?: ReplyLatencyTracker;
}): Promise<{ text: string; meta: ReplyPipelineMeta }> {
  const rt = await getEffectiveRuntimeConfig();
  const policy = await getEffectiveGroupPolicy(params.group.id, params.group);
  const userMessage = params.message.messageText ?? "";
  const llmUserBlock = params.userMessageForLlm ?? userMessage;
  const normalized = params.normalizedForRetrieval ?? params.message.messageTextNormalized ?? "";

  const effectiveMode: RetrievalMode = policy.retrievalMode ?? rt.retrievalMode;

  const embedCfg =
    rt.embeddingApiKey && rt.embeddingModel
      ? { baseUrl: rt.embeddingBaseUrl, apiKey: rt.embeddingApiKey, model: rt.embeddingModel }
      : null;

  const meta: ReplyPipelineMeta = {
    matchedCannedRuleId: null,
    matchedKnowledgeIds: [],
    replyProfileId: null,
    retrievalMode: effectiveMode,
    knowledgeSnippets: [],
    promptPreview: "",
    llmResponsePreview: null,
    replySource: "llm_only"
  };

  if (policy.cannedFirst) {
    const canned = await matchCannedReplyRule(params.group.id, userMessage);
    if (canned) {
      meta.matchedCannedRuleId = canned.ruleId;
      meta.replySource = "canned";
      const profile = await resolveProfile(policy.replyProfileId, rt.defaultReplyProfileId);
      meta.replyProfileId = profile?.id ?? null;
      const maxChars = profile?.maxChars ?? rt.maxReplyChars;
      return { text: truncateByLength(canned.replyText, maxChars), meta };
    }
  }

  const chunks = await retrieveChunks({
    collectionId: policy.knowledgeCollectionId,
    queryText: normalized,
    mode: effectiveMode,
    topK: 8,
    embedConfig: embedCfg
  });
  meta.matchedKnowledgeIds = [...new Set(chunks.map((c) => c.documentId))];
  meta.knowledgeSnippets = chunks.map((c) => ({ title: c.title, content: c.content, score: c.score }));

  const profile = await resolveProfile(policy.replyProfileId, rt.defaultReplyProfileId);
  meta.replyProfileId = profile?.id ?? null;
  const maxChars = profile?.maxChars ?? rt.maxReplyChars;

  const systemPrompt = buildSystemPrompt(profile, rt);
  const snippetsText = chunks
    .filter((c) => c.score > 0.001)
    .map((c, i) => `#${i + 1} ${c.title}\n${c.content}`)
    .join("\n\n");

  const hasKb = snippetsText.length > 0;
  const knowledgeFirst = policy.knowledgeFirst ?? rt.knowledgeFirst;
  const allowFallback = policy.policyRowEnabled ? rt.allowLlmFallback : rt.allowLlmFallback;

  if (knowledgeFirst && !hasKb && !allowFallback) {
    meta.replySource = "no_kb_no_fallback";
    const text = truncateByLength("当前知识库未命中相关内容，已关闭纯模型兜底；请联系人工。", maxChars);
    meta.promptPreview = systemPrompt.slice(0, 2000);
    return { text, meta };
  }

  if (knowledgeFirst && !hasKb && allowFallback) {
    const userPrompt = [
      `用户消息：${llmUserBlock}`,
      `意图：${params.intent}`,
      "知识库未命中；请直接根据常识与群场景用中文简短回复。",
      "输出 JSON：{should_reply,reply_text,intent,confidence,risk_level,style}"
    ].join("\n\n");
    meta.promptPreview = `${systemPrompt}\n---\n${userPrompt}`.slice(0, 8000);
    const { cfg: llmCfg, provider: llmProv } = resolveLlmRuntimeForReply(rt, policy.replyLlmProvider);
    params.latency?.markLlmStart();
    let llmResult;
    try {
      llmResult = await generateLlmReplyJson(llmCfg, { systemPrompt, userPrompt });
    } finally {
      params.latency?.markLlmEnd();
    }
    meta.llmResponsePreview = JSON.stringify(llmResult).slice(0, 4000);
    meta.replySource = llmProv === "ark_bot" ? "llm_only_ark_bot" : "llm_only";
    return { text: truncateByLength(llmResult.reply_text, maxChars), meta };
  }

  const userPromptKb = [
    `用户消息：${llmUserBlock}`,
    `意图：${params.intent}`,
    knowledgeFirst ? "请优先依据下列知识片段回答；片段不足时可合理补充但不要编造。" : "下列知识片段供参考，可结合常识回答。",
    "知识片段：",
    snippetsText || "(无)",
    "输出 JSON：{should_reply,reply_text,intent,confidence,risk_level,style}"
  ].join("\n\n");

  meta.promptPreview = `${systemPrompt}\n---\n${userPromptKb}`.slice(0, 8000);
  const { cfg: llmCfgKb, provider: llmProvKb } = resolveLlmRuntimeForReply(rt, policy.replyLlmProvider);
  params.latency?.markLlmStart();
  let llmResultKb;
  try {
    llmResultKb = await generateLlmReplyJson(llmCfgKb, { systemPrompt, userPrompt: userPromptKb });
  } finally {
    params.latency?.markLlmEnd();
  }
  meta.llmResponsePreview = JSON.stringify(llmResultKb).slice(0, 4000);
  if (hasKb) {
    meta.replySource = llmProvKb === "ark_bot" ? "kb_llm_ark_bot" : "kb_llm";
  } else {
    meta.replySource = llmProvKb === "ark_bot" ? "llm_only_ark_bot" : "llm_only";
  }
  return { text: truncateByLength(llmResultKb.reply_text, maxChars), meta };
}

export async function buildAndQueueReplyWithTrace(params: {
  message: InboundMessage;
  group: Group;
  intent: string;
  delayMs: number;
  decisionSnapshot: unknown;
  userMessageForLlm?: string;
  normalizedForRetrieval?: string;
  burstGroupedCount?: number | null;
  mergedMessagesPreview?: string | null;
  finalUserPromptPreview?: string | null;
  sameSenderContextSenderKey?: string | null;
  sameSenderContextMeta?: SameSenderContextMeta | null;
  latency?: ReplyLatencyTracker;
  semanticMessageType?: string;
  enteredAiPipeline?: boolean;
}) {
  const trace = await prisma.replyTrace.create({
    data: {
      inboundMessageId: params.message.id,
      groupId: params.group.id,
      status: "pending",
      normalizedText: params.message.messageTextNormalized ?? "",
      semanticMessageType: params.semanticMessageType ?? params.message.semanticKind ?? undefined,
      enteredAiPipeline: params.enteredAiPipeline ?? true,
      burstGroupedCount: params.burstGroupedCount ?? undefined,
      mergedMessagesPreview: params.mergedMessagesPreview ?? undefined,
      finalUserPromptPreview: params.finalUserPromptPreview ?? undefined,
      sameSenderContextSenderKey: params.sameSenderContextSenderKey ?? undefined,
      sameSenderContextMeta: params.sameSenderContextMeta
        ? (params.sameSenderContextMeta as object)
        : undefined,
      decisionSnapshot: params.decisionSnapshot as object,
      latencyBreakdown: params.latency ? (params.latency.toJSON() as object) : undefined
    }
  });

  try {
    const { text, meta } = await generateReplyCore({
      message: params.message,
      group: params.group,
      intent: params.intent,
      userMessageForLlm: params.userMessageForLlm,
      normalizedForRetrieval: params.normalizedForRetrieval,
      latency: params.latency
    });

    const normReply = normalizeText(text);
    if (env.OUTBOUND_CONTENT_DEDUPE_MS > 0 && normReply.length > 0) {
      const sinceOut = new Date(Date.now() - env.OUTBOUND_CONTENT_DEDUPE_MS);
      const recentSameBody = await prisma.outboundMessage.findFirst({
        where: {
          groupId: params.group.id,
          sendStatus: { in: [SendStatus.pending, SendStatus.pending_executor, SendStatus.success] },
          createdAt: { gte: sinceOut }
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, content: true }
      });
      if (recentSameBody && normalizeText(recentSameBody.content) === normReply) {
        await prisma.replyTrace.update({
          where: { id: trace.id },
          data: {
            status: "skipped_filter",
            skipAutoReplyReason: "duplicate_outbound_same_body_short_window",
            finalReply: text,
            replySource: meta.replySource,
            promptPreview: meta.promptPreview.slice(0, 8000),
            llmResponsePreview: meta.llmResponsePreview,
            latencyBreakdown: params.latency ? (params.latency.toJSON() as object) : undefined
          }
        });
        logger.info(
          { traceId: trace.id, duplicateOfOutboundId: recentSameBody.id, groupId: params.group.id },
          "reply_pipeline_skipped_duplicate_outbound"
        );
        return;
      }
    }

    params.latency?.markOutboundCreated();

    const outbound = await prisma.outboundMessage.create({
      data: {
        robotId: params.message.robotId,
        groupId: params.group.id,
        relatedInboundMessageId: params.message.id,
        content: text,
        targetTitle: params.group.title,
        sendStatus: SendStatus.pending,
        sendRequest: {
          targetTitle: params.group.title,
          receivedContent: text,
          replyTraceId: trace.id
        }
      }
    });

    await prisma.replyTrace.update({
      where: { id: trace.id },
      data: {
        status: "completed",
        matchedCannedRuleId: meta.matchedCannedRuleId,
        matchedKnowledgeIds: meta.matchedKnowledgeIds,
        replyProfileId: meta.replyProfileId,
        retrievalMode: meta.retrievalMode,
        knowledgeSnippets: meta.knowledgeSnippets as object,
        promptPreview: meta.promptPreview,
        llmResponsePreview: meta.llmResponsePreview,
        finalUserPromptPreview:
          params.finalUserPromptPreview ?? (meta.promptPreview ? meta.promptPreview.slice(0, 8000) : undefined),
        finalReply: text,
        replySource: meta.replySource,
        outboundMessageId: outbound.id,
        latencyBreakdown: params.latency ? (params.latency.toJSON() as object) : undefined
      }
    });

    await prisma.auditLog.create({
      data: {
        entityType: "reply",
        entityId: outbound.id,
        action: meta.replySource === "canned" ? "canned_reply" : "pipeline_reply",
        detail: { traceId: trace.id, replySource: meta.replySource }
      }
    });

    await outboundSendQueue.add(
      JOB_NAMES.sendOutboundMessage,
      { outboundMessageId: outbound.id, replyTraceId: trace.id },
      {
        delay: Math.max(0, params.delayMs),
        attempts: 3,
        backoff: { type: "exponential", delay: 1500 },
        removeOnComplete: 1000
      }
    );

    logger.info({ traceId: trace.id, outboundId: outbound.id, replySource: meta.replySource }, "reply_pipeline_queued");
    return outbound;
  } catch (error) {
    await prisma.replyTrace.update({
      where: { id: trace.id },
      data: {
        status: "failed",
        errorMessage: String(error),
        latencyBreakdown: params.latency ? (params.latency.toJSON() as object) : undefined
      }
    });
    throw error;
  }
}

export async function previewReplyPipeline(input: {
  groupId: string;
  messageText: string;
  intent?: string;
}) {
  const group = await prisma.group.findUnique({ where: { id: input.groupId } });
  if (!group) throw new Error("group_not_found");
  const fakeMessage = {
    id: "preview",
    messageText: input.messageText,
    messageTextNormalized: input.messageText.toLowerCase().replace(/\s+/g, " "),
    robotId: "",
    groupId: group.id,
    eventId: "",
    senderId: null,
    senderName: null,
    chatType: "group" as const,
    messageType: "text" as const,
    semanticKind: "user_text",
    externalMessageId: null,
    replyToMessageId: null,
    sentAt: null,
    isFromRobot: false,
    createdAt: new Date()
  } as unknown as InboundMessage;

  return generateReplyCore({
    message: fakeMessage,
    group,
    intent: input.intent ?? "unknown"
  });
}
