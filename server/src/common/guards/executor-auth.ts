import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../config/env.js";

export async function executorAuthGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, "")?.trim();
  if (!token || token !== env.EXECUTOR_SHARED_TOKEN) {
    return reply.status(401).send({
      success: false,
      error: { code: "UNAUTHORIZED", message: "invalid executor token" }
    });
  }
}
