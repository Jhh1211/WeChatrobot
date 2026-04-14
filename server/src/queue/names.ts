export const QUEUE_NAMES = {
  inboundEvent: "inbound-event-queue",
  outboundSend: "outbound-send-queue",
  groupReplyBurst: "group-reply-burst-queue"
} as const;

export const JOB_NAMES = {
  processInboundEvent: "process-inbound-event",
  sendOutboundMessage: "send-outbound-message",
  groupReplyBurstFlush: "group-reply-burst-flush"
} as const;
