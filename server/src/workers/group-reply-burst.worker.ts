import { Worker } from "bullmq";
import { redis } from "../common/config/redis.js";
import { QUEUE_NAMES } from "../queue/names.js";
import { processGroupBurstFlush } from "../modules/reply/group-reply-burst.service.js";
import { logger } from "../common/logger/pino.js";

let worker: Worker | null = null;

export function startGroupReplyBurstWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(
    QUEUE_NAMES.groupReplyBurst,
    async (job) => {
      const groupId = job.data?.groupId;
      if (!groupId || typeof groupId !== "string") return;
      await processGroupBurstFlush(groupId);
    },
    { connection: redis, concurrency: 8 }
  );
  worker.on("failed", (job, err) => {
    logger.error({ err, jobId: job?.id, groupId: job?.data?.groupId }, "group_reply_burst_job_failed");
  });
  return worker;
}
