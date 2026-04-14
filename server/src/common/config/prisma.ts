import { PrismaClient } from "@prisma/client";
import { logger } from "../logger/pino.js";

export const prisma = new PrismaClient({
  log: ["warn", "error"]
});

prisma.$on("error", (event) => {
  logger.error({ event }, "prisma error event");
});
