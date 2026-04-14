-- CreateEnum
CREATE TYPE "PlatformType" AS ENUM ('worktool');
CREATE TYPE "OnlineStatus" AS ENUM ('online', 'offline', 'unknown');
CREATE TYPE "EventSourceType" AS ENUM ('callback', 'history_compensation', 'manual_replay');
CREATE TYPE "EventStatus" AS ENUM ('pending', 'processed', 'failed', 'duplicate');
CREATE TYPE "ChatType" AS ENUM ('group', 'private', 'system');
CREATE TYPE "MessageType" AS ENUM ('text', 'image', 'audio', 'file', 'system', 'unknown');
CREATE TYPE "KnowledgeType" AS ENUM ('faq', 'activity', 'project', 'talk', 'risk');
CREATE TYPE "RuleType" AS ENUM ('trigger', 'block', 'risk', 'proactive');
CREATE TYPE "RiskLevel" AS ENUM ('low', 'medium', 'high', 'blocked');
CREATE TYPE "SendStatus" AS ENUM ('pending', 'success', 'failed', 'cancelled');
CREATE TYPE "JobStatus" AS ENUM ('running', 'success', 'failed');

CREATE TABLE "Robot" (
  "id" TEXT PRIMARY KEY,
  "robotId" TEXT NOT NULL UNIQUE,
  "name" TEXT NOT NULL,
  "platform" "PlatformType" NOT NULL DEFAULT 'worktool',
  "callbackUrl" TEXT,
  "callbackEnabled" BOOLEAN NOT NULL DEFAULT false,
  "replyAll" BOOLEAN NOT NULL DEFAULT true,
  "onlineStatus" "OnlineStatus" NOT NULL DEFAULT 'unknown',
  "lastOnlineAt" TIMESTAMP(3),
  "lastHealthCheckAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "Group" (
  "id" TEXT PRIMARY KEY,
  "externalGroupId" TEXT,
  "title" TEXT NOT NULL,
  "city" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "autoReplyEnabled" BOOLEAN NOT NULL DEFAULT true,
  "proactiveEnabled" BOOLEAN NOT NULL DEFAULT true,
  "dailyProactiveLimit" INTEGER NOT NULL DEFAULT 10,
  "cooldownSeconds" INTEGER NOT NULL DEFAULT 180,
  "silenceThresholdSeconds" INTEGER NOT NULL DEFAULT 600,
  "maxRobotMessagesPerHour" INTEGER NOT NULL DEFAULT 8,
  "targetIdHint" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "GroupMember" (
  "id" TEXT PRIMARY KEY,
  "groupId" TEXT NOT NULL,
  "externalUserId" TEXT,
  "nickname" TEXT NOT NULL,
  "remark" TEXT,
  "isRobot" BOOLEAN NOT NULL DEFAULT false,
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "InboundEvent" (
  "id" TEXT PRIMARY KEY,
  "eventUid" TEXT NOT NULL UNIQUE,
  "robotId" TEXT NOT NULL,
  "rawPayload" JSONB NOT NULL,
  "sourceType" "EventSourceType" NOT NULL DEFAULT 'callback',
  "callbackReceivedAt" TIMESTAMP(3) NOT NULL,
  "processedAt" TIMESTAMP(3),
  "status" "EventStatus" NOT NULL DEFAULT 'pending',
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "InboundMessage" (
  "id" TEXT PRIMARY KEY,
  "eventId" TEXT NOT NULL,
  "robotId" TEXT NOT NULL,
  "groupId" TEXT,
  "senderId" TEXT,
  "senderName" TEXT,
  "chatType" "ChatType" NOT NULL,
  "messageType" "MessageType" NOT NULL,
  "messageText" TEXT,
  "messageTextNormalized" TEXT,
  "externalMessageId" TEXT,
  "replyToMessageId" TEXT,
  "sentAt" TIMESTAMP(3),
  "isFromRobot" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "ConversationState" (
  "id" TEXT PRIMARY KEY,
  "groupId" TEXT NOT NULL,
  "userId" TEXT,
  "recentSummary" TEXT,
  "lastUserMessageAt" TIMESTAMP(3),
  "lastHumanReplyAt" TIMESTAMP(3),
  "lastRobotReplyAt" TIMESTAMP(3),
  "lastIntent" TEXT,
  "leadScore" DECIMAL(6,2) NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "KnowledgeDocument" (
  "id" TEXT PRIMARY KEY,
  "title" TEXT NOT NULL,
  "type" "KnowledgeType" NOT NULL,
  "city" TEXT,
  "tags" JSONB NOT NULL,
  "content" TEXT NOT NULL,
  "embedding" JSONB,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "RuleConfig" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "groupId" TEXT,
  "type" "RuleType" NOT NULL,
  "priority" INTEGER NOT NULL DEFAULT 100,
  "config" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "ReplyDecision" (
  "id" TEXT PRIMARY KEY,
  "inboundMessageId" TEXT NOT NULL,
  "shouldReply" BOOLEAN NOT NULL,
  "score" DECIMAL(6,2) NOT NULL,
  "riskLevel" "RiskLevel" NOT NULL,
  "matchedRules" JSONB NOT NULL,
  "intent" TEXT,
  "reason" TEXT NOT NULL,
  "delayMs" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "OutboundMessage" (
  "id" TEXT PRIMARY KEY,
  "robotId" TEXT NOT NULL,
  "groupId" TEXT,
  "relatedInboundMessageId" TEXT,
  "content" TEXT NOT NULL,
  "targetTitle" TEXT NOT NULL,
  "sendStatus" "SendStatus" NOT NULL DEFAULT 'pending',
  "sendRequest" JSONB NOT NULL,
  "sendResponse" JSONB,
  "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "AuditLog" (
  "id" TEXT PRIMARY KEY,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "detail" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "JobRun" (
  "id" TEXT PRIMARY KEY,
  "jobName" TEXT NOT NULL,
  "status" "JobStatus" NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "finishedAt" TIMESTAMP(3),
  "detail" JSONB
);

CREATE INDEX "Robot_onlineStatus_updatedAt_idx" ON "Robot"("onlineStatus", "updatedAt");
CREATE INDEX "Group_enabled_autoReplyEnabled_idx" ON "Group"("enabled", "autoReplyEnabled");
CREATE INDEX "Group_city_idx" ON "Group"("city");
CREATE INDEX "GroupMember_groupId_idx" ON "GroupMember"("groupId");
CREATE INDEX "GroupMember_externalUserId_idx" ON "GroupMember"("externalUserId");
CREATE INDEX "InboundEvent_robotId_createdAt_idx" ON "InboundEvent"("robotId", "createdAt");
CREATE INDEX "InboundEvent_status_callbackReceivedAt_idx" ON "InboundEvent"("status", "callbackReceivedAt");
CREATE INDEX "InboundMessage_eventId_idx" ON "InboundMessage"("eventId");
CREATE INDEX "InboundMessage_robotId_createdAt_idx" ON "InboundMessage"("robotId", "createdAt");
CREATE INDEX "InboundMessage_groupId_createdAt_idx" ON "InboundMessage"("groupId", "createdAt");
CREATE INDEX "InboundMessage_externalMessageId_idx" ON "InboundMessage"("externalMessageId");
CREATE UNIQUE INDEX "ConversationState_groupId_userId_key" ON "ConversationState"("groupId", "userId");
CREATE INDEX "ConversationState_groupId_updatedAt_idx" ON "ConversationState"("groupId", "updatedAt");
CREATE INDEX "KnowledgeDocument_enabled_type_idx" ON "KnowledgeDocument"("enabled", "type");
CREATE INDEX "KnowledgeDocument_city_idx" ON "KnowledgeDocument"("city");
CREATE INDEX "RuleConfig_groupId_enabled_type_priority_idx" ON "RuleConfig"("groupId", "enabled", "type", "priority");
CREATE INDEX "ReplyDecision_inboundMessageId_createdAt_idx" ON "ReplyDecision"("inboundMessageId", "createdAt");
CREATE INDEX "OutboundMessage_robotId_createdAt_idx" ON "OutboundMessage"("robotId", "createdAt");
CREATE INDEX "OutboundMessage_groupId_createdAt_idx" ON "OutboundMessage"("groupId", "createdAt");
CREATE INDEX "OutboundMessage_sendStatus_createdAt_idx" ON "OutboundMessage"("sendStatus", "createdAt");
CREATE INDEX "AuditLog_entityType_entityId_createdAt_idx" ON "AuditLog"("entityType", "entityId", "createdAt");
CREATE INDEX "JobRun_jobName_startedAt_idx" ON "JobRun"("jobName", "startedAt");

ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InboundEvent" ADD CONSTRAINT "InboundEvent_robotId_fkey" FOREIGN KEY ("robotId") REFERENCES "Robot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InboundMessage" ADD CONSTRAINT "InboundMessage_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "InboundEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InboundMessage" ADD CONSTRAINT "InboundMessage_robotId_fkey" FOREIGN KEY ("robotId") REFERENCES "Robot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InboundMessage" ADD CONSTRAINT "InboundMessage_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ConversationState" ADD CONSTRAINT "ConversationState_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RuleConfig" ADD CONSTRAINT "RuleConfig_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReplyDecision" ADD CONSTRAINT "ReplyDecision_inboundMessageId_fkey" FOREIGN KEY ("inboundMessageId") REFERENCES "InboundMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_robotId_fkey" FOREIGN KEY ("robotId") REFERENCES "Robot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE SET NULL ON UPDATE CASCADE;
