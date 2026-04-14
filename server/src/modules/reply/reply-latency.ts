import { prisma } from "../../common/config/prisma.js";

export type LatencyAt = {
  inboundCapturedAt?: string;
  inboundPersistedAt?: string;
  replyDecisionStartedAt?: string;
  replyDecisionFinishedAt?: string;
  llmStartedAt?: string;
  llmFinishedAt?: string;
  outboundCreatedAt?: string;
  executorTaskCreatedAt?: string;
  /** 发送 Worker 预检未通过（未创建 executor_task）时写入，便于与「队列未消费」区分 */
  sendWorkerPrecheckBlockedAt?: string;
  sendWorkerPrecheckReason?: string;
  sendStartedAt?: string;
  sendFinishedAt?: string;
  sendVerifiedAt?: string;
};

export type LatencyMs = {
  inboundToDecisionMs?: number;
  decisionMs?: number;
  llmMs?: number;
  queueWaitMs?: number;
  executorSendMs?: number;
  totalReplyMs?: number;
};

export type LatencyBreakdownPayload = { at: LatencyAt; ms: LatencyMs };

function iso(d: Date): string {
  return d.toISOString();
}

function diffMs(a?: string, b?: string): number | undefined {
  if (!a || !b) return undefined;
  const t0 = Date.parse(a);
  const t1 = Date.parse(b);
  if (Number.isNaN(t0) || Number.isNaN(t1)) return undefined;
  return Math.max(0, t1 - t0);
}

export class ReplyLatencyTracker {
  at: LatencyAt = {};

  markInboundCaptured(d: Date): void {
    this.at.inboundCapturedAt = iso(d);
  }

  markInboundPersisted(d = new Date()): void {
    this.at.inboundPersistedAt = iso(d);
  }

  markDecisionStart(d = new Date()): void {
    this.at.replyDecisionStartedAt = iso(d);
  }

  markDecisionEnd(d = new Date()): void {
    this.at.replyDecisionFinishedAt = iso(d);
  }

  markLlmStart(d = new Date()): void {
    this.at.llmStartedAt = iso(d);
  }

  markLlmEnd(d = new Date()): void {
    this.at.llmFinishedAt = iso(d);
  }

  markOutboundCreated(d = new Date()): void {
    this.at.outboundCreatedAt = iso(d);
  }

  markExecutorTaskCreated(d = new Date()): void {
    this.at.executorTaskCreatedAt = iso(d);
  }

  markSendStarted(d = new Date()): void {
    this.at.sendStartedAt = iso(d);
  }

  markSendFinished(d = new Date()): void {
    this.at.sendFinishedAt = iso(d);
    this.at.sendVerifiedAt = iso(d);
  }

  computeMs(): LatencyMs {
    const { at } = this;
    const ms: LatencyMs = {};
    const i2d = diffMs(at.inboundCapturedAt, at.replyDecisionStartedAt);
    if (i2d !== undefined) ms.inboundToDecisionMs = i2d;
    const dec = diffMs(at.replyDecisionStartedAt, at.replyDecisionFinishedAt);
    if (dec !== undefined) ms.decisionMs = dec;
    const llm = diffMs(at.llmStartedAt, at.llmFinishedAt);
    if (llm !== undefined) ms.llmMs = llm;
    const qw = diffMs(at.outboundCreatedAt, at.executorTaskCreatedAt);
    if (qw !== undefined) ms.queueWaitMs = qw;
    const ex = diffMs(at.sendStartedAt, at.sendFinishedAt);
    if (ex !== undefined) ms.executorSendMs = ex;
    const tot = diffMs(at.inboundCapturedAt, at.sendFinishedAt);
    if (tot !== undefined) ms.totalReplyMs = tot;
    return ms;
  }

  toJSON(): LatencyBreakdownPayload {
    return { at: { ...this.at }, ms: this.computeMs() };
  }
}

export function mergeLatencyBreakdownPayload(
  prev: LatencyBreakdownPayload | null,
  patch: Partial<LatencyAt>
): LatencyBreakdownPayload {
  const at = { ...(prev?.at ?? {}), ...patch };
  if (at.sendFinishedAt && !at.sendVerifiedAt) {
    at.sendVerifiedAt = at.sendFinishedAt;
  }
  const tracker = new ReplyLatencyTracker();
  Object.assign(tracker.at, at);
  return { at, ms: tracker.computeMs() };
}

export async function mergeTraceLatencyBreakdown(
  traceId: string,
  patch: Partial<LatencyAt>
): Promise<void> {
  const row = await prisma.replyTrace.findUnique({ where: { id: traceId } });
  const prev = (row?.latencyBreakdown as LatencyBreakdownPayload | null) ?? null;
  const next = mergeLatencyBreakdownPayload(prev, patch);
  await prisma.replyTrace.update({
    where: { id: traceId },
    data: { latencyBreakdown: next as object }
  });
}
