/**
 * 官方运营账号昵称特征：命中则整条入站不进入自动回复（burst/决策/LLM）。
 * 匹配规则：发言人昵称**包含**下列任一子串即视为官方人员（如「成都购房通-苹果@购房通」）。
 */
export const OFFICIAL_STAFF_SENDER_MARKERS = [
  "成都购房通",
  "上海购房通",
  "西安购房通",
  "杭州购房通"
] as const;

export function officialStaffMatchedMarker(senderName: string | null | undefined): string | null {
  if (senderName == null || senderName.trim() === "") return null;
  const n = senderName.trim();
  for (const m of OFFICIAL_STAFF_SENDER_MARKERS) {
    if (n.includes(m)) return m;
  }
  return null;
}

export function isOfficialStaffSenderName(senderName: string | null | undefined): boolean {
  return officialStaffMatchedMarker(senderName) != null;
}
