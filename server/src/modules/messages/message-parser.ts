import { ChatType, MessageType } from "@prisma/client";
import { normalizeText } from "../../common/utils/text.js";
import { mapCallbackPayloadToStandardMessage } from "../../integrations/worktool/worktool.mapper.js";
import type { WorkToolMessageCallbackPayload } from "../../integrations/worktool/worktool.types.js";

export interface ParsedInboundMessage {
  robotExternalId: string;
  groupExternalId?: string;
  groupTitle?: string;
  senderExternalId?: string;
  senderName?: string;
  chatType: ChatType;
  messageType: MessageType;
  messageText?: string;
  messageTextNormalized?: string;
  externalMessageId?: string;
  replyToMessageId?: string;
  sentAt?: Date;
  isFromRobot: boolean;
}

export function parseInboundMessage(
  payload: WorkToolMessageCallbackPayload,
  fallbackRobotId: string
): ParsedInboundMessage {
  const mapped = mapCallbackPayloadToStandardMessage(payload, fallbackRobotId);
  const text = mapped.text ?? "";
  return {
    robotExternalId: mapped.robotId,
    groupExternalId: mapped.groupExternalId,
    groupTitle: mapped.groupTitle,
    senderExternalId: mapped.senderExternalId,
    senderName: mapped.senderName,
    chatType: mapped.chatType as ChatType,
    messageType: mapped.messageType as MessageType,
    messageText: text,
    messageTextNormalized: normalizeText(text),
    externalMessageId: mapped.externalMessageId,
    replyToMessageId: mapped.replyToMessageId,
    sentAt: mapped.sentAt ? new Date(mapped.sentAt) : undefined,
    isFromRobot: mapped.isFromRobot
  };
}
