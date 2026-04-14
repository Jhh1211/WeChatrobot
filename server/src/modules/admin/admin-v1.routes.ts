import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import axios from "axios";
import { z } from "zod";
import { prisma } from "../../common/config/prisma.js";
import { env } from "../../common/config/env.js";
import {
  DEFAULT_ARK_BOT_BASE_URL,
  getRuntimeConfigForAdminApi,
  updateRuntimeConfig,
  getEffectiveRuntimeConfig,
  getEffectiveRuntimeConfigWithSources,
  normalizeAdminApiKeyInput,
  volcengineRoutingHint
} from "../config/runtime-config.service.js";
import { generateLlmReplyJson } from "../../integrations/llm/llm.runtime.js";
import { embedText } from "../../integrations/embeddings/embeddings.client.js";
import { retrieveChunks } from "../knowledge/knowledge-chunk.service.js";
import { reindexKnowledgeDocument } from "../knowledge/knowledge-chunk.service.js";
import { previewReplyPipeline } from "../reply/reply-pipeline.service.js";
import { adminCreateTestSendTask } from "../executor/executor.service.js";
import type { CannedMatchType, CannedScopeType, ReplyTraceStatus, RetrievalMode } from "@prisma/client";

const pagination = z.object({
  page: z.coerce.number().default(1),
  pageSize: z.coerce.number().default(20)
});

const UPSTREAM_BODY_MAX = 2000;

function csvEscapeCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  const n = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (/[",\n]/.test(n)) return `"${n.replace(/"/g, '""')}"`;
  return n;
}

function formatAxiosLikeUpstreamError(err: unknown) {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status ?? null;
    const d = err.response?.data;
    let upstreamBody = "";
    try {
      upstreamBody = typeof d === "string" ? d : JSON.stringify(d);
    } catch {
      upstreamBody = String(d);
    }
    if (upstreamBody.length > UPSTREAM_BODY_MAX) {
      upstreamBody = upstreamBody.slice(0, UPSTREAM_BODY_MAX) + "...(truncated)";
    }
    return {
      upstreamStatus: status,
      upstreamMessage: err.message,
      upstreamBody,
      requestMethod: err.config?.method ?? null,
      requestUrl: err.config?.url ?? null,
      requestBaseURL: err.config?.baseURL ?? null
    };
  }
  return {
    upstreamStatus: null,
    upstreamMessage: String(err),
    upstreamBody: "",
    requestMethod: null,
    requestUrl: null,
    requestBaseURL: null
  };
}

export async function registerAdminV1Routes(app: FastifyInstance): Promise<void> {
  app.get("/api/admin/config/runtime", async () => {
    const data = await getRuntimeConfigForAdminApi();
    return { success: true, data, error: null };
  });

  app.put("/api/admin/config/runtime", async (request) => {
    const body = z
      .object({
        llmBaseUrl: z.string().nullable().optional(),
        llmApiKey: z.string().optional(),
        llmModel: z.string().nullable().optional(),
        embeddingBaseUrl: z.string().nullable().optional(),
        embeddingApiKey: z.string().optional(),
        embeddingModel: z.string().nullable().optional(),
        defaultLanguage: z.string().nullable().optional(),
        defaultReplyProfileId: z.string().nullable().optional(),
        retrievalMode: z.enum(["off", "keyword_first", "vector_first", "hybrid"]).optional(),
        knowledgeFirst: z.boolean().optional(),
        allowLlmFallback: z.boolean().optional(),
        maxReplyChars: z.number().optional(),
        defaultStyleHint: z.string().nullable().optional(),
        replyLlmProvider: z.enum(["standard", "ark_bot"]).optional(),
        arkBotBaseUrl: z.string().nullable().optional(),
        arkBotModel: z.string().nullable().optional(),
        arkBotApiKey: z.string().optional()
      })
      .parse(request.body);
    const patch: Parameters<typeof updateRuntimeConfig>[0] = { ...body };
    if (body.llmApiKey !== undefined) {
      const n = normalizeAdminApiKeyInput(body.llmApiKey);
      patch.llmApiKey = n === "__keep__" ? "__keep__" : n;
    } else {
      delete patch.llmApiKey;
    }
    if (body.arkBotApiKey !== undefined) {
      const n = normalizeAdminApiKeyInput(body.arkBotApiKey);
      patch.arkBotApiKey = n === "__keep__" ? "__keep__" : n;
    } else {
      delete patch.arkBotApiKey;
    }
    if (body.embeddingApiKey !== undefined) {
      const n = normalizeAdminApiKeyInput(body.embeddingApiKey);
      patch.embeddingApiKey = n === "__keep__" ? "__keep__" : n;
    } else {
      delete patch.embeddingApiKey;
    }
    await updateRuntimeConfig(patch);
    const data = await getRuntimeConfigForAdminApi();
    return { success: true, data, error: null };
  });

  app.post("/api/admin/config/test-llm", async (request) => {
    const { config, sources } = await getEffectiveRuntimeConfigWithSources();
    request.log.info({
      msg: "admin_test_llm_resolved",
      resolvedLlmBaseUrl: config.llmBaseUrl,
      resolvedLlmModel: config.llmModel,
      resolvedHasLlmApiKey: Boolean(config.llmApiKey?.trim()),
      llmApiKeySource: sources.llmApiKey,
      llmBaseUrlSource: sources.llmBaseUrl,
      llmModelSource: sources.llmModel
    });

    const hint = volcengineRoutingHint(config.llmBaseUrl, config.llmModel);
    const resolvedPayload = {
      resolvedBaseUrl: config.llmBaseUrl,
      resolvedModel: config.llmModel,
      resolvedHasKey: Boolean(config.llmApiKey?.trim()),
      llmApiKeySource: sources.llmApiKey,
      llmBaseUrlSource: sources.llmBaseUrl,
      llmModelSource: sources.llmModel,
      volcengineRoutingHint: hint
    };

    if (!config.llmApiKey?.trim()) {
      return {
        success: false,
        data: resolvedPayload,
        error: {
          code: "NO_LLM_KEY",
          message: "有效配置中缺少 LLM API Key（数据库与环境变量均未提供可用密钥）"
        }
      };
    }

    try {
      const r = await generateLlmReplyJson(
        { baseUrl: config.llmBaseUrl, apiKey: config.llmApiKey, model: config.llmModel },
        {
          systemPrompt: "只输出 JSON。",
          userPrompt: '输出 {"should_reply":true,"reply_text":"pong","intent":"test","confidence":1,"risk_level":"low","style":"faq_assistant"}'
        }
      );
      return {
        success: true,
        data: { ok: true, sample: r.reply_text?.slice(0, 80), ...resolvedPayload },
        error: null
      };
    } catch (e) {
      const up = formatAxiosLikeUpstreamError(e);
      return {
        success: false,
        data: { ...resolvedPayload, ...up },
        error: {
          code: "LLM_TEST_FAIL",
          message: up.upstreamMessage,
          upstreamStatus: up.upstreamStatus,
          upstreamBody: up.upstreamBody
        }
      };
    }
  });

  app.post("/api/admin/config/test-ark-bot", async (request) => {
    const { config, sources } = await getEffectiveRuntimeConfigWithSources();
    const base = (config.arkBotBaseUrl || DEFAULT_ARK_BOT_BASE_URL).replace(/\/$/, "");
    const model = config.arkBotModel?.trim() ?? "";
    const key = config.arkBotApiKey?.trim() ?? "";
    const resolvedPayload = {
      resolvedBaseUrl: base,
      resolvedModel: model || null,
      resolvedHasKey: Boolean(key),
      arkBotApiKeySource: sources.arkBotApiKey,
      arkBotBaseUrlSource: sources.arkBotBaseUrl,
      arkBotModelSource: sources.arkBotModel
    };
    if (!model || !key) {
      return {
        success: false,
        data: resolvedPayload,
        error: {
          code: "ARK_BOT_INCOMPLETE",
          message: "请配置联网 Bot 的 Model（控制台 bot- 开头 ID）与 Ark API Key；未单独配置时会尝试使用 LLM API Key"
        }
      };
    }
    try {
      const r = await generateLlmReplyJson(
        { baseUrl: base, apiKey: key, model },
        {
          systemPrompt: "只输出 JSON，不要其它说明。",
          userPrompt:
            '输出 {"should_reply":true,"reply_text":"方舟联网 Bot 连通成功","intent":"test","confidence":1,"risk_level":"low","style":"faq_assistant"}'
        }
      );
      return {
        success: true,
        data: { ok: true, sample: r.reply_text?.slice(0, 120), ...resolvedPayload },
        error: null
      };
    } catch (e) {
      const up = formatAxiosLikeUpstreamError(e);
      return {
        success: false,
        data: { ...resolvedPayload, ...up },
        error: {
          code: "ARK_BOT_TEST_FAIL",
          message: up.upstreamMessage,
          upstreamStatus: up.upstreamStatus,
          upstreamBody: up.upstreamBody
        }
      };
    }
  });

  app.post("/api/admin/config/test-embedding", async (request) => {
    const { config, sources } = await getEffectiveRuntimeConfigWithSources();
    request.log.info({
      msg: "admin_test_embedding_resolved",
      resolvedEmbeddingBaseUrl: config.embeddingBaseUrl,
      resolvedEmbeddingModel: config.embeddingModel,
      resolvedHasEmbeddingApiKey: Boolean(config.embeddingApiKey?.trim()),
      embeddingApiKeySource: sources.embeddingApiKey
    });

    const resolvedPayload = {
      resolvedBaseUrl: config.embeddingBaseUrl,
      resolvedModel: config.embeddingModel,
      resolvedHasKey: Boolean(config.embeddingApiKey?.trim()),
      embeddingApiKeySource: sources.embeddingApiKey,
      embeddingBaseUrlSource: sources.embeddingBaseUrl,
      embeddingModelSource: sources.embeddingModel
    };

    if (!config.embeddingApiKey?.trim() || !config.embeddingModel?.trim()) {
      return {
        success: false,
        data: resolvedPayload,
        error: {
          code: "NO_EMBEDDING_CFG",
          message: "有效配置中缺少 Embedding API Key 或 Model"
        }
      };
    }
    try {
      const v = await embedText(
        { baseUrl: config.embeddingBaseUrl, apiKey: config.embeddingApiKey, model: config.embeddingModel },
        "connectivity test 中文"
      );
      return {
        success: true,
        data: { ok: true, dimensions: v.length, ...resolvedPayload },
        error: null
      };
    } catch (e) {
      const up = formatAxiosLikeUpstreamError(e);
      return {
        success: false,
        data: { ...resolvedPayload, ...up },
        error: {
          code: "EMB_TEST_FAIL",
          message: up.upstreamMessage,
          upstreamStatus: up.upstreamStatus,
          upstreamBody: up.upstreamBody
        }
      };
    }
  });

  app.get("/api/admin/reply-profiles", async () => {
    const items = await prisma.replyProfile.findMany({ orderBy: { updatedAt: "desc" } });
    return { success: true, data: { items }, error: null };
  });

  app.post("/api/admin/reply-profiles", async (request) => {
    const body = z
      .object({
        name: z.string().min(1),
        systemPrompt: z.string().min(1),
        stylePrompt: z.string().optional(),
        language: z.string().default("zh-CN"),
        maxChars: z.number().default(120),
        emojiPolicy: z.string().optional(),
        mentionPolicy: z.string().optional(),
        enabled: z.boolean().default(true)
      })
      .parse(request.body);
    const data = await prisma.replyProfile.create({ data: body });
    return { success: true, data, error: null };
  });

  app.get("/api/admin/reply-profiles/:id", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const data = await prisma.replyProfile.findUnique({ where: { id } });
    if (!data) return { success: false, data: null, error: { code: "NOT_FOUND", message: "profile" } };
    return { success: true, data, error: null };
  });

  app.put("/api/admin/reply-profiles/:id", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.record(z.any()).parse(request.body);
    const data = await prisma.replyProfile.update({ where: { id }, data: body });
    return { success: true, data, error: null };
  });

  app.delete("/api/admin/reply-profiles/:id", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await prisma.replyProfile.delete({ where: { id } });
    return { success: true, data: { deleted: true }, error: null };
  });

  app.get("/api/admin/knowledge/collections", async () => {
    const items = await prisma.knowledgeCollection.findMany({ orderBy: { updatedAt: "desc" } });
    return { success: true, data: { items }, error: null };
  });

  app.post("/api/admin/knowledge/collections", async (request) => {
    const body = z.object({ name: z.string().min(1), description: z.string().optional(), enabled: z.boolean().default(true) }).parse(request.body);
    const data = await prisma.knowledgeCollection.create({ data: body });
    return { success: true, data, error: null };
  });

  app.put("/api/admin/knowledge/collections/:id", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.record(z.any()).parse(request.body);
    const data = await prisma.knowledgeCollection.update({ where: { id }, data: body });
    return { success: true, data, error: null };
  });

  app.delete("/api/admin/knowledge/collections/:id", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await prisma.knowledgeCollection.delete({ where: { id } });
    return { success: true, data: { deleted: true }, error: null };
  });

  app.get("/api/admin/knowledge/documents", async (request) => {
    const q = pagination.extend({ collectionId: z.string().optional() }).parse(request.query);
    const where = q.collectionId ? { collectionId: q.collectionId } : {};
    const [items, total] = await Promise.all([
      prisma.knowledgeDocument.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize
      }),
      prisma.knowledgeDocument.count({ where })
    ]);
    return { success: true, data: { items, total, page: q.page, pageSize: q.pageSize }, error: null };
  });

  app.post("/api/admin/knowledge/documents", async (request) => {
    const body = z
      .object({
        title: z.string().min(1),
        type: z.enum(["faq", "activity", "project", "talk", "risk"]),
        city: z.string().optional(),
        tags: z.array(z.string()).optional(),
        content: z.string().min(1),
        collectionId: z.string().optional(),
        source: z.string().optional(),
        enabled: z.boolean().default(true)
      })
      .parse(request.body);
    const data = await prisma.knowledgeDocument.create({
      data: {
        title: body.title,
        type: body.type,
        city: body.city,
        tags: body.tags ?? [],
        content: body.content,
        collectionId: body.collectionId,
        source: body.source,
        enabled: body.enabled
      }
    });
    return { success: true, data, error: null };
  });

  app.put("/api/admin/knowledge/documents/:id", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.record(z.any()).parse(request.body);
    const data = await prisma.knowledgeDocument.update({ where: { id }, data: body });
    return { success: true, data, error: null };
  });

  app.delete("/api/admin/knowledge/documents/:id", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await prisma.knowledgeChunk.deleteMany({ where: { documentId: id } });
    await prisma.knowledgeDocument.delete({ where: { id } });
    return { success: true, data: { deleted: true }, error: null };
  });

  app.post("/api/admin/knowledge/documents/:id/reindex", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const rt = await getEffectiveRuntimeConfig();
    const embedCfg =
      rt.embeddingApiKey && rt.embeddingModel
        ? { baseUrl: rt.embeddingBaseUrl, apiKey: rt.embeddingApiKey, model: rt.embeddingModel }
        : null;
    const { chunkCount } = await reindexKnowledgeDocument(id, embedCfg);
    return { success: true, data: { chunkCount }, error: null };
  });

  app.post("/api/admin/knowledge/retrieval-preview", async (request) => {
    const body = z
      .object({
        query: z.string(),
        collectionId: z.string().optional(),
        mode: z.enum(["off", "keyword_first", "vector_first", "hybrid"]).default("hybrid"),
        topK: z.number().default(8)
      })
      .parse(request.body);
    const rt = await getEffectiveRuntimeConfig();
    const embedCfg =
      rt.embeddingApiKey && rt.embeddingModel
        ? { baseUrl: rt.embeddingBaseUrl, apiKey: rt.embeddingApiKey, model: rt.embeddingModel }
        : null;
    const chunks = await retrieveChunks({
      collectionId: body.collectionId ?? null,
      queryText: body.query,
      mode: body.mode as RetrievalMode,
      topK: body.topK,
      embedConfig: embedCfg
    });
    return { success: true, data: { chunks }, error: null };
  });

  app.get("/api/admin/group-policies", async () => {
    const items = await prisma.groupReplyPolicy.findMany({
      include: { group: true, replyProfile: true, knowledgeCollection: true }
    });
    return { success: true, data: { items }, error: null };
  });

  app.post("/api/admin/group-policies", async (request) => {
    const body = z
      .object({
        groupId: z.string().min(1),
        autoReplyEnabled: z.boolean().optional(),
        replyProfileId: z.string().nullable().optional(),
        knowledgeCollectionId: z.string().nullable().optional(),
        retrievalMode: z.enum(["off", "keyword_first", "vector_first", "hybrid"]).optional(),
        knowledgeFirst: z.boolean().optional(),
        cannedFirst: z.boolean().optional(),
        scoreThreshold: z.number().nullable().optional(),
        cooldownSeconds: z.number().nullable().optional(),
        riskInterceptEnabled: z.boolean().optional(),
        humanTakeover: z.boolean().optional(),
        enabled: z.boolean().optional(),
        replyLlmProvider: z.enum(["standard", "ark_bot"]).nullable().optional(),
        sameSenderContextEnabled: z.boolean().optional(),
        sameSenderContextWindowMinutes: z.number().int().min(1).max(120).optional(),
        sameSenderContextMaxUserMessages: z.number().int().min(1).max(30).optional(),
        sameSenderContextMaxBotMessages: z.number().int().min(0).max(20).optional(),
        sameSenderContextMaxTotalChars: z.number().int().min(500).max(30000).optional()
      })
      .parse(request.body);
    const data = await prisma.groupReplyPolicy.upsert({
      where: { groupId: body.groupId },
      create: {
        groupId: body.groupId,
        autoReplyEnabled: body.autoReplyEnabled ?? true,
        replyProfileId: body.replyProfileId ?? undefined,
        knowledgeCollectionId: body.knowledgeCollectionId ?? undefined,
        retrievalMode: (body.retrievalMode ?? "keyword_first") as RetrievalMode,
        knowledgeFirst: body.knowledgeFirst ?? true,
        cannedFirst: body.cannedFirst ?? true,
        scoreThreshold: body.scoreThreshold ?? undefined,
        cooldownSeconds: body.cooldownSeconds ?? undefined,
        riskInterceptEnabled: body.riskInterceptEnabled ?? true,
        humanTakeover: body.humanTakeover ?? false,
        enabled: body.enabled ?? true,
        replyLlmProvider:
          body.replyLlmProvider === undefined ? undefined : body.replyLlmProvider,
        sameSenderContextEnabled: body.sameSenderContextEnabled ?? true,
        sameSenderContextWindowMinutes: body.sameSenderContextWindowMinutes ?? 5,
        sameSenderContextMaxUserMessages: body.sameSenderContextMaxUserMessages ?? 8,
        sameSenderContextMaxBotMessages: body.sameSenderContextMaxBotMessages ?? 5,
        sameSenderContextMaxTotalChars: body.sameSenderContextMaxTotalChars ?? 3500
      },
      update: {
        autoReplyEnabled: body.autoReplyEnabled,
        replyProfileId: body.replyProfileId === null ? null : body.replyProfileId,
        knowledgeCollectionId: body.knowledgeCollectionId === null ? null : body.knowledgeCollectionId,
        retrievalMode: body.retrievalMode as RetrievalMode | undefined,
        knowledgeFirst: body.knowledgeFirst,
        cannedFirst: body.cannedFirst,
        scoreThreshold: body.scoreThreshold,
        cooldownSeconds: body.cooldownSeconds,
        riskInterceptEnabled: body.riskInterceptEnabled,
        humanTakeover: body.humanTakeover,
        enabled: body.enabled,
        replyLlmProvider:
          body.replyLlmProvider === undefined ? undefined : body.replyLlmProvider,
        sameSenderContextEnabled: body.sameSenderContextEnabled,
        sameSenderContextWindowMinutes: body.sameSenderContextWindowMinutes,
        sameSenderContextMaxUserMessages: body.sameSenderContextMaxUserMessages,
        sameSenderContextMaxBotMessages: body.sameSenderContextMaxBotMessages,
        sameSenderContextMaxTotalChars: body.sameSenderContextMaxTotalChars
      }
    });
    return { success: true, data, error: null };
  });

  app.get("/api/admin/group-policies/:id", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const data = await prisma.groupReplyPolicy.findUnique({
      where: { id },
      include: { group: true, replyProfile: true, knowledgeCollection: true }
    });
    if (!data) return { success: false, data: null, error: { code: "NOT_FOUND", message: "policy" } };
    return { success: true, data, error: null };
  });

  app.put("/api/admin/group-policies/:id", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.record(z.any()).parse(request.body);
    const data = await prisma.groupReplyPolicy.update({ where: { id }, data: body });
    return { success: true, data, error: null };
  });

  app.delete("/api/admin/group-policies/:id", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await prisma.groupReplyPolicy.delete({ where: { id } });
    return { success: true, data: { deleted: true }, error: null };
  });

  app.get("/api/admin/canned-rules", async () => {
    const items = await prisma.cannedReplyRule.findMany({ orderBy: [{ priority: "asc" }, { createdAt: "asc" }] });
    return { success: true, data: { items }, error: null };
  });

  app.post("/api/admin/canned-rules", async (request) => {
    const body = z
      .object({
        scopeType: z.enum(["global", "group"]),
        groupId: z.string().optional(),
        keyword: z.string().min(1),
        matchType: z.enum(["contains", "exact", "regex"]).default("contains"),
        replyText: z.string().min(1),
        priority: z.number().default(100),
        enabled: z.boolean().default(true)
      })
      .parse(request.body);
    if (body.scopeType === "group" && !body.groupId) {
      return { success: false, data: null, error: { code: "INVALID", message: "groupId required for group scope" } };
    }
    const data = await prisma.cannedReplyRule.create({
      data: {
        scopeType: body.scopeType as CannedScopeType,
        groupId: body.scopeType === "group" ? body.groupId! : null,
        keyword: body.keyword,
        matchType: body.matchType as CannedMatchType,
        replyText: body.replyText,
        priority: body.priority,
        enabled: body.enabled
      }
    });
    return { success: true, data, error: null };
  });

  app.put("/api/admin/canned-rules/:id", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.record(z.any()).parse(request.body);
    const data = await prisma.cannedReplyRule.update({ where: { id }, data: body });
    return { success: true, data, error: null };
  });

  app.delete("/api/admin/canned-rules/:id", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await prisma.cannedReplyRule.delete({ where: { id } });
    return { success: true, data: { deleted: true }, error: null };
  });

  app.get("/api/admin/reply-traces", async (request) => {
    const q = pagination
      .extend({
        groupId: z.string().optional(),
        status: z.string().optional(),
        senderKey: z.string().optional()
      })
      .parse(request.query);
    const where: Prisma.ReplyTraceWhereInput = {};
    if (q.groupId) where.groupId = q.groupId;
    if (q.status) where.status = q.status as ReplyTraceStatus;
    const sk = q.senderKey?.trim();
    if (sk) {
      where.sameSenderContextSenderKey = { contains: sk, mode: "insensitive" };
    }
    const [items, total] = await Promise.all([
      prisma.replyTrace.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: { inboundMessage: true }
      }),
      prisma.replyTrace.count({ where })
    ]);
    return { success: true, data: { items, total, page: q.page, pageSize: q.pageSize }, error: null };
  });

  /** 复盘导出：用户原话、合并上下文、机器人回复、决策快照摘要（UTF-8 CSV，Excel 可打开） */
  app.get("/api/admin/reply-traces/export.csv", async (request, reply) => {
    const q = z
      .object({
        from: z.string().optional(),
        to: z.string().optional(),
        groupId: z.string().optional(),
        senderKey: z.string().optional(),
        onlyWithReply: z.string().optional(),
        limit: z.coerce.number().min(1).max(20_000).default(8000)
      })
      .parse(request.query);

    const onlyWithReply = ["1", "true", "yes"].includes((q.onlyWithReply || "").toLowerCase());
    const from = q.from ? new Date(q.from) : undefined;
    const to = q.to ? new Date(q.to) : undefined;

    const where: Prisma.ReplyTraceWhereInput = {};
    if (q.groupId) where.groupId = q.groupId;
    const expSk = q.senderKey?.trim();
    if (expSk) {
      where.sameSenderContextSenderKey = { contains: expSk, mode: "insensitive" };
    }
    if ((from && !Number.isNaN(from.getTime())) || (to && !Number.isNaN(to.getTime()))) {
      where.createdAt = {};
      if (from && !Number.isNaN(from.getTime())) where.createdAt.gte = from;
      if (to && !Number.isNaN(to.getTime())) where.createdAt.lte = to;
    }

    const rows = await prisma.replyTrace.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: q.limit,
      include: { inboundMessage: true }
    });
    const filtered = onlyWithReply
      ? rows.filter((r) => (r.finalReply ?? "").trim().length > 0)
      : rows;

    const gids = [...new Set(filtered.map((r) => r.groupId).filter(Boolean))] as string[];
    const groups =
      gids.length > 0
        ? await prisma.group.findMany({ where: { id: { in: gids } }, select: { id: true, title: true } })
        : [];
    const gmap = new Map(groups.map((g) => [g.id, g.title ?? ""]));

    const headers = [
      "trace_id",
      "created_at",
      "group_id",
      "group_title",
      "sender_name",
      "is_from_robot",
      "semantic_kind",
      "user_message",
      "merged_messages_preview",
      "final_reply",
      "status",
      "reply_source",
      "skip_reason",
      "decision_reason",
      "decision_score",
      "decision_threshold",
      "intent",
      "matched_rules",
      "same_sender_context_key",
      "same_sender_context_meta_json"
    ];

    const lines = [headers.map(csvEscapeCell).join(",")];
    for (const r of filtered) {
      const im = r.inboundMessage;
      const snap = (r.decisionSnapshot || {}) as Record<string, unknown>;
      const rules = Array.isArray(snap.matchedRules)
        ? (snap.matchedRules as unknown[]).map(String).join(";")
        : "";
      lines.push(
        [
          r.id,
          r.createdAt.toISOString(),
          r.groupId ?? "",
          (r.groupId && gmap.get(r.groupId)) || "",
          im?.senderName ?? "",
          im?.isFromRobot ? "1" : "0",
          im?.semanticKind ?? r.semanticMessageType ?? "",
          im?.messageText ?? "",
          r.mergedMessagesPreview ?? "",
          r.finalReply ?? "",
          r.status,
          r.replySource ?? "",
          r.skipAutoReplyReason ?? "",
          snap.reason != null ? String(snap.reason) : "",
          snap.score != null ? String(snap.score) : "",
          snap.thresholdUsed != null ? String(snap.thresholdUsed) : "",
          snap.intent != null ? String(snap.intent) : "",
          rules,
          r.sameSenderContextSenderKey ?? "",
          r.sameSenderContextMeta != null ? JSON.stringify(r.sameSenderContextMeta) : ""
        ]
          .map(csvEscapeCell)
          .join(",")
      );
    }

    const body = "\uFEFF" + lines.join("\n");
    reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="reply-traces-${Date.now()}.csv"`);
    return reply.send(body);
  });

  app.get("/api/admin/reply-traces/:id", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const data = await prisma.replyTrace.findUnique({
      where: { id },
      include: { inboundMessage: true }
    });
    if (!data) return { success: false, data: null, error: { code: "NOT_FOUND", message: "trace" } };
    return { success: true, data, error: null };
  });

  app.post("/api/admin/reply-preview", async (request) => {
    const body = z
      .object({
        groupId: z.string().min(1),
        messageText: z.string().min(1),
        intent: z.string().optional()
      })
      .parse(request.body);
    try {
      const { text, meta } = await previewReplyPipeline(body);
      return { success: true, data: { finalReply: text, meta }, error: null };
    } catch (e) {
      return { success: false, data: null, error: { code: "PREVIEW_FAIL", message: String(e) } };
    }
  });

  app.post("/api/admin/group-smoke-send", async (request) => {
    const body = z
      .object({
        robotId: z.string().default(env.DEFAULT_ROBOT_ID),
        targetChatTitle: z.string().min(1),
        text: z.string().min(1)
      })
      .parse(request.body);
    try {
      const task = await adminCreateTestSendTask(body);
      return { success: true, data: { taskId: task.id, taskUid: task.taskUid }, error: null };
    } catch {
      return { success: false, data: null, error: { code: "SEND_FAIL", message: "robot_not_found" } };
    }
  });
}
