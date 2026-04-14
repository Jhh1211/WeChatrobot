import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { createServer } from "../src/app/server.js";
import { env } from "../src/common/config/env.js";
import { prisma } from "../src/common/config/prisma.js";
import { adminCreateTestSendTask } from "../src/modules/executor/executor.service.js";

describe("executor task lifecycle", () => {
  let app: FastifyInstance | undefined;
  const suffix = `${Date.now()}`;
  const robotId = `vitest-life-${suffix}`;
  const deviceId = `vitest-life-d-${suffix}`;

  beforeAll(async () => {
    app = await createServer();
    await prisma.robot.create({
      data: { robotId, name: "life", platform: "self_hosted" }
    });
    await app!.inject({
      method: "POST",
      url: "/api/executor/device/register",
      headers: { authorization: `Bearer ${env.EXECUTOR_SHARED_TOKEN}` },
      payload: {
        deviceId,
        robotId,
        name: "life-d",
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
      await prisma.device.deleteMany({ where: { robotId: robot.id } });
      await prisma.robot.delete({ where: { id: robot.id } });
    }
  });

  test("pull -> ack -> result(success) 完整链路", async () => {
    const task = await adminCreateTestSendTask({
      robotId,
      targetChatTitle: "群A",
      text: "hello"
    });
    const pull = await app!.inject({
      method: "POST",
      url: "/api/executor/tasks/pull",
      headers: { authorization: `Bearer ${env.EXECUTOR_SHARED_TOKEN}` },
      payload: { deviceId, robotId, capability: ["send_text"] }
    });
    expect(pull.statusCode).toBe(200);
    const p = pull.json() as { data: { task: { id: string } | null } };
    expect(p.data.task?.id).toBe(task.id);

    const ack = await app!.inject({
      method: "POST",
      url: `/api/executor/tasks/${task.id}/ack`,
      headers: { authorization: `Bearer ${env.EXECUTOR_SHARED_TOKEN}` },
      payload: { deviceId }
    });
    expect(ack.statusCode).toBe(200);

    const res = await app!.inject({
      method: "POST",
      url: `/api/executor/tasks/${task.id}/result`,
      headers: { authorization: `Bearer ${env.EXECUTOR_SHARED_TOKEN}` },
      payload: {
        deviceId,
        status: "success",
        detail: { ok: true },
        executedAt: new Date().toISOString()
      }
    });
    expect(res.statusCode).toBe(200);
    const t = await prisma.executorTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(t.status).toBe("success");
  });

  test("pull -> ack -> result(failed)", async () => {
    const task = await adminCreateTestSendTask({
      robotId,
      targetChatTitle: "群B",
      text: "x"
    });
    await app!.inject({
      method: "POST",
      url: "/api/executor/tasks/pull",
      headers: { authorization: `Bearer ${env.EXECUTOR_SHARED_TOKEN}` },
      payload: { deviceId, robotId, capability: ["send_text"] }
    });
    await app!.inject({
      method: "POST",
      url: `/api/executor/tasks/${task.id}/ack`,
      headers: { authorization: `Bearer ${env.EXECUTOR_SHARED_TOKEN}` },
      payload: { deviceId }
    });
    const res = await app!.inject({
      method: "POST",
      url: `/api/executor/tasks/${task.id}/result`,
      headers: { authorization: `Bearer ${env.EXECUTOR_SHARED_TOKEN}` },
      payload: {
        deviceId,
        status: "failed",
        detail: { reason: "test" },
        errorMessage: "failed test"
      }
    });
    expect(res.statusCode).toBe(200);
    const t = await prisma.executorTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(t.status).toBe("failed");
  });

  test("非法状态跳转：重复 ack 被拒绝", async () => {
    const task = await adminCreateTestSendTask({
      robotId,
      targetChatTitle: "群C",
      text: "y"
    });
    await app!.inject({
      method: "POST",
      url: `/api/executor/tasks/${task.id}/ack`,
      headers: { authorization: `Bearer ${env.EXECUTOR_SHARED_TOKEN}` },
      payload: { deviceId }
    });
    const ack2 = await app!.inject({
      method: "POST",
      url: `/api/executor/tasks/${task.id}/ack`,
      headers: { authorization: `Bearer ${env.EXECUTOR_SHARED_TOKEN}` },
      payload: { deviceId }
    });
    expect(ack2.statusCode).toBe(409);
    await app!.inject({
      method: "POST",
      url: `/api/executor/tasks/${task.id}/result`,
      headers: { authorization: `Bearer ${env.EXECUTOR_SHARED_TOKEN}` },
      payload: { deviceId, status: "failed", detail: { cleanup: true }, errorMessage: "cleanup" }
    });
  });

  test("未 ack 直接 result -> 409 INVALID_TRANSITION", async () => {
    const task = await adminCreateTestSendTask({
      robotId,
      targetChatTitle: "群D",
      text: "z"
    });
    const res = await app!.inject({
      method: "POST",
      url: `/api/executor/tasks/${task.id}/result`,
      headers: { authorization: `Bearer ${env.EXECUTOR_SHARED_TOKEN}` },
      payload: { deviceId, status: "success", detail: {} }
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_TRANSITION");
  });
});
