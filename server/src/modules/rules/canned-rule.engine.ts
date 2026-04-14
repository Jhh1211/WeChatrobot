import type { CannedMatchType } from "@prisma/client";
import { prisma } from "../../common/config/prisma.js";

export type CannedMatchResult = { ruleId: string; replyText: string };

function matchOne(keyword: string, matchType: CannedMatchType, text: string): boolean {
  const t = text;
  const k = keyword;
  switch (matchType) {
    case "exact":
      return t.trim() === k.trim();
    case "regex":
      try {
        return new RegExp(k, "i").test(t);
      } catch {
        return false;
      }
    case "contains":
    default:
      return t.toLowerCase().includes(k.trim().toLowerCase());
  }
}

/** priority 数值越小越优先 */
export async function matchCannedReplyRule(groupId: string, messageText: string): Promise<CannedMatchResult | null> {
  const rules = await prisma.cannedReplyRule.findMany({
    where: {
      enabled: true,
      OR: [{ scopeType: "global" }, { scopeType: "group", groupId }]
    },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }]
  });
  for (const r of rules) {
    if (r.scopeType === "group" && r.groupId !== groupId) continue;
    if (matchOne(r.keyword, r.matchType, messageText)) {
      return { ruleId: r.id, replyText: r.replyText };
    }
  }
  return null;
}
