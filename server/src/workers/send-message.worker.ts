import { Worker } from "bullmq";
import { Prisma, SendStatus } from "@prisma/client";
import { prisma } from "../common/config/prisma.js";
import { redis } from "../common/config/redis.js";
import { QUEUE_NAMES } from "../queue/names.js";
import { createSendTextExecutorTask } from "../integrations/executor/executor.provider.js";
import { deriveMentionFields } from "../integrations/executor/mention-fields.js";
import { env } from "../common/config/env.js";
import { writeAuditLog } from "../modules/audit/audit.service.js";
import { mergeTraceLatencyBreakdown } from "../modules/reply/reply-latency.js";
import { logger } from "../common/logger/pino.js";

let worker: Worker | null = null;

function traceIdFromOutbound(
  outbound: { sendRequest: unknown },
  replyTraceId?: string | null
): string | undefined {
  const fromReq = (outbound.sendRequest as { replyTraceId?: string } | null)?.replyTraceId;
  return replyTraceId ?? fromReq ?? undefined;
}

/** 供队列 Worker 与集成测试复用：仅创建 executor_task 并标记 outbound 为 pending_executor。 */
export async function processSendOutboundJob(
  outboundMessageId: string,
  replyTraceId?: string | null
): Promise<void> {
  const outbound = await prisma.outboundMessage.findUnique({ where: { id: outboundMessageId } });
  if (!outbound) return;
  const robot = await prisma.robot.findUnique({ where: { id: outbound.robotId } });
  if (!robot) {
    const tid = traceIdFromOutbound(outbound, replyTraceId);
    if (tid) {
      await mergeTraceLatencyBreakdown(tid, {
        sendWorkerPrecheckBlockedAt: new Date().toISOString(),
        sendWorkerPrecheckReason: "robot_not_found"
      });
    }
    await prisma.outboundMessage.update({
      where: { id: outbound.id },
      data: { sendStatus: SendStatus.failed, sendResponse: { reason: "robot_not_found" } }
    });
    return;
  }

  const pre = await checkSendOutboundPrecheck(outbound.id);
  if (!pre.ok) {
    const tid = traceIdFromOutbound(outbound, replyTraceId);
    if (tid) {
      await mergeTraceLatencyBreakdown(tid, {
        sendWorkerPrecheckBlockedAt: new Date().toISOString(),
        sendWorkerPrecheckReason: pre.reason
      });
    }
    logger.warn(
      { outboundId: outbound.id, reason: pre.reason },
      "outbound_send_precheck_blocked"
    );
    await prisma.outboundMessage.update({
      where: { id: outbound.id },
      data: {
        sendStatus: SendStatus.cancelled,
        sendResponse: { reason: "precheck_blocked", detail: pre.reason }
      }
    });
    return;
  }

  const relatedInbound = outbound.relatedInboundMessageId
    ? await prisma.inboundMessage.findUnique({ where: { id: outbound.relatedInboundMessageId } })
    : null;
  const mention =
    env.EXECUTOR_MENTION_UI_ENABLED && relatedInbound?.senderName
      ? deriveMentionFields(relatedInbound.senderName)
      : null;

  const task = await createSendTextExecutorTask({
    robotInternalId: robot.id,
    targetChatTitle: outbound.targetTitle,
    payload: {
      text: outbound.content,
      socketType: 2,
      verifyMode: "last_message_match",
      ...(mention && {
        mentionUi: true,
        mentionSearchQuery: mention.mentionSearchQuery,
        mentionMatchLabel: mention.mentionMatchLabel
      })
    },
    relatedInboundMessageId: outbound.relatedInboundMessageId,
    outboundMessageId: outbound.id
  });

  const prevReq = (outbound.sendRequest as Record<string, unknown> | null) ?? {};
  const mergedRequest = {
    ...prevReq,
    executorTaskId: task.id,
    taskUid: task.taskUid,
    targetChatTitle: outbound.targetTitle,
    payload: task.payload as object,
    replyTraceId: replyTraceId ?? prevReq.replyTraceId
  };

  await prisma.outboundMessage.update({
    where: { id: outbound.id },
    data: {
      sendStatus: SendStatus.pending_executor,
      sendRequest: mergedRequest as Prisma.InputJsonValue
    }
  });

  const tid = (mergedRequest.replyTraceId as string | undefined) ?? replyTraceId ?? undefined;
  if (tid) {
    await mergeTraceLatencyBreakdown(tid, {
      executorTaskCreatedAt: new Date().toISOString()
    });
  }

  await writeAuditLog({
    entityType: "outbound_message",
    entityId: outbound.id,
    action: "executor_task_created",
    detail: { taskId: task.id, taskUid: task.taskUid }
  });
}

