export function normalizeText(input: string | null | undefined): string {
  if (!input) return "";
  return input.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * 去掉文首企微/微信式 @提及（可多个），用于与出站正文比对时消除「@机器人昵称 + 复制助手话」的假用户消息。
 */
export function stripLeadingAtMentionsForEcho(input: string): string {
  let s = input.trim();
  let prev = "";
  while (s !== prev) {
    prev = s;
    s = s.replace(/^[@＠][^\s@＠]{1,64}\s*/u, "").trim();
  }
  return s;
}

/** 回声比对用：去 @ 后再规范化一次（入参可为已 normalizeText 的串） */
export function normalizeTextForEchoCompare(fragment: string): string {
  return normalizeText(stripLeadingAtMentionsForEcho(fragment));
}

/**
 * 双字符 Dice 系数（适合中文相邻字），用于两段话高度相似但个别数字/标点不同的情况。
 */
export function bigramDiceCoefficient(a: string, b: string): number {
  if (!a.length || !b.length) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const counts = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const k = a.slice(i, i + 2);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let inter = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const k = b.slice(i, i + 2);
    const c = counts.get(k) ?? 0;
    if (c > 0) {
      inter++;
      counts.set(k, c - 1);
    }
  }
  const denom = a.length - 1 + (b.length - 1);
  return denom > 0 ? (2 * inter) / denom : 0;
}

export function truncateByLength(input: string, maxLength: number): string {
  if (input.length <= maxLength) return input;
  return `${input.slice(0, Math.max(0, maxLength - 1))}…`;
}
