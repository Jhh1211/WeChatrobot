import { EventSourceType, Prisma } from "@prisma/client";
import { prisma } from "../../common/config/prisma.js";
import { env } from "../../common/config/env.js";
import { sha256 } from "../../common/utils/hash.js";
import type { WorkToolMessageCallbackPayload } from "../../integrations/worktool/worktool.types.js";
import { inboundEventQueue } from "../../queue/connection.js";
import { JOB_NAMES } from "../../queue/names.js";

function pickUniqueMessageId(payload: WorkToolMessageCallbackPayload): string | undefined {
  const raw = payload.messageId ?? payload.msg_id ?? payload.event_id;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function toEventUid(payload: WorkToolMessageCallbackPayload): string {
  const uniqueMessageId = pickUniqueMessageId(payload);
  if (uniqueMessageId) return uniqueMessageId;
  const robotId = String(payload.robotId ?? payload.robot_id ?? env.DEFAULT_ROBOT_ID);
  const sender = String(payload.senderId ?? payload.sender_id ?? "unknown_sender");
  const content = String(payload.content ?? payload.text ?? "");
  const ts = String(payload.sentAt ?? payload.timestamp ?? Date.now());
  return sha256(`${robotId}|${sender}|${content}|${ts}`);
}

export async function acceptWebhookEvent(
  payload: WorkToolMessageCallbackPayload,
  sourceType: EventSourceType = EventSourceType.callback
): Promise<{ eventId: string; eventUid: string; duplicated: boolean }> {
  const eventUid = toEventUid(payload);
  // TODO: split tenant dimension once multi-enterprise support is enabled.
  const robotExternalId = String(payload.robotId ?? payload.robot_id ?? env.DEFAULT_ROBOT_ID);
  const robot = await prisma.robot.upsert({
    where: { robotId: robotExternalId },
    update: {},
    create: {
      robotId: robotExternalId,
      name: `Robot-${robotExternalId}`
    }
  });

  try {
    const event = await prisma.inboundEvent.create({
      data: {
        eventUid,
        robotId: robot.id,
        rawPayload: payload as Prisma.JsonObject,
        sourceType,
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

export const webhookHelper = {
  toEventUid
};
