import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import fastifySensible from "@fastify/sensible";
import fastifyRateLimit from "@fastify/rate-limit";
import { logger } from "../common/logger/pino.js";
import { registerRoutes } from "./routes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function createServer(): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: logger
  });

  await app.register(fastifySensible);
  await app.register(fastifyRateLimit, {
    max: 120,
    timeWindow: "1 minute"
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, "request failed");
    reply.status(error.statusCode ?? 500).send({
      success: false,
      error: {
        code: error.code ?? "INTERNAL_ERROR",
        message: error.message
      }
    });
  });

  await registerRoutes(app);

  const adminHtmlPath = path.join(__dirname, "../../public/admin/index.html");
  const sendAdminHtml = (reply: FastifyReply) => {
    if (!fs.existsSync(adminHtmlPath)) {
      return reply.status(404).send("admin console not found (public/admin/index.html)");
    }
    return reply.type("text/html").send(fs.readFileSync(adminHtmlPath, "utf8"));
  };

  app.get("/admin", async (_request, reply) => sendAdminHtml(reply));
  app.get("/admin/", async (_request, reply) => sendAdminHtml(reply));

  return app;
}
