import { prisma } from "../../common/config/prisma.js";
import type { InboundMessage } from "@prisma/client";
import { classifyInboundSemantic, type SemanticMessageKind } from "./inbound-semantic.classifier.js";
import { ReplyLatencyTracker } from "../reply/reply-latency.js";

export async function createFilterSkipReplyTrace(
  message: InboundMessage,
  kind: SemanticMessageKind
): Promise<void> {
  const sc = classifyInboundSemantic({
    text: message.messageText ?? "",
    isFromRobot: message.isFromRobot,
    senderName: message.senderName,
    inGroup: Boolean(message.groupId)
  });
  const latency = new ReplyLatencyTracker();
  if (message.inboundCapturedAt) {
    latency.markInboundCaptured(message.inboundCapturedAt);
  } else {
    latency.markInboundCaptured(message.createdAt);
  }
  latency.markInboundPersisted(message.createdAt);

  await prisma.replyTrace.create({
    data: {
      inboundMessageId: message.id,
      groupId: message.groupId,
      status: "skipped_filter",
      normalizedText: message.messageTextNormalized ?? "",
      semanticMessageType: kind,
      skipAutoReplyReason: sc.skipAutoReplyReason ?? "已过滤",
      enteredAiPipeline: false,
      latencyBreakdown: latency.toJSON() as object
    }
  });
}

/** 官方人员昵称命中：不排队 burst、不自动回复 */
export async function createOfficialStaffSkipReplyTrace(
  message: InboundMessage,
  matchedMarker: string
): Promise<void> {
  const latency = new ReplyLatencyTracker();
  if (message.inboundCapturedAt) {
    latency.markInboundCaptured(message.inboundCapturedAt);
  } else {
    latency.markInboundCaptured(message.createdAt);
  }
  latency.markInboundPersisted(message.createdAt);

  await prisma.replyTrace.create({
    data: {
      inboundMessageId: message.id,
      groupId: message.groupId,
      status: "skipped_filter",
      normalizedText: message.messageTextNormalized ?? "",
      semanticMessageType: message.semanticKind ?? "user_text",
      skipAutoReplyReason: `官方人员不自动回复（发言人昵称含「${matchedMarker}」）`,
      enteredAiPipeline: false,
      latencyBreakdown: latency.toJSON() as object
    }
  });
}
