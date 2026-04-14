import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { OnlineStatus } from "@prisma/client";
import { createServer } from "../src/app/server.js";
import { env } from "../src/common/config/env.js";
import { prisma } from "../src/common/config/prisma.js";
import { refreshRobotOnlineFromDevices, ROBOT_HEARTBEAT_WINDOW_MS } from "../src/modules/robots/robots.service.js";

describe("device register + heartbeat", () => {
  let app: FastifyInstance | undefined;
  const suffix = `${Date.now()}`;
  const robotId = `vitest-dev-${suffix}`;
  const deviceId = `vitest-dvc-${suffix}`;

  beforeAll(async () => {
    app = await createServer();
  });

  afterAll(async () => {
    await app?.close();
    const robot = await prisma.robot.findUnique({ where: { robotId } });
    if (robot) {
      await prisma.deviceHeartbeat.deleteMany({ where: { device: { robotId: robot.id } } });
      await prisma.device.deleteMany({ where: { robotId: robot.id } });
      await prisma.robot.delete({ where: { id: robot.id } });
    }
  });

  test("注册设备成功", async () => {
    const res = await app!.inject({
      method: "POST",
      url: "/api/executor/device/register",
      headers: { authorization: `Bearer ${env.EXECUTOR_SHARED_TOKEN}` },
      payload: {
        deviceId,
        robotId,
        name: "vitest-device",
        capability: ["send_text"]
      }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { success: boolean; data: { id: string } };
    expect(body.success).toBe(true);
    expect(body.data.id).toBeTruthy();
  });

  test("重复注册走 upsert（更新名称）", async () => {
    const res = await app!.inject({
      method: "POST",
      url: "/api/executor/device/register",
      headers: { authorization: `Bearer ${env.EXECUTOR_SHARED_TOKEN}` },
      payload: {
        deviceId,
        robotId,
        name: "vitest-device-renamed",
        capability: ["send_text"]
      }
    });
    expect(res.statusCode).toBe(200);
    const dev = await prisma.device.findUnique({ where: { deviceId } });
    expect(dev?.name).toBe("vitest-device-renamed");
  });

  test("心跳后 lastSeenAt 更新", async () => {
    const before = await prisma.device.findUnique({ where: { deviceId } });
    const t0 = before?.lastSeenAt?.getTime() ?? 0;
    await new Promise((r) => setTimeout(r, 50));
    const res = await app!.inject({
      method: "POST",
      url: "/api/executor/device/heartbeat",
      headers: { authorization: `Bearer ${env.EXECUTOR_SHARED_TOKEN}` },
      payload: { deviceId, robotId, status: "online" }
    });
    expect(res.statusCode).toBe(200);
    const after = await prisma.device.findUnique({ where: { deviceId } });
    expect(after?.lastSeenAt).toBeTruthy();
    expect((after?.lastSeenAt?.getTime() ?? 0) >= t0).toBe(true);
  });

  test("超过心跳窗口无近期心跳则机器人 offline", async () => {
    const robot = await prisma.robot.findUniqueOrThrow({ where: { robotId } });
    const device = await prisma.device.findUniqueOrThrow({ where: { deviceId } });
    await prisma.deviceHeartbeat.deleteMany({ where: { deviceId: device.id } });
    const stale = new Date(Date.now() - ROBOT_HEARTBEAT_WINDOW_MS - 60_000);
    await prisma.deviceHeartbeat.create({
      data: { deviceId: device.id, receivedAt: stale, detail: { test: true } }
    });
    await refreshRobotOnlineFromDevices();
    const r = await prisma.robot.findUniqueOrThrow({ where: { id: robot.id } });
    expect(r.onlineStatus).toBe(OnlineStatus.offline);
  });
});
