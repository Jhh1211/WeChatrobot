-- Trace: same-sender context key + meta for ops filtering / 复盘

ALTER TABLE "ReplyTrace" ADD COLUMN "sameSenderContextSenderKey" TEXT;
ALTER TABLE "ReplyTrace" ADD COLUMN "sameSenderContextMeta" JSONB;

CREATE INDEX "ReplyTrace_sameSenderContextSenderKey_groupId_idx" ON "ReplyTrace"("sameSenderContextSenderKey", "groupId");
