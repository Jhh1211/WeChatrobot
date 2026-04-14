import { afterAll, describe, expect, test } from "vitest";
import { ChatType, MessageType, SendStatus } from "@prisma/client";
import { prisma } from "../src/common/config/prisma.js";
import { processSendOutboundJob } from "../src/workers/send-message.worker.js";

describe("create send task via worker", () => {
  const suffix = `${Date.now()}`;
  const robotId = `vitest-send-${suffix}`;

  afterAll(async () => {
    const robot = await prisma.robot.findUnique({ where: { robotId } });
    if (!robot) return;
    await prisma.executorTaskAttempt.deleteMany({
      where: { task: { robotId: robot.id } }
    });
    await prisma.executorTask.deleteMany({ where: { robotId: robot.id } });
    await prisma.outboundMessage.deleteMany({ where: { robotId: robot.id } });
    await prisma.inboundMessage.deleteMany({ where: { robotId: robot.id } });
    const events = await prisma.inboundEvent.findMany({ where: { robotId: robot.id } });
    for (const ev of events) {
      await prisma.inboundEvent.delete({ where: { id: ev.id } });
    }
    await prisma.group.deleteMany({ where: { title: `vitest-grp-${suffix}` } });
    await prisma.robot.delete({ where: { id: robot.id } });
  });

  test("processSendOutboundJob 创建 executor_task 且 outbound 为 pending_executor", async () => {
    const robot = await prisma.robot.create({
      data: { robotId, name: "t", platform: "self_hosted" }
    });
    const group = await prisma.group.create({
      data: {
        title: `vitest-grp-${suffix}`,
        enabled: true,
        autoReplyEnabled: true,
        cooldownSeconds: 1,
        silenceThresholdSeconds: 600,
        maxRobotMessagesPerHour: 99
      }
    });
    const event = await prisma.inboundEvent.create({
      data: {
        eventUid: `vitest-ev-${suffix}`,
        robotId: robot.id,
        rawPayload: { text: "hi", robot_id: robotId, group_name: group.title },
        sourceType: "android_accessibility",
        callbackReceivedAt: new Date(),
        status: "processed",
        processedAt: new Date()
      }
    });
    const inbound = await prisma.inboundMessage.create({
      data: {
        eventId: event.id,
        robotId: robot.id,
        groupId: group.id,
        chatType: ChatType.group,
        messageType: MessageType.text,
        messageText: "hi",
        isFromRobot: false
      }
    });
    const outbound = await prisma.outboundMessage.create({
      data: {
        robotId: robot.id,
        groupId: group.id,
        relatedInboundMessageId: inbound.id,
        content: "reply text",
        targetTitle: group.title,
        sendStatus: SendStatus.pending,
        sendRequest: {}
      }
    });

    await processSendOutboundJob(outbound.id);

    const updated = await prisma.outboundMessage.findUniqueOrThrow({ where: { id: outbound.id } });
    expect(updated.sendStatus).toBe(SendStatus.pending_executor);
    const task = await prisma.executorTask.findFirst({
      where: { robotId: robot.id, outboundMessageId: outbound.id }
    });
    expect(task).toBeTruthy();
    expect(task?.status).toBe("pending");
    expect(task?.type).toBe("send_text");
  });
});
