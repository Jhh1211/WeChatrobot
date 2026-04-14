import { prisma } from "../../common/config/prisma.js";
import { env } from "../../common/config/env.js";
import { parseInboundMessage } from "./message-parser.js";
import { classifyInboundSemantic } from "./inbound-semantic.classifier.js";
import { findOutboundEchoMatch } from "./inbound-echo-suppress.service.js";
import { findRecentInboundDuplicate } from "./inbound-short-dedupe.service.js";
import type { WorkToolMessageCallbackPayload } from "../../integrations/worktool/worktool.types.js";

function extractInboundCapturedAt(raw: Record<string, unknown>): Date | undefined {
  const ex = raw.__executor as { normalized?: { timestamp?: string | null } } | undefined;
  const t =
    ex?.normalized?.timestamp ??
    (typeof raw.timestamp === "string" ? raw.timestamp : undefined) ??
    (typeof raw.sent_at === "string" ? raw.sent_at : undefined);
  if (typeof t === "string" && t.length > 0) {
    const d = new Date(t);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return undefined;
}

export async function persistInboundMessage(params: {
  eventId: string;
  rawPayload: WorkToolMessageCallbackPayload;
}) {
  const existing = await prisma.inboundMessage.findFirst({ where: { eventId: params.eventId } });
  if (existing) {
    return existing;
  }

  const parsed = parseInboundMessage(params.rawPayload, env.DEFAULT_ROBOT_ID);
  const inboundCapturedAt = extractInboundCapturedAt(params.rawPayload);

  const robot = await prisma.robot.upsert({
    where: { robotId: parsed.robotExternalId },
    update: {},
    create: {
      robotId: parsed.robotExternalId,
      name: `Robot-${parsed.robotExternalId}`
    }
  });

  const group =
    parsed.groupExternalId || parsed.groupTitle
      ? await prisma.group.upsert({
          where: { id: parsed.groupExternalId ?? `title:${parsed.groupTitle}` },
          update: { title: parsed.groupTitle ?? "unknown-group" },
          create: {
            id: parsed.groupExternalId ?? `title:${parsed.groupTitle}`,
            externalGroupId: parsed.groupExternalId,
            title: parsed.groupTitle ?? "unknown-group",
            cooldownSeconds: env.DEFAULT_GROUP_COOLDOWN_SECONDS,
            silenceThresholdSeconds: env.DEFAULT_SILENCE_THRESHOLD_SECONDS,
            maxRobotMessagesPerHour: env.DEFAULT_MAX_ROBOT_MESSAGES_PER_HOUR
          }
        })
      : null;

  let effectiveIsFromRobot = parsed.isFromRobot;
  if (!effectiveIsFromRobot && group?.id) {
    const echo = await findOutboundEchoMatch({
      robotId: robot.id,
      groupId: group.id,
      normalizedInboundText: parsed.messageTextNormalized ?? "",
      senderName: parsed.senderName
    });
    if (echo.matched) {
      effectiveIsFromRobot = true;
    }
  }
  if (!effectiveIsFromRobot && group?.id) {
    const dup = await findRecentInboundDuplicate({
      groupId: group.id,
      robotId: robot.id,
      normalizedText: parsed.messageTextNormalized ?? ""
    });
    if (dup.duplicate) {
      effectiveIsFromRobot = true;
    }
  }

  const semantic = classifyInboundSemantic({
    text: parsed.messageText ?? "",
    isFromRobot: effectiveIsFromRobot,
    senderName: parsed.senderName,
    inGroup: Boolean(group?.id)
  });

  return prisma.inboundMessage.create({
    data: {
      eventId: params.eventId,
      robotId: robot.id,
      groupId: group?.id,
      senderId: parsed.senderExternalId,
      senderName: parsed.senderName,
      chatType: parsed.chatType,
      messageType: parsed.messageType,
      semanticKind: semantic.kind,
      inboundCapturedAt: inboundCapturedAt ?? undefined,
      messageText: parsed.messageText,
      messageTextNormalized: parsed.messageTextNormalized,
      externalMessageId: parsed.externalMessageId,
      replyToMessageId: parsed.replyToMessageId,
      sentAt: parsed.sentAt,
      isFromRobot: effectiveIsFromRobot
    }
  });
}