/** 返回拦截原因供写入 ReplyTrace，区分「未建任务」与「队列延迟 / Worker 未启动」 */
export async function checkSendOutboundPrecheck(
  outboundMessageId: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const outbound = await prisma.outboundMessage.findUnique({ where: { id: outboundMessageId } });
  if (!outbound || outbound.sendStatus !== SendStatus.pending || !outbound.groupId) {
    return { ok: false, reason: "not_pending_or_no_group" };
  }

  const group = await prisma.group.findUnique({ where: { id: outbound.groupId } });
  if (!group || !group.enabled || !group.autoReplyEnabled) {
    return { ok: false, reason: "group_disabled_or_auto_reply_off" };
  }

  // 带触发入站消息的回复已在决策阶段控节奏；不在 worker 再卡 cooldown，避免同群连续测试/合规则回复被误杀。
  // 产品：触发后即使群内又有新人话也照常发送（不再做 newer_human_message_after_trigger 预检）。
  if (!outbound.relatedInboundMessageId) {
    const latestRobotOutbound = await prisma.outboundMessage.findFirst({
      where: { groupId: group.id, sendStatus: SendStatus.success },
      orderBy: { sentAt: "desc" }
    });
    if (latestRobotOutbound?.sentAt) {
      const elapsed = Date.now() - latestRobotOutbound.sentAt.getTime();
      if (elapsed < group.cooldownSeconds * 1000) {
        return { ok: false, reason: "cooldown_after_last_robot_send" };
      }
    }

    const sixtySecondsAgo = new Date(Date.now() - 60_000);
    const humanRecentReplyCount = await prisma.inboundMessage.count({
      where: {
        groupId: group.id,
        isFromRobot: false,
        createdAt: { gte: sixtySecondsAgo }
      }
    });
    if (humanRecentReplyCount > 0) {
      return { ok: false, reason: "human_message_recent_no_trigger_inbound" };
    }
  }

  const oneHourAgo = new Date(Date.now() - 3_600_000);
  const robotMsgCount = await prisma.outboundMessage.count({
    where: {
      groupId: group.id,
      sendStatus: SendStatus.success,
      createdAt: { gte: oneHourAgo }
    }
  });
  if (robotMsgCount >= group.maxRobotMessagesPerHour) {
    return { ok: false, reason: "hourly_robot_message_cap" };
  }
  return { ok: true };
}

export function startSendMessageWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(
    QUEUE_NAMES.outboundSend,
    async (job) => {
      await processSendOutboundJob(job.data.outboundMessageId, job.data.replyTraceId ?? null);
    },
    { connection: redis, concurrency: 5 }
  );
  worker.on("failed", (job, err) => {
    logger.error(
      { jobId: job?.id, outboundMessageId: job?.data?.outboundMessageId, err },
      "outbound_send_queue_job_failed"
    );
  });
  worker.on("completed", (job) => {
    logger.debug({ jobId: job.id, outboundMessageId: job.data?.outboundMessageId }, "outbound_send_queue_job_done");
  });
  return worker;
}
