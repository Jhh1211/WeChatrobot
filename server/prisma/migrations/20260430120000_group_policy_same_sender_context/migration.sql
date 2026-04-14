-- Same-sender conversation context for LLM (per-group ops tuning)

ALTER TABLE "GroupReplyPolicy" ADD COLUMN "sameSenderContextEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "GroupReplyPolicy" ADD COLUMN "sameSenderContextWindowMinutes" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE "GroupReplyPolicy" ADD COLUMN "sameSenderContextMaxUserMessages" INTEGER NOT NULL DEFAULT 8;
ALTER TABLE "GroupReplyPolicy" ADD COLUMN "sameSenderContextMaxBotMessages" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE "GroupReplyPolicy" ADD COLUMN "sameSenderContextMaxTotalChars" INTEGER NOT NULL DEFAULT 3500;
