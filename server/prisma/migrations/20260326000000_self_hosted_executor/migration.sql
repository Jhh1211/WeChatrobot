-- PlatformType: avoid ADD VALUE + use in same txn (PostgreSQL unsafe). Rebuild enum.
ALTER TABLE "Robot" ALTER COLUMN "platform" DROP DEFAULT;
ALTER TABLE "Robot" ALTER COLUMN "platform" TYPE TEXT USING "platform"::TEXT;
ALTER TYPE "PlatformType" RENAME TO "PlatformType_old";
CREATE TYPE "PlatformType" AS ENUM ('worktool', 'self_hosted');
ALTER TABLE "Robot" ALTER COLUMN "platform" TYPE "PlatformType" USING "platform"::"PlatformType";
ALTER TABLE "Robot" ALTER COLUMN "platform" SET DEFAULT 'self_hosted'::"PlatformType";
DROP TYPE "PlatformType_old";

-- EventSourceType: rebuild to add android_accessibility
ALTER TABLE "InboundEvent" ALTER COLUMN "sourceType" DROP DEFAULT;
ALTER TABLE "InboundEvent" ALTER COLUMN "sourceType" TYPE TEXT USING "sourceType"::TEXT;
ALTER TYPE "EventSourceType" RENAME TO "EventSourceType_old";
CREATE TYPE "EventSourceType" AS ENUM ('callback', 'history_compensation', 'manual_replay', 'android_accessibility');
ALTER TABLE "InboundEvent" ALTER COLUMN "sourceType" TYPE "EventSourceType" USING "sourceType"::"EventSourceType";
ALTER TABLE "InboundEvent" ALTER COLUMN "sourceType" SET DEFAULT 'callback'::"EventSourceType";
DROP TYPE "EventSourceType_old";

-- SendStatus: rebuild to add pending_executor
ALTER TABLE "OutboundMessage" ALTER COLUMN "sendStatus" DROP DEFAULT;
ALTER TABLE "OutboundMessage" ALTER COLUMN "sendStatus" TYPE TEXT USING "sendStatus"::TEXT;
ALTER TYPE "SendStatus" RENAME TO "SendStatus_old";
CREATE TYPE "SendStatus" AS ENUM ('pending', 'pending_executor', 'success', 'failed', 'cancelled');
ALTER TABLE "OutboundMessage" ALTER COLUMN "sendStatus" TYPE "SendStatus" USING "sendStatus"::"SendStatus";
ALTER TABLE "OutboundMessage" ALTER COLUMN "sendStatus" SET DEFAULT 'pending'::"SendStatus";
DROP TYPE "SendStatus_old";

CREATE TYPE "DevicePlatform" AS ENUM ('android');
CREATE TYPE "DeviceRuntimeStatus" AS ENUM ('online', 'offline');
CREATE TYPE "ExecutorTaskType" AS ENUM ('send_text');
CREATE TYPE "ExecutorTaskStatus" AS ENUM ('pending', 'claimed', 'running', 'success', 'failed', 'cancelled');
CREATE TYPE "ExecutorAttemptStatus" AS ENUM ('running', 'success', 'failed');

CREATE TABLE "Device" (
  "id" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "robotId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "platform" "DevicePlatform" NOT NULL DEFAULT 'android',
  "appVersion" TEXT,
  "deviceModel" TEXT,
  "androidVersion" TEXT,
  "status" "DeviceRuntimeStatus" NOT NULL DEFAULT 'offline',
  "lastSeenAt" TIMESTAMP(3),
  "capability" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Device_deviceId_key" ON "Device"("deviceId");
CREATE INDEX "Device_robotId_status_idx" ON "Device"("robotId", "status");
CREATE INDEX "Device_lastSeenAt_idx" ON "Device"("lastSeenAt");

ALTER TABLE "Device" ADD CONSTRAINT "Device_robotId_fkey" FOREIGN KEY ("robotId") REFERENCES "Robot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ExecutorTask" (
  "id" TEXT NOT NULL,
  "taskUid" TEXT NOT NULL,
  "robotId" TEXT NOT NULL,
  "deviceId" TEXT,
  "type" "ExecutorTaskType" NOT NULL,
  "status" "ExecutorTaskStatus" NOT NULL DEFAULT 'pending',
  "priority" INTEGER NOT NULL DEFAULT 0,
  "targetChatTitle" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "relatedInboundMessageId" TEXT,
  "outboundMessageId" TEXT,
  "claimedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "errorMessage" TEXT,
  "retryCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ExecutorTask_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExecutorTask_taskUid_key" ON "ExecutorTask"("taskUid");
CREATE UNIQUE INDEX "ExecutorTask_outboundMessageId_key" ON "ExecutorTask"("outboundMessageId");
CREATE INDEX "ExecutorTask_robotId_status_priority_createdAt_idx" ON "ExecutorTask"("robotId", "status", "priority" DESC, "createdAt");
CREATE INDEX "ExecutorTask_status_createdAt_idx" ON "ExecutorTask"("status", "createdAt");

ALTER TABLE "ExecutorTask" ADD CONSTRAINT "ExecutorTask_robotId_fkey" FOREIGN KEY ("robotId") REFERENCES "Robot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExecutorTask" ADD CONSTRAINT "ExecutorTask_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ExecutorTask" ADD CONSTRAINT "ExecutorTask_outboundMessageId_fkey" FOREIGN KEY ("outboundMessageId") REFERENCES "OutboundMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ExecutorTaskAttempt" (
  "id" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  "status" "ExecutorAttemptStatus" NOT NULL,
  "requestPayload" JSONB,
  "responsePayload" JSONB,
  "errorMessage" TEXT,
  CONSTRAINT "ExecutorTaskAttempt_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ExecutorTaskAttempt_taskId_idx" ON "ExecutorTaskAttempt"("taskId");
CREATE INDEX "ExecutorTaskAttempt_deviceId_idx" ON "ExecutorTaskAttempt"("deviceId");

ALTER TABLE "ExecutorTaskAttempt" ADD CONSTRAINT "ExecutorTaskAttempt_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ExecutorTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExecutorTaskAttempt" ADD CONSTRAINT "ExecutorTaskAttempt_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "DeviceHeartbeat" (
  "id" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "detail" JSONB,
  CONSTRAINT "DeviceHeartbeat_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DeviceHeartbeat_deviceId_receivedAt_idx" ON "DeviceHeartbeat"("deviceId", "receivedAt");

ALTER TABLE "DeviceHeartbeat" ADD CONSTRAINT "DeviceHeartbeat_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
