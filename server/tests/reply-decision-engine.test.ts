import { beforeEach, describe, expect, test, vi } from "vitest";
import { RiskLevel } from "@prisma/client";

const findManyMock = vi.fn();

const groupPolicyFindUniqueMock = vi.fn().mockResolvedValue(null);

vi.mock("../src/common/config/prisma.js", () => ({
  prisma: {
    ruleConfig: {
      findMany: findManyMock
    },
    groupReplyPolicy: {
      findUnique: groupPolicyFindUniqueMock
    }
  }
}));

describe("ReplyDecisionEngine", () => {
  beforeEach(() => {
    groupPolicyFindUniqueMock.mockResolvedValue(null);
    findManyMock.mockResolvedValue([
      {
        type: "trigger",
        config: { threshold: 50, questionBonus: 35, intentBonus: 25 }
      },
      {
        type: "risk",
        config: {
          blockedKeywords: ["退款"],
          blockedTopics: ["complaint", "emotional"]
        }
      }
    ]);
  });

  test("should score high for explicit question", async () => {
    const { evaluateReplyDecision } = await import("../src/modules/rules/reply-decision.engine.js");
    const now = new Date();
    const decision = await evaluateReplyDecision({
      message: {
        id: "msg-1",
        eventId: "e1",
        robotId: "r1",
        groupId: "g1",
        senderId: "u1",
        senderName: "user",
        chatType: "group",
        messageType: "text",
        semanticKind: null,
        inboundCapturedAt: null,
        messageText: "请问活动怎么报名？",
        messageTextNormalized: "请问活动怎么报名？",
        externalMessageId: "m1",
        replyToMessageId: null,
        sentAt: now,
        isFromRobot: false,
        createdAt: now
      },
      group: {
        id: "g1",
        externalGroupId: null,
        title: "群A",
        city: null,
        enabled: true,
        autoReplyEnabled: true,
        proactiveEnabled: true,
        dailyProactiveLimit: 10,
        cooldownSeconds: 180,
        silenceThresholdSeconds: 600,
        maxRobotMessagesPerHour: 8,
        targetIdHint: null,
        createdAt: now,
        updatedAt: now
      },
      recentMessages: []
    });

    expect(decision.shouldReply).toBe(true);
    expect(decision.score).toBeGreaterThanOrEqual(50);
    expect(decision.riskLevel).toBe(RiskLevel.low);
  });

  test("should block risk content", async () => {
    const { evaluateReplyDecision } = await import("../src/modules/rules/reply-decision.engine.js");
    const now = new Date();
    const decision = await evaluateReplyDecision({
      message: {
        id: "msg-2",
        eventId: "e2",
        robotId: "r1",
        groupId: "g1",
        senderId: "u1",
        senderName: "user",
        chatType: "group",
        messageType: "text",
        semanticKind: null,
        inboundCapturedAt: null,
        messageText: "我要投诉并退款",
        messageTextNormalized: "我要投诉并退款",
        externalMessageId: "m2",
        replyToMessageId: null,
        sentAt: now,
        isFromRobot: false,
        createdAt: now
      },
      group: {
        id: "g1",
        externalGroupId: null,
        title: "群A",
        city: null,
        enabled: true,
        autoReplyEnabled: true,
        proactiveEnabled: true,
        dailyProactiveLimit: 10,
        cooldownSeconds: 180,
        silenceThresholdSeconds: 600,
        maxRobotMessagesPerHour: 8,
        targetIdHint: null,
        createdAt: now,
        updatedAt: now
      },
      recentMessages: []
    });

    expect(decision.shouldReply).toBe(false);
    expect(decision.riskLevel).toBe(RiskLevel.blocked);
  });

  test("口语「…了没」应触发回复（unknown + 问句形态）", async () => {
    const { evaluateReplyDecision } = await import("../src/modules/rules/reply-decision.engine.js");
    const now = new Date();
    const decision = await evaluateReplyDecision({
      message: {
        id: "msg-3",
        eventId: "e3",
        robotId: "r1",
        groupId: "g1",
        senderId: "u1",
        senderName: "user",
        chatType: "group",
        messageType: "text",
        semanticKind: null,
        inboundCapturedAt: null,
        messageText: "滨润锦翠城样板房开了没",
        messageTextNormalized: "滨润锦翠城样板房开了没",
        externalMessageId: "m3",
        replyToMessageId: null,
        sentAt: now,
        isFromRobot: false,
        createdAt: now
      },
      group: {
        id: "g1",
        externalGroupId: null,
        title: "群A",
        city: null,
        enabled: true,
        autoReplyEnabled: true,
        proactiveEnabled: true,
        dailyProactiveLimit: 10,
        cooldownSeconds: 180,
        silenceThresholdSeconds: 600,
        maxRobotMessagesPerHour: 8,
        targetIdHint: null,
        createdAt: now,
        updatedAt: now
      },
      recentMessages: []
    });

    expect(decision.shouldReply).toBe(true);
    expect(decision.score).toBeGreaterThanOrEqual(50);
    expect(decision.matchedRules).toContain("implicit_faq_from_question_shape");
  });
});
