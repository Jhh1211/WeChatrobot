import { randomUUID } from "node:crypto";
import {
  EventSourceType,
  ExecutorAttemptStatus,
  type ExecutorTaskStatus,
  type Prisma
} from "@prisma/client";
import { prisma } from "../../common/config/prisma.js";
import { sha256 } from "../../common/utils/hash.js";
import { inboundEventQueue } from "../../queue/connection.js";
import { JOB_NAMES } from "../../queue/names.js";
import { markRobotReplied } from "../conversations/conversations.service.js";
import { createSendTextExecutorTask } from "../../integrations/executor/executor.provider.js";
import { mergeTraceLatencyBreakdown } from "../reply/reply-latency.js";

function roundTimestamp(iso?: string | null): string {
  if (!iso) return String(Math.floor(Date.now() / 5000) * 5000);
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(Math.floor(Date.now() / 5000) * 5000);
  const bucket = Math.floor(d.getTime() / 5000) * 5000;
  return String(bucket);
}

export function buildExecutorEventUid(parts: {
  deviceId: string;
  chatTitle: string;
  senderName: string;
  text: string;
  timestampRounded: string;
}): string {
  return sha256(`${parts.deviceId}|${parts.chatTitle}|${parts.senderName}|${parts.text}|${parts.timestampRounded}`);
}

export async function submitExecutorInboundEvent(input: {
  deviceId: string;
  robotId: string;
  source: string;
  rawPayload: Prisma.JsonObject;
  normalizedMessage: {
    chatTitle: string;
    senderName?: string | null;
    text: string;
    timestamp?: string | null;
    isFromSelf: boolean;
    messageType: string;
  };
}): Promise<{ eventId: string; eventUid: string; duplicated: boolean }> {
  const rounded = roundTimestamp(input.normalizedMessage.timestamp);
  const eventUid = buildExecutorEventUid({
    deviceId: input.deviceId,
    chatTitle: input.normalizedMessage.chatTitle,
    senderName: input.normalizedMessage.senderName ?? "",
    text: input.normalizedMessage.text,
    timestampRounded: rounded
  });

  const robot = await prisma.robot.upsert({
    where: { robotId: input.robotId },
    update: { platform: "self_hosted" },
    create: {
      robotId: input.robotId,
      name: `Robot-${input.robotId}`,
      platform: "self_hosted"
    }
  });

  const mergedPayload: Prisma.JsonObject = {
    ...input.rawPayload,
    __executor: {
      deviceId: input.deviceId,
      source: input.source,
      normalized: input.normalizedMessage
    },
    robot_id: input.robotId,
    group_name: input.normalizedMessage.chatTitle,
    sender_name: input.normalizedMessage.senderName ?? "",
    text: input.normalizedMessage.text,
    content: input.normalizedMessage.text,
    timestamp: input.normalizedMessage.timestamp ?? new Date().toISOString(),
    isFromRobot: input.normalizedMessage.isFromSelf,
    chat_type: "group",
    msg_type: input.normalizedMessage.messageType,
    messageId: eventUid
  };

  try {
    const event = await prisma.inboundEvent.create({
      data: {
        eventUid,
        robotId: robot.id,
        rawPayload: mergedPayload,
        sourceType: EventSourceType.android_accessibility,
        callbackReceivedAt: new Date(),
        status: "pending"
      }
    });

    await inboundEventQueue.add(
      JOB_NAMES.processInboundEvent,
      { eventId: event.id },
      { attempts: 3, backoff: { type: "exponential", delay: 1000 }, removeOnComplete: 1000 }
    );

    return { eventId: event.id, eventUid, duplicated: false };
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") {
      const existing = await prisma.inboundEvent.findUnique({ where: { eventUid } });
      return { eventId: existing?.id ?? "", eventUid, duplicated: true };
    }
    throw error;
  }
}

