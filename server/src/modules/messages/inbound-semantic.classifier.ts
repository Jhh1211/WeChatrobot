export type SemanticMessageKind = "user_text" | "self_text" | "system_notice" | "unknown";

export type SemanticClassifyResult = {
  kind: SemanticMessageKind;
  /** 非 user_text 时说明为何不进入自动回复 */
  skipAutoReplyReason: string | null;
};

/** 系统通知关键词（命中则 system_notice） */
const SYSTEM_NOTICE_SUBSTRINGS: Array<{ needle: string; label: string }> = [
  { needle: "修改群名", label: "修改群名" },
  { needle: "邀请加入群", label: "邀请加入群" },
  { needle: "加入了群聊", label: "成员入群" },
  { needle: "分享聊天记录", label: "分享聊天记录" },
  { needle: "此群为外部群", label: "外部群提示" },
  { needle: "了解更多", label: "了解更多" }
];

function matchSystemNotice(text: string): string | null {
  const t = text.trim();
  for (const { needle, label } of SYSTEM_NOTICE_SUBSTRINGS) {
    if (t.includes(needle)) return label;
  }
  return null;
}

/** 正文含「撤回」即视为系统占位/提示类，不自动回复（产品约定：日常聊天几乎不会出现该二字）。 */
function textContainsRecallKeyword(text: string): boolean {
  return text.includes("撤回");
}

/**
 * 入站消息语义分类（自动回复链路前）
 * - user_text：他人普通文本，可进入后续策略
 * - self_text：己方发送
 * - system_notice：群系统提示类文案
 */
export function classifyInboundSemantic(params: {
  text: string;
  isFromRobot: boolean;
  /** 群聊且无发言人昵称时，无障碍常无法解析己方气泡，按己方处理、不自动回复 */
  senderName?: string | null;
  inGroup?: boolean;
}): SemanticClassifyResult {
  if (params.isFromRobot) {
    return { kind: "self_text", skipAutoReplyReason: "自己发出去的消息" };
  }
  if (params.inGroup && !(params.senderName ?? "").trim()) {
    return {
      kind: "self_text",
      skipAutoReplyReason: "发言人名为空（读不到昵称），按己方消息处理，不自动回复"
    };
  }
  const t = (params.text ?? "").trim();
  if (!t) {
    return { kind: "unknown", skipAutoReplyReason: "空消息" };
  }
  if (textContainsRecallKeyword(t)) {
    return {
      kind: "system_notice",
      skipAutoReplyReason: "系统消息：正文含「撤回」"
    };
  }
  const sys = matchSystemNotice(t);
  if (sys) {
    return { kind: "system_notice", skipAutoReplyReason: `系统消息：${sys}` };
  }
  return { kind: "user_text", skipAutoReplyReason: null };
}
