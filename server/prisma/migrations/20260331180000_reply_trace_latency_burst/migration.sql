-- AlterEnum (idempotent for re-runs)
DO $$ BEGIN
  ALTER TYPE "ReplyTraceStatus" ADD VALUE 'skipped_filter';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- AlterTable
ALTER TABLE "InboundMessage" ADD COLUMN IF NOT EXISTS "semanticKind" TEXT;
ALTER TABLE "InboundMessage" ADD COLUMN IF NOT EXISTS "inboundCapturedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ReplyTrace" ADD COLUMN IF NOT EXISTS "semanticMessageType" TEXT;
ALTER TABLE "ReplyTrace" ADD COLUMN IF NOT EXISTS "skipAutoReplyReason" TEXT;
ALTER TABLE "ReplyTrace" ADD COLUMN IF NOT EXISTS "enteredAiPipeline" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ReplyTrace" ADD COLUMN IF NOT EXISTS "burstGroupedCount" INTEGER;
ALTER TABLE "ReplyTrace" ADD COLUMN IF NOT EXISTS "mergedMessagesPreview" TEXT;
ALTER TABLE "ReplyTrace" ADD COLUMN IF NOT EXISTS "finalUserPromptPreview" TEXT;
ALTER TABLE "ReplyTrace" ADD COLUMN IF NOT EXISTS "latencyBreakdown" JSONB;
