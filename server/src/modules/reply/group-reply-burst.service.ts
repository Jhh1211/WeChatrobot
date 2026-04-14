import { randomUUID } from "node:crypto";
import type { InboundMessage } from "@prisma/client";
import { prisma } from "../../common/config/prisma.js";
import { redis } from "../../common/config/redis.js";
import { env } from "../../common/config/env.js";
import { groupReplyBurstQueue } from "../../queue/connection.js";
import { logger } from "../../common/logger/pino.js";
import { getRecentGroupMessages } from "../conversations/conversations.service.js";
import { buildSameSenderConversationContext } from "../conversations/same-sender-context.service.js";
import { evaluateReplyDecision } from "../rules/reply-decision.engine.js";
import { buildAndQueueReplyWithTrace } from "./reply-pipeline.service.js";
import { classifyIntent } from "../intent/intent.service.js";
import { getEffectiveGroupPolicy } from "../groups/group-reply-policy.service.js";
import { writeAuditLog } from "../audit/audit.service.js";
import { classifyInboundSemantic, type SemanticMessageKind } from "../messages/inbound-semantic.classifier.js";
import { ReplyLatencyTracker } from "./reply-latency.js";

const burstMsgKey = (groupId: string) => `burst:msgs:${groupId}`;
const lockKey = (groupId: string) => `lock:group-reply:${groupId}`;

function effectiveSemanticKind(m: InboundMessage): SemanticMessageKind {
  if (m.isFromRobot) return "self_text";
  const k = m.semanticKind;
  if (k === "user_text" || k === "self_text" || k === "system_notice" || k === "unknown") {
    return k;
  }
  return classifyInboundSemantic({
    text: m.messageText ?? "",
    isFromRobot: false,
    senderName: m.senderName,
    inGroup: Boolean(m.groupId)
  }).kind;
}

async function releaseLock(key: string, token: string): Promise<void> {
  const script =
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
  await redis.eval(script, 1, key, token);
}

export function buildBurstMergeContext(
  messages: InboundMessage[],
  maxContextLines: number
): { userMessageForLlm: string; mergedMessagesPreview: string; primaryNormalized: string } {
  const ordered = [...messages].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const anchor = ordered[ordered.length - 1]!;
  const prev = ordered.slice(0, -1).slice(-maxContextLines);
  const primary = (anchor.messageText ?? "").trim();
  const mergedMessagesPreview = ordered
    .map((m) => `[${m.senderName ?? "用户"}] ${(m.messageText ?? "").slice(0, 100)}`)
    .join("\n");
  let userMessageForLlm = primary;
  if (prev.length > 0) {
    const ctx = prev
      .map((m) => `• ${m.senderName ?? "用户"}：${(m.messageText ?? "").slice(0, 200)}`)
      .join("\n");
    userMessageForLlm = [
      "【本轮最后一条问题，请主要围绕这一句作答】",
      primary,
      "",
      "【仅供参考的先前发言（按时间顺序）】",
      ctx
    ].join("\n");
  }
  return {
    userMessageForLlm,
    mergedMessagesPreview,
    primaryNormalized: anchor.messageTextNormalized ?? ""
  };
}

export async function appendAndScheduleGroupBurst(groupId: string, inboundMessageId: string): Promise<void> {
  await redis.rpush(burstMsgKey(groupId), inboundMessageId);
  await redis.expire(burstMsgKey(groupId), 900);
  const jobId = `burst-flush:${groupId}`;
  const existing = await groupReplyBurstQueue.getJob(jobId);
  if (existing) {
    try {
      await existing.remove();
    } catch (e) {
      logger.warn({ err: e, jobId }, "burst_job_remove_skipped");
    }
  }
  await groupReplyBurstQueue.add(
    "flush",
    { groupId },
    { delay: env.REPLY_BURST_WINDOW_MS, jobId, removeOnComplete: 1000 }
  );
}

