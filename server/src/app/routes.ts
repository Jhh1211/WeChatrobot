import type { FastifyInstance } from "fastify";
import { registerWebhookRoutes } from "../modules/webhook/webhook.routes.js";
import { registerHealthRoutes } from "../modules/admin/health.routes.js";
import { registerAdminRoutes } from "../modules/admin/admin.routes.js";
import { registerExecutorRoutes } from "../modules/executor/executor.routes.js";

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await registerHealthRoutes(app);
  await registerExecutorRoutes(app);
  await registerWebhookRoutes(app);
  await registerAdminRoutes(app);
}
