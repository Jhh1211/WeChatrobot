import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { ChatType, MessageType, SendStatus } from "@prisma/client";
import { createServer } from "../src/app/server.js";
import { env } from "../src/common/config/env.js";
import { prisma } from "../src/common/config/prisma.js";
import { processSendOutboundJob } from "../src/workers/send-message.worker.js";

describe("outbound status sync from executor result", () => {
  let app: FastifyInstance | undefined;
  const suffix = `${Date.now()}`;
  const robotId = `vitest-out-${suffix}`;
  const deviceId = `vitest-out-d-${suffix}`;

  beforeAll(async () => {
    app = await createServer();
    await prisma.robot.create({
      data: { robotId, name: "out", platform: "self_hosted" }
    });
    await app!.inject({
      method: "POST",
      url: "/api/executor/device/register",
      headers: { authorization: `Bearer ${env.EXECUTOR_SHARED_TOKEN}` },
      payload: {
        deviceId,
        robotId,
        name: "out-d",
        capability: ["send_text"]
      }
    });
  });

  afterAll(async () => {
    await app?.close();
    const robot = await prisma.robot.findUnique({ where: { robotId } });
    if (robot) {
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
      await prisma.device.deleteMany({ where: { robotId: robot.id } });
      await prisma.group.deleteMany({ where: { title: `vitest-out-grp-${suffix}` } });
      await prisma.robot.delete({ where: { id: robot.id } });
    }
  });

  test("executor success -> outbound success；重复 result 幂等", async () => {
    const robot = await prisma.robot.findUniqueOrThrow({ where: { robotId } });
    const group = await prisma.group.create({
      data: {
        title: `vitest-out-grp-${suffix}`,
        enabled: true,
        autoReplyEnabled: true,
        cooldownSeconds: 1,
        maxRobotMessagesPerHour: 99
      }
    });
    const event = await prisma.inboundEvent.create({
      data: {
        eventUid: `vitest-out-ev-${suffix}`,
        robotId: robot.id,
        rawPayload: {},
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
        messageText: "m",
        isFromRobot: false
      }
    });
    const outbound = await prisma.outboundMessage.create({
      data: {
        robotId: robot.id,
        groupId: group.id,
        relatedInboundMessageId: inbound.id,
        content: "c",
        targetTitle: group.title,
        sendStatus: SendStatus.pending,
        sendRequest: {}
      }
    });
    await processSendOutboundJob(outbound.id);
    const task = await prisma.executorTask.findFirstOrThrow({ where: { outboundMessageId: outbound.id } });

    await app!.inject({
      method: "POST",
      url: `/api/executor/tasks/${task.id}/ack`,
      headers: { authorization: `Bearer ${env.EXECUTOR_SHARED_TOKEN}` },
      payload: { deviceId }
    });
    await app!.inject({
      method: "POST",
      url: `/api/executor/tasks/${task.id}/result`,
      headers: { authorization: `Bearer ${env.EXECUTOR_SHARED_TOKEN}` },
      payload: { deviceId, status: "success", detail: { ok: true }, executedAt: new Date().toISOString() }
    });
    const o1 = await prisma.outboundMessage.findUniqueOrThrow({ where: { id: outbound.id } });
    expect(o1.sendStatus).toBe(SendStatus.success);

    const res2 = await app!.inject({
      method: "POST",
      url: `/api/executor/tasks/${task.id}/result`,
      headers: { authorization: `Bearer ${env.EXECUTOR_SHARED_TOKEN}` },
      payload: { deviceId, status: "failed", detail: { retry: true } }
    });
    expect(res2.statusCode).toBe(200);
    const o2 = await prisma.outboundMessage.findUniqueOrThrow({ where: { id: outbound.id } });
    expect(o2.sendStatus).toBe(SendStatus.success);
  });

  test("executor failed -> outbound failed", async () => {
    const robot = await prisma.robot.findUniqueOrThrow({ where: { robotId } });
    const group = await prisma.group.findFirstOrThrow({ where: { title: `vitest-out-grp-${suffix}` } });
    const event = await prisma.inboundEvent.create({
      data: {
        eventUid: `vitest-out-ev2-${suffix}`,
        robotId: robot.id,
        rawPayload: {},
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
        messageText: "m2",
        isFromRobot: false
      }
    });
    const outbound = await prisma.outboundMessage.create({
      data: {
        robotId: robot.id,
        groupId: group.id,
        relatedInboundMessageId: inbound.id,
        content: "c2",
        targetTitle: group.title,
        sendStatus: SendStatus.pending,
        sendRequest: {}
      }
    });
    await processSendOutboundJob(outbound.id);
    const task = await prisma.executorTask.findFirstOrThrow({ where: { outboundMessageId: outbound.id } });
    await app!.inject({
      method: "POST",
      url: `/api/executor/tasks/${task.id}/ack`,
      headers: { authorization: `Bearer ${env.EXECUTOR_SHARED_TOKEN}` },
      payload: { deviceId }
    });
    await app!.inject({
      method: "POST",
      url: `/api/executor/tasks/${task.id}/result`,
      headers: { authorization: `Bearer ${env.EXECUTOR_SHARED_TOKEN}` },
      payload: { deviceId, status: "failed", detail: { err: true }, errorMessage: "x" }
    });
    const o = await prisma.outboundMessage.findUniqueOrThrow({ where: { id: outbound.id } });
    expect(o.sendStatus).toBe(SendStatus.failed);
  });
});
