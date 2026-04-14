import { createServer } from "./app/server.js";
import { env } from "./common/config/env.js";
import { logger } from "./common/logger/pino.js";
import { startWorkers } from "./workers/index.js";
import { startSchedulers } from "./modules/scheduler/scheduler.service.js";

async function bootstrap(): Promise<void> {
  const app = await createServer();
  await app.listen({ host: "0.0.0.0", port: env.PORT });

  await startWorkers();
  startSchedulers();

  logger.info({ port: env.PORT }, "wework-ai-assistant started");
}

bootstrap().catch((error) => {
  logger.error({ error }, "bootstrap failed");
  process.exit(1);
});