async function runBurstReplyForMessages(groupId: string, messages: InboundMessage[]): Promise<void> {
  const group = await prisma.group.findUnique({ where: { id: groupId } });
  if (!group || !group.enabled) return;

  const gpol = await getEffectiveGroupPolicy(group.id, group);
  if (!gpol.autoReplyEnabled || gpol.humanTakeover || !gpol.policyRowEnabled) {
    return;
  }

  const userTextOnly = messages.filter((m) => effectiveSemanticKind(m) === "user_text");
  if (userTextOnly.length === 0) {
    return;
  }

  const anchor = userTextOnly[userTextOnly.length - 1]!;
  if (effectiveSemanticKind(anchor) !== "user_text") {
    return;
  }

  const { userMessageForLlm, mergedMessagesPreview, primaryNormalized } = buildBurstMergeContext(
    userTextOnly,
    env.REPLY_BURST_CONTEXT_LINES
  );

  const sameCtx = await buildSameSenderConversationContext({
    groupId,
    anchor,
    policy: gpol,
    excludeInboundIds: userTextOnly.map((m) => m.id)
  });
  const userMessageForLlmWithContext =
    sameCtx.prefix != null ? `${sameCtx.prefix}\n\n${userMessageForLlm}` : userMessageForLlm;

  const latency = new ReplyLatencyTracker();
  if (anchor.inboundCapturedAt) {
    latency.markInboundCaptured(anchor.inboundCapturedAt);
  } else {
    latency.markInboundCaptured(anchor.createdAt);
  }
  latency.markInboundPersisted(anchor.createdAt);

  const intent = classifyIntent(anchor.messageText ?? primaryNormalized);

  latency.markDecisionStart();
  const recentMessages = await getRecentGroupMessages(groupId, 20);
  const decision = await evaluateReplyDecision({ message: anchor, group, recentMessages });
  latency.markDecisionEnd();

  await prisma.replyDecision.create({
    data: {
      inboundMessageId: anchor.id,
      shouldReply: decision.shouldReply,
      score: decision.score,
      riskLevel: decision.riskLevel,
      matchedRules: decision.matchedRules,
      intent: decision.intent,
      reason: decision.reason,
      delayMs: decision.delayMs
    }
  });

  await writeAuditLog({
    entityType: "inbound_message",
    entityId: anchor.id,
    action: "reply_decision",
    detail: { ...decision, burstGroupedCount: userTextOnly.length }
  });

  if (!decision.shouldReply || !decision.delayMs) {
    await prisma.replyTrace.create({
      data: {
        inboundMessageId: anchor.id,
        groupId,
        status: "skipped_no_reply",
        normalizedText: anchor.messageTextNormalized ?? "",
        semanticMessageType: anchor.semanticKind ?? "user_text",
        skipAutoReplyReason: "决策未触发自动回复",
        enteredAiPipeline: false,
        burstGroupedCount: userTextOnly.length,
        mergedMessagesPreview,
        finalUserPromptPreview: userMessageForLlmWithContext.slice(0, 4000),
        sameSenderContextSenderKey: sameCtx.meta?.senderKey ?? undefined,
        sameSenderContextMeta: sameCtx.meta ? (sameCtx.meta as object) : undefined,
        decisionSnapshot: decision as object,
        latencyBreakdown: latency.toJSON() as object
      }
    });
    return;
  }

  await buildAndQueueReplyWithTrace({
    message: anchor,
    group,
    intent,
    delayMs: decision.delayMs,
    decisionSnapshot: decision,
    userMessageForLlm: userMessageForLlmWithContext,
    normalizedForRetrieval: primaryNormalized,
    burstGroupedCount: userTextOnly.length,
    mergedMessagesPreview,
    finalUserPromptPreview: userMessageForLlmWithContext.slice(0, 4000),
    sameSenderContextSenderKey: sameCtx.meta?.senderKey ?? null,
    sameSenderContextMeta: sameCtx.meta,
    latency,
    semanticMessageType: anchor.semanticKind ?? "user_text",
    enteredAiPipeline: true
  });
}

export async function processGroupBurstFlush(groupId: string): Promise<void> {
  const key = burstMsgKey(groupId);
  const rawIds = await redis.lrange(key, 0, -1);
  if (rawIds.length === 0) return;

  await redis.del(key);

  const uniqueOrdered: string[] = [];
  const seen = new Set<string>();
  for (const id of rawIds) {
    if (!seen.has(id)) {
      seen.add(id);
      uniqueOrdered.push(id);
    }
  }

  const rows = await prisma.inboundMessage.findMany({
    where: { id: { in: uniqueOrdered } },
    orderBy: { createdAt: "asc" }
  });
  if (rows.length === 0) return;

  const lk = lockKey(groupId);
  const token = randomUUID();
  const locked = await redis.set(lk, token, "PX", 240_000, "NX");
  if (!locked) {
    for (let i = uniqueOrdered.length - 1; i >= 0; i--) {
      await redis.lpush(key, uniqueOrdered[i]);
    }
    await redis.expire(key, 900);
    await groupReplyBurstQueue.add(
      "flush",
      { groupId },
      {
        delay: 800,
        jobId: `burst-flush-retry:${groupId}:${Date.now()}`,
        removeOnComplete: 500
      }
    );
    logger.info({ groupId }, "group_burst_flush_deferred_lock_busy");
    return;
  }

  try {
    await runBurstReplyForMessages(groupId, rows);
  } finally {
    await releaseLock(lk, token);
  }
}
