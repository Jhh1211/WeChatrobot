export interface ExecutorSendTextPayload {
  text: string;
  socketType?: number;
  verifyMode?: "last_message_match";
  /** 为 true 时 Android 端尝试：输入 @ → 搜索 → 点选成员后再追加正文 */
  mentionUi?: boolean;
  /** 「选择提醒的人」搜索框输入 */
  mentionSearchQuery?: string;
  /** 列表项展示文案需包含此串（用于点选行），一般为完整 senderName */
  mentionMatchLabel?: string;
}

export type ExecutorProviderKind = "self_hosted_android" | "deprecated_worktool";

export interface CreateSendExecutorTaskInput {
  robotInternalId: string;
  targetChatTitle: string;
  payload: ExecutorSendTextPayload;
  relatedInboundMessageId?: string | null;
  outboundMessageId?: string | null;
  priority?: number;
}
