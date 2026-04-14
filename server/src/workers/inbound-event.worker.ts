import { Worker } from "bullmq";
import type { InboundMessage } from "@prisma/client";
import { prisma } from "../common/config/prisma.js";
import { redis } from "../common/config/redis.js";
import { QUEUE_NAMES } from "../queue/names.js";
import { persistInboundMessage } from "../modules/messages/messages.service.js";
import { updateConversationStateFromInbound } from "../modules/conversations/conversations.service.js";
import { writeAuditLog } from "../modules/audit/audit.service.js";
import { logger } from "../common/logger/pino.js";
import { getEffectiveGroupPolicy } from "../modules/groups/group-reply-policy.service.js";
import { createFilterSkipReplyTrace, createOfficialStaffSkipReplyTrace } from "../modules/messages/inbound-skip-trace.service.js";
import { officialStaffMatchedMarker } from "../modules/messages/official-sender-blocklist.js";
import { appendAndScheduleGroupBurst } from "../modules/reply/group-reply-burst.service.js";
import {
  classifyInboundSemantic,
  type SemanticMessageKind
} from "../modules/messages/inbound-semantic.classifier.js";

let worker: Worker | null = null;

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

export function startInboundEventWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(
    QUEUE_NAMES.inboundEvent,
    async (job) => {
      const event = await prisma.inboundEvent.findUnique({ where: { id: job.data.eventId } });
      if (!event) return;

      try {
        const inboundMessage = await persistInboundMessage({
          eventId: event.id,
          rawPayload: event.rawPayload as Record<string, unknown>
        });

        await updateConversationStateFromInbound(inboundMessage);

        if (inboundMessage.chatType !== "group" || !inboundMessage.groupId) {
          await prisma.inboundEvent.update({
            where: { id: event.id },
            data: { status: "processed", processedAt: new Date() }
          });
          return;
        }

        const group = await prisma.group.findUnique({ where: { id: inboundMessage.groupId } });
        if (!group || !group.enabled) {
          await prisma.inboundEvent.update({
            where: { id: event.id },
            data: { status: "processed", processedAt: new Date() }
          });
          return;
        }
        const gpol = await getEffectiveGroupPolicy(group.id, group);
        if (!gpol.autoReplyEnabled || gpol.humanTakeover || !gpol.policyRowEnabled) {
          await prisma.inboundEvent.update({
            where: { id: event.id },
            data: { status: "processed", processedAt: new Date() }
          });
          return;
        }

        const kind = effectiveSemanticKind(inboundMessage);
        if (kind !== "user_text") {
          await createFilterSkipReplyTrace(inboundMessage, kind);
          await writeAuditLog({
            entityType: "inbound_message",
            entityId: inboundMessage.id,
            action: "inbound_filtered",
            detail: { semanticKind: kind }
          });
          await prisma.inboundEvent.update({
            where: { id: event.id },
            data: { status: "processed", processedAt: new Date() }
          });
          return;
        }

        const officialMarker = officialStaffMatchedMarker(inboundMessage.senderName);
        if (officialMarker) {
          await createOfficialStaffSkipReplyTrace(inboundMessage, officialMarker);
          await writeAuditLog({
            entityType: "inbound_message",
            entityId: inboundMessage.id,
            action: "inbound_filtered",
            detail: { reason: "official_staff_sender", matchedMarker: officialMarker, senderName: inboundMessage.senderName }
          });
          await prisma.inboundEvent.update({
            where: { id: event.id },
            data: { status: "processed", processedAt: new Date() }
          });
          return;
        }

        await appendAndScheduleGroupBurst(inboundMessage.groupId, inboundMessage.id);

        await prisma.inboundEvent.update({
          where: { id: event.id },
          data: { status: "processed", processedAt: new Date() }
        });
      } catch (error) {
        logger.error({ error, eventId: event.id }, "inbound event worker failed");
        await prisma.inboundEvent.update({
          where: { id: event.id },
          data: {
            status: "failed",
            errorMessage: String(error),
            processedAt: new Date()
          }
        });
        throw error;
      }
    },
    { connection: redis, concurrency: 10 }
  );
  return worker;
}
