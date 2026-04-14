import type { FastifyInstance } from "fastify";
import { prisma } from "../../common/config/prisma.js";
import { redis } from "../../common/config/redis.js";

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/health", async () => {
    const [dbOk, redisOk] = await Promise.all([prisma.$queryRaw`SELECT 1`, redis.ping()]);
    return {
      success: true,
      data: {
        status: "ok",
        time: new Date().toISOString(),
        db: Boolean(dbOk),
        redis: redisOk === "PONG"
      }
    };
  });

  app.get("/api/health/worktool", async () => {
    return {
      success: true,
      data: {
        deprecated: true,
        message:
          "WorkTool commercial integration is deprecated. Use self-hosted Android executor and device heartbeats."
      }
    };
  });
}
