-- Admin / auto-reply V1 schema

CREATE TYPE "RetrievalMode" AS ENUM ('off', 'keyword_first', 'vector_first', 'hybrid');
CREATE TYPE "CannedMatchType" AS ENUM ('contains', 'exact', 'regex');
CREATE TYPE "CannedScopeType" AS ENUM ('global', 'group');
CREATE TYPE "ReplyTraceStatus" AS ENUM ('pending', 'completed', 'skipped_risk', 'skipped_policy', 'skipped_no_reply', 'failed');

CREATE TABLE "KnowledgeCollection" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeCollection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReplyProfile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "systemPrompt" TEXT NOT NULL,
    "stylePrompt" TEXT,
    "language" TEXT NOT NULL DEFAULT 'zh-CN',
    "maxChars" INTEGER NOT NULL DEFAULT 120,
    "emojiPolicy" TEXT NOT NULL DEFAULT 'allow_limited',
    "mentionPolicy" TEXT NOT NULL DEFAULT 'avoid_unless_needed',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReplyProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RuntimeConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "llmBaseUrl" TEXT,
    "llmApiKey" TEXT,
    "llmModel" TEXT,
    "embeddingBaseUrl" TEXT,
    "embeddingApiKey" TEXT,
    "embeddingModel" TEXT,
    "defaultLanguage" TEXT NOT NULL DEFAULT 'zh-CN',
    "defaultReplyProfileId" TEXT,
    "retrievalMode" "RetrievalMode" NOT NULL DEFAULT 'keyword_first',
    "knowledgeFirst" BOOLEAN NOT NULL DEFAULT true,
    "allowLlmFallback" BOOLEAN NOT NULL DEFAULT true,
    "maxReplyChars" INTEGER NOT NULL DEFAULT 120,
    "defaultStyleHint" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RuntimeConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RuntimeConfig_defaultReplyProfileId_key" ON "RuntimeConfig"("defaultReplyProfileId");

CREATE TABLE "GroupReplyPolicy" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "autoReplyEnabled" BOOLEAN NOT NULL DEFAULT true,
    "replyProfileId" TEXT,
    "knowledgeCollectionId" TEXT,
    "retrievalMode" "RetrievalMode" NOT NULL DEFAULT 'keyword_first',
    "knowledgeFirst" BOOLEAN NOT NULL DEFAULT true,
    "cannedFirst" BOOLEAN NOT NULL DEFAULT true,
    "scoreThreshold" INTEGER,
    "cooldownSeconds" INTEGER,
    "riskInterceptEnabled" BOOLEAN NOT NULL DEFAULT true,
    "humanTakeover" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupReplyPolicy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CannedReplyRule" (
    "id" TEXT NOT NULL,
    "scopeType" "CannedScopeType" NOT NULL,
    "groupId" TEXT,
    "keyword" TEXT NOT NULL,
    "matchType" "CannedMatchType" NOT NULL DEFAULT 'contains',
    "replyText" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CannedReplyRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReplyTrace" (
    "id" TEXT NOT NULL,
    "inboundMessageId" TEXT NOT NULL,
    "groupId" TEXT,
    "status" "ReplyTraceStatus" NOT NULL DEFAULT 'pending',
    "normalizedText" TEXT,
    "decisionSnapshot" JSONB,
    "matchedCannedRuleId" TEXT,
    "matchedKnowledgeIds" JSONB,
    "replyProfileId" TEXT,
    "retrievalMode" TEXT,
    "knowledgeSnippets" JSONB,
    "promptPreview" TEXT,
    "llmResponsePreview" TEXT,
    "finalReply" TEXT,
    "replySource" TEXT,
    "outboundMessageId" TEXT,
    "executorTaskId" TEXT,
    "androidResult" JSONB,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReplyTrace_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "KnowledgeDocument" ADD COLUMN "collectionId" TEXT,
ADD COLUMN "source" TEXT;

CREATE TABLE "KnowledgeChunk" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "embedding" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GroupReplyPolicy_groupId_key" ON "GroupReplyPolicy"("groupId");

CREATE INDEX "KnowledgeDocument_collectionId_idx" ON "KnowledgeDocument"("collectionId");
CREATE INDEX "KnowledgeChunk_documentId_idx" ON "KnowledgeChunk"("documentId");
CREATE INDEX "KnowledgeChunk_enabled_idx" ON "KnowledgeChunk"("enabled");
CREATE INDEX "CannedReplyRule_enabled_scopeType_priority_idx" ON "CannedReplyRule"("enabled", "scopeType", "priority");
CREATE INDEX "CannedReplyRule_groupId_idx" ON "CannedReplyRule"("groupId");
CREATE INDEX "ReplyTrace_inboundMessageId_createdAt_idx" ON "ReplyTrace"("inboundMessageId", "createdAt");
CREATE INDEX "ReplyTrace_groupId_createdAt_idx" ON "ReplyTrace"("groupId", "createdAt");
CREATE INDEX "ReplyTrace_status_idx" ON "ReplyTrace"("status");

ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "KnowledgeCollection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "KnowledgeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RuntimeConfig" ADD CONSTRAINT "RuntimeConfig_defaultReplyProfileId_fkey" FOREIGN KEY ("defaultReplyProfileId") REFERENCES "ReplyProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "GroupReplyPolicy" ADD CONSTRAINT "GroupReplyPolicy_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GroupReplyPolicy" ADD CONSTRAINT "GroupReplyPolicy_replyProfileId_fkey" FOREIGN KEY ("replyProfileId") REFERENCES "ReplyProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GroupReplyPolicy" ADD CONSTRAINT "GroupReplyPolicy_knowledgeCollectionId_fkey" FOREIGN KEY ("knowledgeCollectionId") REFERENCES "KnowledgeCollection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CannedReplyRule" ADD CONSTRAINT "CannedReplyRule_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReplyTrace" ADD CONSTRAINT "ReplyTrace_inboundMessageId_fkey" FOREIGN KEY ("inboundMessageId") REFERENCES "InboundMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "RuntimeConfig" ("id", "defaultLanguage", "retrievalMode", "knowledgeFirst", "allowLlmFallback", "maxReplyChars", "updatedAt")
VALUES ('singleton', 'zh-CN', 'keyword_first', true, true, 120, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
