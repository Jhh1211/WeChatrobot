import { PrismaClient, RuleType, KnowledgeType, CannedMatchType, CannedScopeType } from "@prisma/client";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const robotId = process.env.DEFAULT_ROBOT_ID ?? "default_robot";

  const robot = await prisma.robot.upsert({
    where: { robotId },
    update: { platform: "self_hosted" },
    create: {
      robotId,
      name: "Default self-hosted robot",
      platform: "self_hosted",
      callbackEnabled: false,
      replyAll: true
    }
  });

  await prisma.device.upsert({
    where: { deviceId: "demo-android-device" },
    update: { robotId: robot.id },
    create: {
      deviceId: "demo-android-device",
      robotId: robot.id,
      name: "Demo Android executor",
      capability: { capabilities: ["send_text"] }
    }
  });

  const group = await prisma.group.upsert({
    where: { id: "default-group-id" },
    update: {},
    create: {
      id: "default-group-id",
      title: "默认外部群",
      city: "default",
      autoReplyEnabled: true,
      proactiveEnabled: true
    }
  });

  const rules = [
    {
      name: "default_trigger_threshold",
      type: RuleType.trigger,
      priority: 10,
      config: {
        threshold: Number(process.env.DEFAULT_REPLY_THRESHOLD ?? 50),
        questionBonus: 35,
        intentBonus: 25,
        silenceBonus: 20,
        leadBonus: 20,
        chillBonus: 15,
        robotOvertalkPenalty: -35,
        dualChatPenalty: -20
      }
    },
    {
      name: "default_risk_keywords",
      type: RuleType.risk,
      priority: 5,
      config: {
        blockedTopics: [
          "complaint",
          "refund",
          "policy_commitment",
          "price_commitment",
          "privacy"
        ],
        blockedKeywords: [
          "投诉",
          "退款",
          "保证最低价",
          "泄露隐私",
          "政策承诺",
          "霸王条款"
        ]
      }
    },
    {
      name: "default_system_prompt",
      type: RuleType.proactive,
      priority: 20,
      config: {
        prompt:
          "你是企业微信群运营助理，不是客服。回复自然简短有温度，中文，1-3句，尽量不超过120字，不要编造，遇到高风险问题建议人工跟进。"
      }
    }
  ];

  for (const rule of rules) {
    await prisma.ruleConfig.upsert({
      where: { id: `${group.id}-${rule.name}` },
      update: { config: rule.config, enabled: true },
      create: {
        id: `${group.id}-${rule.name}`,
        name: rule.name,
        enabled: true,
        groupId: group.id,
        type: rule.type,
        priority: rule.priority,
        config: rule.config
      }
    });
  }

  const kcol = await prisma.knowledgeCollection.upsert({
    where: { id: "default-knowledge-col" },
    update: { name: "默认知识库", enabled: true },
    create: {
      id: "default-knowledge-col",
      name: "默认知识库",
      description: "V1 默认集合",
      enabled: true
    }
  });

  const profile = await prisma.replyProfile.upsert({
    where: { id: "default-reply-profile" },
    update: { enabled: true },
    create: {
      id: "default-reply-profile",
      name: "默认中文客服",
      systemPrompt:
        "你是企业微信群助理，必须使用简体中文。简洁、专业、可信。不要编造事实；不确定时建议用户联系人工。严格遵守字数上限。",
      stylePrompt: "温和自然，像真人运营。",
      language: "zh-CN",
      maxChars: 120,
      emojiPolicy: "allow_limited",
      mentionPolicy: "avoid_unless_needed",
      enabled: true
    }
  });

  await prisma.runtimeConfig.upsert({
    where: { id: "singleton" },
    create: {
      id: "singleton",
      defaultLanguage: "zh-CN",
      defaultReplyProfileId: profile.id,
      retrievalMode: "hybrid",
      knowledgeFirst: true,
      allowLlmFallback: true,
      maxReplyChars: 120
    },
    update: { defaultReplyProfileId: profile.id }
  });

  await prisma.groupReplyPolicy.upsert({
    where: { groupId: group.id },
    create: {
      groupId: group.id,
      replyProfileId: profile.id,
      knowledgeCollectionId: kcol.id,
      retrievalMode: "hybrid",
      knowledgeFirst: true,
      cannedFirst: true,
      autoReplyEnabled: true,
      riskInterceptEnabled: true,
      enabled: true
    },
    update: {
      replyProfileId: profile.id,
      knowledgeCollectionId: kcol.id
    }
  });

  await prisma.cannedReplyRule.upsert({
    where: { id: "seed-canned-fixed-test" },
    update: { enabled: true, replyText: "【CannedReplyRule】固定测试命中，未走 LLM。" },
    create: {
      id: "seed-canned-fixed-test",
      scopeType: CannedScopeType.global,
      groupId: null,
      keyword: "固定测试",
      matchType: CannedMatchType.contains,
      replyText: "【CannedReplyRule】固定测试命中，未走 LLM。",
      priority: 5,
      enabled: true
    }
  });

  await prisma.knowledgeDocument.upsert({
    where: { id: "default-system-prompt-doc" },
    update: { collectionId: kcol.id },
    create: {
      id: "default-system-prompt-doc",
      title: "默认系统提示词",
      type: KnowledgeType.talk,
      city: "default",
      tags: ["system", "prompt"],
      content:
        "角色：群运营助理。语气自然，不机械。高风险问题不要直接回答，引导人工跟进。",
      collectionId: kcol.id
    }
  });

  await prisma.knowledgeDocument.upsert({
    where: { id: "default-risk-rule-doc" },
    update: { collectionId: kcol.id },
    create: {
      id: "default-risk-rule-doc",
      title: "默认风险规则",
      type: KnowledgeType.risk,
      city: "default",
      tags: ["risk", "block"],
      content: "涉及投诉、退款、价格承诺、政策承诺、隐私等内容禁止自动回复。",
      collectionId: kcol.id
    }
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
