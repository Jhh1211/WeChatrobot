import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { EventSourceType, SendStatus } from "@prisma/client";
import { prisma } from "../src/common/config/prisma.js";
import { persistInboundMessage } from "../src/modules/messages/messages.service.js";

describe("inbound echo suppress (outbound text match)", () => {
  const suffix = `${Date.now()}`;
  const robotExternalId = `vitest-echo-robot-${suffix}`;
  const groupTitle = `EchoGroup-${suffix}`;
  const echoText = "机器人刚发的同文回声";

  let robotInternalId: string;
  let groupId: string;

  beforeAll(async () => {
    const robot = await prisma.robot.create({
      data: { robotId: robotExternalId, name: robotExternalId, platform: "self_hosted" }
    });
    robotInternalId = robot.id;

    const group = await prisma.group.create({
      data: {
        id: `title:${groupTitle}`,
        title: groupTitle,
        cooldownSeconds: 180,
        silenceThresholdSeconds: 600,
        maxRobotMessagesPerHour: 8
      }
    });
    groupId = group.id;

    await prisma.outboundMessage.create({
      data: {
        robotId: robotInternalId,
        groupId,
        content: echoText,
        targetTitle: groupTitle,
        sendStatus: SendStatus.success,
        sendRequest: { test: true },
        sentAt: new Date()
      }
    });
  });

  afterAll(async () => {
    await prisma.outboundMessage.deleteMany({ where: { groupId } });
    await prisma.inboundMessage.deleteMany({ where: { robotId: robotInternalId } });
    await prisma.inboundEvent.deleteMany({ where: { robotId: robotInternalId } });
    await prisma.group.deleteMany({ where: { id: groupId } });
    await prisma.robot.delete({ where: { id: robotInternalId } });
  });

  test("与近期成功出站全文一致时记为己方，不入 user_text", async () => {
    const ev = await prisma.inboundEvent.create({
      data: {
        eventUid: `echo-ev-${suffix}`,
        robotId: robotInternalId,
        rawPayload: {
          robot_id: robotExternalId,
          group_name: groupTitle,
          chat_type: "group",
          msg_type: "text",
          text: echoText,
          sender_name: "vitest-user",
          isFromRobot: false
        },
        sourceType: EventSourceType.android_accessibility,
        callbackReceivedAt: new Date(),
        status: "pending"
      }
    });

    const msg = await persistInboundMessage({
      eventId: ev.id,
      rawPayload: ev.rawPayload as Record<string, unknown>
    });

    expect(msg.isFromRobot).toBe(true);
    expect(msg.semanticKind).toBe("self_text");
  });

  test("超出时间窗的成功出站不参与匹配", async () => {
    const oldText = "很久以前的出站文案";
    await prisma.outboundMessage.create({
      data: {
        robotId: robotInternalId,
        groupId,
        content: oldText,
        targetTitle: groupTitle,
        sendStatus: SendStatus.success,
        sendRequest: { test: true },
        sentAt: new Date(Date.now() - 60 * 60 * 1000),
        createdAt: new Date(Date.now() - 60 * 60 * 1000)
      }
    });

    const ev = await prisma.inboundEvent.create({
      data: {
        eventUid: `echo-ev-old-${suffix}`,
        robotId: robotInternalId,
        rawPayload: {
          robot_id: robotExternalId,
          group_name: groupTitle,
          chat_type: "group",
          msg_type: "text",
          text: oldText,
          sender_name: "vitest-user",
          isFromRobot: false
        },
        sourceType: EventSourceType.android_accessibility,
        callbackReceivedAt: new Date(),
        status: "pending"
      }
    });

    const msg = await persistInboundMessage({
      eventId: ev.id,
      rawPayload: ev.rawPayload as Record<string, unknown>
    });

    expect(msg.isFromRobot).toBe(false);
    expect(msg.semanticKind).toBe("user_text");
  });

  test("文首 @ + 与近期出站同文仍判回声", async () => {
    const body = "机器人刚发的同文回声";
    const ev = await prisma.inboundEvent.create({
      data: {
        eventUid: `echo-ev-at-${suffix}-${Date.now()}`,
        robotId: robotInternalId,
        rawPayload: {
          robot_id: robotExternalId,
          group_name: groupTitle,
          chat_type: "group",
          msg_type: "text",
          text: `@vitest-user  ${body}`,
          sender_name: "vitest-user",
          isFromRobot: false
        },
        sourceType: EventSourceType.android_accessibility,
        callbackReceivedAt: new Date(),
        status: "pending"
      }
    });

    const msg = await persistInboundMessage({
      eventId: ev.id,
      rawPayload: ev.rawPayload as Record<string, unknown>
    });

    expect(msg.isFromRobot).toBe(true);
    expect(msg.semanticKind).toBe("self_text");
  });
});