export async function pullExecutorTask(input: {
  deviceId: string;
  robotId: string;
  capability: string[];
}): Promise<{
  task: {
    id: string;
    taskUid: string;
    type: string;
    targetChatTitle: string;
    payload: unknown;
  } | null;
}> {
  const robot = await prisma.robot.findUnique({ where: { robotId: input.robotId } });
  if (!robot) {
    return { task: null };
  }
  const device = await prisma.device.findFirst({
    where: { deviceId: input.deviceId, robotId: robot.id }
  });
  if (!device) {
    return { task: null };
  }

  if (!input.capability.includes("send_text")) {
    return { task: null };
  }

  const task = await prisma.executorTask.findFirst({
    where: { robotId: robot.id, status: "pending", type: "send_text" },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }]
  });

  if (!task) {
    return { task: null };
  }

  return {
    task: {
      id: task.id,
      taskUid: task.taskUid,
      type: task.type,
      targetChatTitle: task.targetChatTitle,
      payload: task.payload
    }
  };
}

export async function ackExecutorTask(taskId: string, externalDeviceId: string): Promise<{ ok: boolean }> {
  const device = await prisma.device.findUnique({ where: { deviceId: externalDeviceId } });
  if (!device) {
    return { ok: false };
  }

  try {
    await prisma.$transaction(async (tx) => {
      const task = await tx.executorTask.findFirst({
        where: { id: taskId, status: "pending" }
      });
      if (!task) {
        throw new Error("not_pending");
      }
      await tx.executorTask.update({
        where: { id: taskId },
        data: {
          status: "claimed",
          deviceId: device.id,
          claimedAt: new Date()
        }
      });
      await tx.executorTask.update({
        where: { id: taskId, status: "claimed" },
        data: { status: "running" }
      });
      await tx.executorTaskAttempt.create({
        data: {
          taskId,
          deviceId: device.id,
          status: ExecutorAttemptStatus.running
        }
      });
    });
    const t = await prisma.executorTask.findUnique({ where: { id: taskId } });
    if (t?.outboundMessageId) {
      const ob = await prisma.outboundMessage.findUnique({ where: { id: t.outboundMessageId } });
      const traceId = (ob?.sendRequest as { replyTraceId?: string } | null)?.replyTraceId;
      if (traceId) {
        await mergeTraceLatencyBreakdown(traceId, { sendStartedAt: new Date().toISOString() });
      }
    }
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export async function reportExecutorTaskResult(input: {
  taskId: string;
  externalDeviceId: string;
  status: "success" | "failed";
  detail?: unknown;
  executedAt?: string | null;
  errorMessage?: string | null;
}): Promise<void> {
  const device = await prisma.device.findUnique({ where: { deviceId: input.externalDeviceId } });
  if (!device) {
    throw new Error("device_not_found");
  }

  const task = await prisma.executorTask.findUnique({ where: { id: input.taskId } });
  if (!task) {
    throw new Error("task_not_found");
  }

  if (task.status === "success" || task.status === "failed") {
    return;
  }

  if (task.status !== "running" || task.deviceId !== device.id) {
    throw new Error("invalid_task_transition");
  }

  const attempt = await prisma.executorTaskAttempt.findFirst({
    where: { taskId: task.id, deviceId: device.id, status: ExecutorAttemptStatus.running },
    orderBy: { startedAt: "desc" }
  });

  const taskStatus = input.status === "success" ? "success" : "failed";
  const attemptStatus =
    input.status === "success" ? ExecutorAttemptStatus.success : ExecutorAttemptStatus.failed;

  const sentAt =
    input.status === "success"
      ? new Date(input.executedAt ?? Date.now())
      : null;

  let applied = false;
  await prisma.$transaction(async (tx) => {
    const fresh = await tx.executorTask.findFirst({ where: { id: task.id, deviceId: device.id } });
    if (!fresh || fresh.status === "success" || fresh.status === "failed") {
      return;
    }
    if (fresh.status !== "running" || fresh.deviceId !== device.id) {
      throw new Error("invalid_task_transition");
    }

    await tx.executorTask.update({
      where: { id: task.id },
      data: {
        status: taskStatus,
        finishedAt: new Date(),
        errorMessage: input.errorMessage ?? undefined
      }
    });
    applied = true;

    if (attempt) {
      await tx.executorTaskAttempt.update({
        where: { id: attempt.id },
        data: {
          status: attemptStatus,
          finishedAt: new Date(),
          responsePayload: (input.detail ?? {}) as Prisma.InputJsonValue,
          errorMessage: input.errorMessage ?? undefined
        }
      });
    }

    if (task.outboundMessageId) {
      await tx.outboundMessage.update({
        where: { id: task.outboundMessageId },
        data: {
          sendStatus: input.status === "success" ? "success" : "failed",
          sendResponse: (input.detail ?? {}) as Prisma.InputJsonValue,
          sentAt
        }
      });
    }
  });

  if (applied && input.status === "success" && task.outboundMessageId) {
    const outbound = await prisma.outboundMessage.findUnique({ where: { id: task.outboundMessageId } });
    if (outbound?.groupId) {
      await markRobotReplied(outbound.groupId);
    }
  }

  if (applied && task.outboundMessageId) {
    const req = task.outboundMessageId
      ? ((await prisma.outboundMessage.findUnique({ where: { id: task.outboundMessageId } }))?.sendRequest as
          | { replyTraceId?: string }
          | null
          | undefined)
      : null;
    const traceId = req?.replyTraceId;
    if (traceId) {
      await prisma.replyTrace.updateMany({
        where: { id: traceId },
        data: {
          androidResult: {
            status: input.status,
            detail: input.detail ?? null,
            errorMessage: input.errorMessage ?? null
          } as object,
          executorTaskId: task.id
        }
      });
      const nowIso = new Date().toISOString();
      await mergeTraceLatencyBreakdown(traceId, {
        sendFinishedAt: nowIso,
        sendVerifiedAt: nowIso
      });
    }
  }
}

export async function cancelExecutorTaskAdmin(taskId: string) {
  const task = await prisma.executorTask.findUnique({ where: { id: taskId } });
  if (!task) return null;
  if (!["pending", "claimed", "running"].includes(task.status)) {
    return task;
  }

  await prisma.executorTask.update({
    where: { id: taskId },
    data: { status: "cancelled", finishedAt: new Date(), errorMessage: "cancelled_by_admin" }
  });

  if (task.outboundMessageId) {
    await prisma.outboundMessage.update({
      where: { id: task.outboundMessageId },
      data: {
        sendStatus: "cancelled",
        sendResponse: { reason: "executor_cancelled" } as Prisma.InputJsonValue
      }
    });
  }

  return task;
}

export async function adminCreateTestSendTask(input: {
  robotId: string;
  targetChatTitle: string;
  text: string;
}) {
  const robot = await prisma.robot.findUnique({ where: { robotId: input.robotId } });
  if (!robot) {
    throw new Error("robot_not_found");
  }
  return createSendTextExecutorTask({
    robotInternalId: robot.id,
    targetChatTitle: input.targetChatTitle,
    payload: {
      text: input.text,
      socketType: 2,
      verifyMode: "last_message_match"
    }
  });
}

export async function listExecutorTasksForAdmin(params: {
  page: number;
  pageSize: number;
  status?: string;
}) {
  const where = params.status ? { status: params.status as ExecutorTaskStatus } : {};
  const [items, total] = await Promise.all([
    prisma.executorTask.findMany({
      where,
      include: { robot: true, device: true, outboundMessage: true },
      orderBy: { createdAt: "desc" },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize
    }),
    prisma.executorTask.count({ where })
  ]);
  return { items, total, page: params.page, pageSize: params.pageSize };
}
