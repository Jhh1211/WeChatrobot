export interface WorkToolMessageCallbackPayload {
  [key: string]: unknown;
}

export interface WorkToolStandardMessage {
  externalMessageId?: string;
  robotId: string;
  groupExternalId?: string;
  groupTitle?: string;
  senderExternalId?: string;
  senderName?: string;
  chatType: "group" | "private" | "system";
  messageType: "text" | "image" | "audio" | "file" | "system" | "unknown";
  text?: string;
  replyToMessageId?: string;
  sentAt?: string;
  isFromRobot: boolean;
}

export interface WorkToolSendMessageRequest {
  robotId: string;
  targetTitle: string;
  receivedContent: string;
  socketType?: number;
  list?: Array<{ type: number; content?: string }>;
  targetId?: string;
}

export interface WorkToolApiResponse<T = unknown> {
  code?: number;
  msg?: string;
  message?: string;
  data?: T;
  [key: string]: unknown;
}
