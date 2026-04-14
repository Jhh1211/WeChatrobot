import { Queue } from "bullmq";
import { redis } from "../common/config/redis.js";
import { QUEUE_NAMES } from "./names.js";

export interface ProcessInboundEventJob {
  eventId: string;
}

export interface SendOutboundMessageJob {
  outboundMessageId: string;
  replyTraceId?: string;
}

export interface GroupReplyBurstJob {
  groupId: string;
}

export const inboundEventQueue = new Queue<ProcessInboundEventJob>(QUEUE_NAMES.inboundEvent, {
  connection: redis
});

export const outboundSendQueue = new Queue<SendOutboundMessageJob>(QUEUE_NAMES.outboundSend, {
  connection: redis
});

export const groupReplyBurstQueue = new Queue<GroupReplyBurstJob>(QUEUE_NAMES.groupReplyBurst, {
  connection: redis
});
