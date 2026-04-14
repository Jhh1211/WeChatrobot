import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { createServer } from "../src/app/server.js";
import { env } from "../src/common/config/env.js";
import { prisma } from "../src/common/config/prisma.js";
import { persistInboundMessage } from "../src/modules/messages/messages.service.js";

describe("inbound-events idempotency", () => {
  let app: FastifyInstance | undefined;
  const suffix = `${Date.now()}`;
  const robotId = `vitest-in-${suffix}`;
  const deviceId = `vitest-in-d-${suffix}`;
  const ts = "2020-01-01T00:00:00.000Z";
  const payload = {
    deviceId,
    robotId,
    source: "vitest",
    rawPayload: { k: 1 },
    normalizedMessage: {
      chatTitle: "同一群",
      senderName: "u1",
      text: "同一条",
      timestamp: ts,
      isFromSelf: false,
      messageType: "text"
    }
  };

  beforeAll(async () => {
    app = await createServer();
    await app!.inject({
      method: "POST",
      url: "/api/executor/device/register",
      headers: { authorization: `Bearer ${env.EXECUTOR_SHARED_TOKEN}` },
      payload: {
        deviceId,
        robotId,
        name: "in-test",
        capability: ["send_text"]
      }
    });
  });

  afterAll(async () => {
    await app?.close();
    const robot = await prisma.robot.findUnique({ where: { robotId } });
    if (robot) {
      const events = await prisma.inboundEvent.findMany({ where: { robotId: robot.id } });
      for (const ev of events) {
        await prisma.inboundMessage.deleteMany({ where: { eventId: ev.id } });
        await prisma.inboundEvent.delete({ where: { id: ev.id } });
      }
      await prisma.device.deleteMany({ where: { robotId: robot.id } });
      await prisma.robot.delete({ where: { id: robot.id } });
    }
  });

  test("相同 normalized 重复上报仅一条 inbound_event", async () => {
    const r1 = await app!.inject({
      method: "POST",
      url: "/api/executor/inbound-events",
      headers: { authorization: `Bearer ${env.EXECUTOR_SHARED_TOKEN}` },
      payload
    });
    const r2 = await app!.inject({
      method: "POST",
      url: "/api/executor/inbound-events",
      headers: { authorization: `Bearer ${env.EXECUTOR_SHARED_TOKEN}` },
      payload
    });
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    const j1 = r1.json() as { data: { duplicated: boolean } };
    const j2 = r2.json() as { data: { duplicated: boolean } };
    expect(j1.data.duplicated).toBe(false);
    expect(j2.data.duplicated).toBe(true);

    const robot = await prisma.robot.findUniqueOrThrow({ where: { robotId } });
    const count = await prisma.inboundEvent.count({ where: { robotId: robot.id } });
    expect(count).toBe(1);
  });

  test("同一 eventId persistInboundMessage 不重复插入 inbound_message", async () => {
    const robot = await prisma.robot.findUniqueOrThrow({ where: { robotId } });
    const ev = await prisma.inboundEvent.findFirstOrThrow({ where: { robotId: robot.id } });
    const m1 = await persistInboundMessage({
      eventId: ev.id,
      rawPayload: ev.rawPayload as Record<string, unknown>
    });
    const m2 = await persistInboundMessage({
      eventId: ev.id,
      rawPayload: ev.rawPayload as Record<string, unknown>
    });
    expect(m1.id).toBe(m2.id);
    const mc = await prisma.inboundMessage.count({ where: { eventId: ev.id } });
    expect(mc).toBe(1);
  });
});
