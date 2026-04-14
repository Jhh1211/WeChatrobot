import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { acceptWebhookEvent } from "./webhook.service.js";

const webhookBodySchema = z.record(z.any());

export async function registerWebhookRoutes(app: FastifyInstance): Promise<void> {
  /**
   * WorkTool 消息回调入口（主链路）
   */
  app.post("/api/webhooks/worktool/messages", async (request, reply) => {
    const payload = webhookBodySchema.parse(request.body);
    const result = await acceptWebhookEvent(payload);
    return reply.status(200).send({
      success: true,
      data: {
        accepted: true,
        duplicated: result.duplicated
      },
      error: null
    });
  });
}
