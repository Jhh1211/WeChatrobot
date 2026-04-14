import { RiskLevel, RuleType, type Group, type InboundMessage } from "@prisma/client";
import { prisma } from "../../common/config/prisma.js";
import { env } from "../../common/config/env.js";
import { classifyIntent } from "../intent/intent.service.js";
import { secondsBetween } from "../../common/utils/time.js";

export interface ReplyDecisionOutput {
  shouldReply: boolean;
  score: number;
  reason: string;
  riskLevel: RiskLevel;
  delayMs: number | null;
  intent: string;
  matchedRules: string[];
  /** 本次决策使用的触发阈值（群策略 > 规则 > 环境默认） */
  thresholdUsed: number;
}

/** 出站队列抖动（毫秒）：仅 0～1s，自然耗时已由 burst + LLM + 执行端承担 */
function pickDelayByIntent(_intent: string): number {
  return Math.floor(Math.random() * 1001)
}

/** 问句识别：含书面疑问词，或口语结尾「…了没」「…呢」等（与 intent 关键词里的「吗」等对齐，避免「开了没」类句得 0 分） */
function isQuestionText(text: string): boolean {
  const t = text.trim();
  if (/(\?|？|吗|么|嘛|如何|怎么|请问)/i.test(t)) return true;
  if (/没\s*$/i.test(t)) return true;
  if (/呢\s*$/i.test(t)) return true;
  return false;
}

export async function evaluateReplyDecision(params: {
  message: InboundMessage;
  group: Group;
  recentMessages: InboundMessage[];
}): Promise<ReplyDecisionOutput> {
  const messageText = params.message.messageTextNormalized ?? "";
  const intent = classifyIntent(messageText);
  const gp = await prisma.groupReplyPolicy.findUnique({ where: { groupId: params.group.id } });
  const thresholdBeforeRules = gp?.scoreThreshold ?? env.DEFAULT_REPLY_THRESHOLD;
  if (gp?.humanTakeover) {
    return {
      shouldReply: false,
      score: 0,
      reason: "human_takeover",
      riskLevel: RiskLevel.low,
      delayMs: null,
      intent,
      matchedRules: ["policy_human_takeover"],
      thresholdUsed: thresholdBeforeRules
    };
  }
  if (gp && !gp.enabled) {
    return {
      shouldReply: false,
      score: 0,
      reason: "group_reply_policy_disabled",
      riskLevel: RiskLevel.low,
      delayMs: null,
      intent,
      matchedRules: ["policy_disabled"],
      thresholdUsed: thresholdBeforeRules
    };
  }
  const matchedRules: string[] = [];
  let score = 0;
  let riskLevel: RiskLevel = RiskLevel.low;

  const configs = await prisma.ruleConfig.findMany({
    where: { enabled: true, OR: [{ groupId: params.group.id }, { groupId: null }] },
    orderBy: { priority: "asc" }
  });
  const riskConfig = configs.find((c) => c.type === RuleType.risk)?.config as
    | { blockedKeywords?: string[]; blockedTopics?: string[] }
    | undefined;
  const triggerConfig = configs.find((c) => c.type === RuleType.trigger)?.config as
    | {
        threshold?: number;
        questionBonus?: number;
        intentBonus?: number;
        silenceBonus?: number;
        leadBonus?: number;
        chillBonus?: number;
        robotOvertalkPenalty?: number;
        dualChatPenalty?: number;
      }
    | undefined;

  const thresholdUsed = gp?.scoreThreshold ?? triggerConfig?.threshold ?? env.DEFAULT_REPLY_THRESHOLD;

  const riskOn = gp?.riskInterceptEnabled !== false;
  if (
    riskOn &&
    riskConfig?.blockedKeywords?.some((keyword) => messageText.includes(keyword.toLowerCase()))
  ) {
    return {
      shouldReply: false,
      score: 0,
      reason: "blocked by risk keywords",
      riskLevel: RiskLevel.blocked,
      delayMs: null,
      intent,
      matchedRules: ["risk_keywords"],
      thresholdUsed
    };
  }
  if (
    riskOn &&
    (["complaint", "emotional", "off_topic"].includes(intent) ||
      riskConfig?.blockedTopics?.includes(intent))
  ) {
    return {
      shouldReply: false,
      score: 0,
      reason: "blocked by risk intent",
      riskLevel: RiskLevel.blocked,
      delayMs: null,
      intent,
      matchedRules: ["risk_intent"],
      thresholdUsed
    };
  }

  if (isQuestionText(messageText)) {
    score += triggerConfig?.questionBonus ?? 35;
    matchedRules.push("question_bonus");
  }

  if (["faq_question", "activity_question", "recommendation_request"].includes(intent)) {
    score += triggerConfig?.intentBonus ?? 25;
    matchedRules.push("intent_bonus");
  }

  if (intent === "unknown" && isQuestionText(messageText)) {
    score += triggerConfig?.intentBonus ?? 25;
    matchedRules.push("implicit_faq_from_question_shape");
  }

  if (intent === "lead_signal") {
    score += triggerConfig?.leadBonus ?? 20;
    matchedRules.push("lead_bonus");
  }

  const latestHuman = params.recentMessages.find((m) => !m.isFromRobot && m.createdAt < params.message.createdAt);
  if (latestHuman) {
    const silenceSeconds = secondsBetween(params.message.createdAt, latestHuman.createdAt);
    if (silenceSeconds >= 120) {
      score += triggerConfig?.silenceBonus ?? 20;
      matchedRules.push("silence_120_bonus");
    }
    if (silenceSeconds >= params.group.silenceThresholdSeconds && intent === "silence_breaker_candidate") {
      score += triggerConfig?.chillBonus ?? 15;
      matchedRules.push("silence_breaker_bonus");
    }
  }

  const tenMinutesAgo = new Date(params.message.createdAt.getTime() - 10 * 60 * 1000);
  const robotMsgCount10min = params.recentMessages.filter(
    (m) => m.isFromRobot && m.createdAt >= tenMinutesAgo
  ).length;
  if (robotMsgCount10min > 2) {
    score += triggerConfig?.robotOvertalkPenalty ?? -35;
    matchedRules.push("robot_overtalk_penalty");
  }

  const last5NonRobot = params.recentMessages
    .filter((m) => !m.isFromRobot && m.senderId)
    .slice(0, 5)
    .map((m) => m.senderId);
  const uniqueUsers = new Set(last5NonRobot);
  if (uniqueUsers.size === 2 && last5NonRobot.length >= 4) {
    score += triggerConfig?.dualChatPenalty ?? -20;
    matchedRules.push("dual_chat_penalty");
  }

  const shouldReply = score >= thresholdUsed;

  return {
    shouldReply,
    score,
    reason: shouldReply ? "score reached threshold" : "score below threshold",
    riskLevel,
    delayMs: shouldReply ? pickDelayByIntent(intent) : null,
    intent,
    matchedRules,
    thresholdUsed
  };
}
