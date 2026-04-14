import type { ExecutorTask } from "@prisma/client";
import { prisma } from "../../common/config/prisma.js";
import { randomUUID } from "node:crypto";
import type { CreateSendExecutorTaskInput } from "./executor.types.js";

/**
 * 抽象执行器：当前主链路为自建 Android；WorkTool 仅作 deprecated provider，不得作为主链路。
 */
export async function createSendTextExecutorTask(input: CreateSendExecutorTaskInput): Promise<ExecutorTask> {
  const taskUid = randomUUID();
  return prisma.executorTask.create({
    data: {
      taskUid,
      robotId: input.robotInternalId,
      type: "send_text",
      status: "pending",
      priority: input.priority ?? 0,
      targetChatTitle: input.targetChatTitle,
      payload: input.payload as object,
      relatedInboundMessageId: input.relatedInboundMessageId ?? undefined,
      outboundMessageId: input.outboundMessageId ?? undefined
    }
  });
}
