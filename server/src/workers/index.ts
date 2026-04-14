import { startInboundEventWorker } from "./inbound-event.worker.js";
import { startSendMessageWorker } from "./send-message.worker.js";
import { startGroupReplyBurstWorker } from "./group-reply-burst.worker.js";

export async function startWorkers(): Promise<void> {
  startInboundEventWorker();
  startSendMessageWorker();
  startGroupReplyBurstWorker();
}
