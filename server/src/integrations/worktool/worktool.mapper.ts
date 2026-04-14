import type { WorkToolMessageCallbackPayload, WorkToolStandardMessage } from "./worktool.types.js";

function asString(input: unknown): string | undefined {
  return typeof input === "string" && input.length > 0 ? input : undefined;
}

function toIso(input: unknown): string | undefined {
  if (typeof input === "number") return new Date(input).toISOString();
  if (typeof input === "string") {
    const parsed = Date.parse(input);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return undefined;
}

// TODO: add robust mapper for multi-tenant and multi-version callback payloads.
export function mapCallbackPayloadToStandardMessage(
  payload: WorkToolMessageCallbackPayload,
  defaultRobotId: string
): WorkToolStandardMessage {
  const robotId = asString(payload.robotId) ?? asString(payload.robot_id) ?? defaultRobotId;
  const chatTypeRaw = asString(payload.chatType) ?? asString(payload.chat_type) ?? "group";
  const messageTypeRaw = asString(payload.messageType) ?? asString(payload.msg_type) ?? "unknown";
  const content = asString(payload.content) ?? asString(payload.text) ?? "";

  const chatType = ["group", "private", "system"].includes(chatTypeRaw)
    ? (chatTypeRaw as WorkToolStandardMessage["chatType"])
    : "group";
  const messageType = ["text", "image", "audio", "file", "system"].includes(messageTypeRaw)
    ? (messageTypeRaw as WorkToolStandardMessage["messageType"])
    : "unknown";

  return {
    externalMessageId: asString(payload.messageId) ?? asString(payload.msg_id),
    robotId,
    groupExternalId: asString(payload.groupId) ?? asString(payload.group_id),
    groupTitle: asString(payload.groupName) ?? asString(payload.group_name),
    senderExternalId: asString(payload.senderId) ?? asString(payload.sender_id),
    senderName: asString(payload.senderName) ?? asString(payload.sender_name),
    chatType,
    messageType,
    text: content,
    replyToMessageId: asString(payload.replyToMessageId) ?? asString(payload.reply_to_msg_id),
    sentAt: toIso(payload.sentAt ?? payload.sent_at ?? payload.timestamp),
    isFromRobot: Boolean(payload.isFromRobot ?? payload.selfSend ?? payload.self_send ?? false)
  };
}
