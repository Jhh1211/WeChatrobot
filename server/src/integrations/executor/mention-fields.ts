/**
 * 从入站 senderName 推导企微「选择提醒的人」弹窗里用于搜索、用于点击行校验的字符串。
 * 例：购房通-鱼丸@购房通 → search=鱼丸, match=购房通-鱼丸@购房通
 */
export function deriveMentionFields(senderName: string | null | undefined): {
  mentionSearchQuery: string;
  mentionMatchLabel: string;
} | null {
  const raw = senderName?.trim();
  if (!raw) return null;

  const atIdx = raw.indexOf("@");
  const core = atIdx >= 0 ? raw.slice(0, atIdx).trim() : raw;
  let mentionSearchQuery = raw;
  const dashIdx = core.lastIndexOf("-");
  if (dashIdx >= 0 && dashIdx < core.length - 1) {
    const tail = core.slice(dashIdx + 1).trim();
    if (tail.length >= 1 && tail.length <= 24) {
      mentionSearchQuery = tail;
    }
  }

  return {
    mentionSearchQuery,
    mentionMatchLabel: raw
  };
}
