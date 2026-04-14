import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { createServer } from "../src/app/server.js";
import { env } from "../src/common/config/env.js";

describe("executor auth", () => {
  let app: FastifyInstance | undefined;

  beforeAll(async () => {
    app = await createServer();
  });

  afterAll(async () => {
    await app?.close();
  });

  test("无 Authorization -> 401 且统一错误体", async () => {
    const res = await app!.inject({
      method: "POST",
      url: "/api/executor/device/register",
      payload: {
        deviceId: "x",
        robotId: "y",
        name: "n",
        capability: ["send_text"]
      }
    });
    expect(res.statusCode).toBe(401);
    const body = res.json() as { success: boolean; error?: { code: string } };
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe("UNAUTHORIZED");
    expect(body).not.toHaveProperty("data");
  });

  test("错误 token -> 401", async () => {
    const res = await app!.inject({
      method: "POST",
      url: "/api/executor/device/register",
      headers: { authorization: "Bearer wrong-token" },
      payload: {
        deviceId: "x",
        robotId: "y",
        name: "n",
        capability: ["send_text"]
      }
    });
    expect(res.statusCode).toBe(401);
  });

  test("正确 token -> 通过鉴权", async () => {
    const res = await app!.inject({
      method: "POST",
      url: "/api/executor/device/register",
      headers: { authorization: `Bearer ${env.EXECUTOR_SHARED_TOKEN}` },
      payload: {
        deviceId: `vitest-auth-${Date.now()}`,
        robotId: `vitest-robot-${Date.now()}`,
        name: "auth-test",
        capability: ["send_text"]
      }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { success: boolean; data?: { deviceId: string } };
    expect(body.success).toBe(true);
    expect(body.data?.deviceId).toBeTruthy();
  });
});
