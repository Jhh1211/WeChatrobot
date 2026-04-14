-- AlterTable
ALTER TABLE "GroupReplyPolicy" ADD COLUMN     "replyLlmProvider" TEXT;

-- AlterTable
ALTER TABLE "RuntimeConfig" ADD COLUMN     "arkBotApiKey" TEXT,
ADD COLUMN     "arkBotBaseUrl" TEXT,
ADD COLUMN     "arkBotModel" TEXT,
ADD COLUMN     "replyLlmProvider" TEXT NOT NULL DEFAULT 'standard';
