import type { Prisma, ReplyProfile, RetrievalMode } from "@prisma/client";
import { prisma } from "../../common/config/prisma.js";
import { env } from "../../common/config/env.js";

const SINGLETON_ID = "singleton";

export type ReplyLlmProviderMode = "standard" | "ark_bot";

export const DEFAULT_ARK_BOT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3/bots";

export function maskSecret(value: string | null | undefined): string | null {
  if (value == null || value === "") return null;
  if (value.length <= 8) return "********";
  return `****${value.slice(-4)}`;
}

/** 管理端提交的密钥：空/掩码/星号占位 → 不修改；真实字符串 → 写入 DB */
export function normalizeAdminApiKeyInput(raw: string | undefined): "__keep__" | string {
  if (raw === undefined) return "__keep__";
  const t = raw.trim();
  if (t === "") return "__keep__";
  if (/^[*•・\s]+$/.test(t)) return "__keep__";
  if (/^\*+$/.test(t)) return "__keep__";
  if (t.startsWith("****")) return "__keep__";
  return t;
}

export type RuntimeFieldSource = "db" | "env" | "none";

export type EffectiveLlmConfig = {
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
};

export type EffectiveEmbeddingConfig = {
  embeddingBaseUrl: string;
  embeddingApiKey: string;
  embeddingModel: string;
};

export async function ensureRuntimeConfigRow(): Promise<void> {
  await prisma.runtimeConfig.upsert({
    where: { id: SINGLETON_ID },
    create: {
      id: SINGLETON_ID,
      defaultLanguage: "zh-CN",
      retrievalMode: "keyword_first",
      knowledgeFirst: true,
      allowLlmFallback: true,
      maxReplyChars: 120
    },
    update: {}
  });
}

export function normalizeReplyLlmProvider(v: string | null | undefined): ReplyLlmProviderMode {
  const s = (v ?? "standard").trim().toLowerCase();
  return s === "ark_bot" ? "ark_bot" : "standard";
}

function rowToEffective(row: (Prisma.RuntimeConfigGetPayload<object> & { defaultReplyProfile: ReplyProfile | null }) | null) {
  const arkBaseRaw = row?.arkBotBaseUrl?.trim() || env.ARK_BOT_BASE_URL || DEFAULT_ARK_BOT_BASE_URL;
  const arkModelRaw = row?.arkBotModel?.trim() || (env.ARK_BOT_MODEL && env.ARK_BOT_MODEL.trim()) || "";
  const arkKeyRaw = row?.arkBotApiKey?.trim() || (env.ARK_BOT_API_KEY && env.ARK_BOT_API_KEY.trim()) || env.LLM_API_KEY;
  return {
    llmBaseUrl: row?.llmBaseUrl?.trim() || env.LLM_BASE_URL,
    llmApiKey: row?.llmApiKey?.trim() || env.LLM_API_KEY,
    llmModel: row?.llmModel?.trim() || env.LLM_MODEL,
    replyLlmProvider: normalizeReplyLlmProvider(row?.replyLlmProvider),
    arkBotBaseUrl: arkBaseRaw.replace(/\/$/, ""),
    arkBotModel: arkModelRaw,
    arkBotApiKey: arkKeyRaw,
    embeddingBaseUrl: (row?.embeddingBaseUrl?.trim() || env.EMBEDDING_BASE_URL || env.LLM_BASE_URL).replace(/\/$/, ""),
    embeddingApiKey: row?.embeddingApiKey?.trim() || env.EMBEDDING_API_KEY || env.LLM_API_KEY,
    embeddingModel: row?.embeddingModel?.trim() || env.EMBEDDING_MODEL || "text-embedding-3-small",
    defaultLanguage: row?.defaultLanguage || "zh-CN",
    defaultReplyProfileId: row?.defaultReplyProfileId ?? null,
    retrievalMode: (row?.retrievalMode ?? "keyword_first") as RetrievalMode,
    knowledgeFirst: row?.knowledgeFirst ?? true,
    allowLlmFallback: row?.allowLlmFallback ?? true,
    maxReplyChars: row?.maxReplyChars ?? 120,
    defaultStyleHint: row?.defaultStyleHint ?? null,
    defaultReplyProfile: row?.defaultReplyProfile ?? null
  };
}

export type EffectiveRuntimeWithSources = {
  config: ReturnType<typeof rowToEffective>;
  sources: {
    llmBaseUrl: "db" | "env";
    llmModel: "db" | "env";
    llmApiKey: RuntimeFieldSource;
    arkBotBaseUrl: "db" | "env";
    arkBotModel: "db" | "env";
    arkBotApiKey: RuntimeFieldSource;
    embeddingBaseUrl: "db" | "env";
    embeddingModel: "db" | "env";
    embeddingApiKey: RuntimeFieldSource;
  };
};

/** 内部任务用：含明文密钥 */
export async function getEffectiveRuntimeConfig() {
  await ensureRuntimeConfigRow();
  const row = await prisma.runtimeConfig.findUnique({
    where: { id: SINGLETON_ID },
    include: { defaultReplyProfile: true }
  });
  return rowToEffective(row);
}

function buildSourcesFromRow(
  row: (Prisma.RuntimeConfigGetPayload<object> & { defaultReplyProfile: ReplyProfile | null }) | null,
  full: ReturnType<typeof rowToEffective>
): EffectiveRuntimeWithSources["sources"] {
  const keySrc = (db: string | null | undefined, effective: string): RuntimeFieldSource => {
    if (db?.trim()) return "db";
    if (effective?.trim()) return "env";
    return "none";
  };
  return {
    llmBaseUrl: row?.llmBaseUrl?.trim() ? "db" : "env",
    llmModel: row?.llmModel?.trim() ? "db" : "env",
    llmApiKey: keySrc(row?.llmApiKey, full.llmApiKey),
    arkBotBaseUrl: row?.arkBotBaseUrl?.trim() ? "db" : "env",
    arkBotModel: row?.arkBotModel?.trim() ? "db" : "env",
    arkBotApiKey: keySrc(row?.arkBotApiKey, full.arkBotApiKey),
    embeddingBaseUrl: row?.embeddingBaseUrl?.trim() ? "db" : "env",
    embeddingModel: row?.embeddingModel?.trim() ? "db" : "env",
    embeddingApiKey: keySrc(row?.embeddingApiKey, full.embeddingApiKey)
  };
}

/** 解析后的配置 + 各字段来自 DB 还是 env（用于测试/排障，不记录密钥） */
export async function getEffectiveRuntimeConfigWithSources(): Promise<EffectiveRuntimeWithSources> {
  await ensureRuntimeConfigRow();
  const row = await prisma.runtimeConfig.findUnique({
    where: { id: SINGLETON_ID },
    include: { defaultReplyProfile: true }
  });
  const config = rowToEffective(row);
  return { config, sources: buildSourcesFromRow(row, config) };
}

/** 管理端 GET：不返回明文密钥；用 has* + source + 仅 DB 内密钥的掩码 */
export async function getRuntimeConfigForAdminApi() {
  const row = await prisma.runtimeConfig.findUnique({
    where: { id: SINGLETON_ID },
    include: { defaultReplyProfile: true }
  });
  const full = rowToEffective(row);
  const sources = buildSourcesFromRow(row, full);
  return {
    id: SINGLETON_ID,
    llmBaseUrl: full.llmBaseUrl,
    llmModel: full.llmModel,
    llmModelSource: sources.llmModel,
    llmBaseUrlSource: sources.llmBaseUrl,
    hasLlmApiKey: Boolean(full.llmApiKey?.trim()),
    llmApiKeySource: sources.llmApiKey,
    /** 仅当密钥存于 DB 时返回掩码；来自 env 时不返回假掩码 */
    llmApiKeyMasked: row?.llmApiKey?.trim() ? maskSecret(row.llmApiKey) : null,
    embeddingBaseUrl: full.embeddingBaseUrl,
    embeddingModel: full.embeddingModel,
    embeddingBaseUrlSource: sources.embeddingBaseUrl,
    embeddingModelSource: sources.embeddingModel,
    hasEmbeddingApiKey: Boolean(full.embeddingApiKey?.trim()),
    embeddingApiKeySource: sources.embeddingApiKey,
    embeddingApiKeyMasked: row?.embeddingApiKey?.trim() ? maskSecret(row.embeddingApiKey) : null,
    defaultLanguage: full.defaultLanguage,
    defaultReplyProfileId: full.defaultReplyProfileId,
    retrievalMode: full.retrievalMode,
    knowledgeFirst: full.knowledgeFirst,
    allowLlmFallback: full.allowLlmFallback,
    maxReplyChars: full.maxReplyChars,
    defaultStyleHint: full.defaultStyleHint,
    defaultReplyProfile: row?.defaultReplyProfile
      ? {
          id: row.defaultReplyProfile.id,
          name: row.defaultReplyProfile.name,
          enabled: row.defaultReplyProfile.enabled
        }
      : null,
    replyLlmProvider: full.replyLlmProvider,
    replyLlmProviderSource: row?.replyLlmProvider != null && String(row.replyLlmProvider).trim() !== "" ? "db" : "default",
    arkBotBaseUrl: full.arkBotBaseUrl,
    arkBotBaseUrlSource: sources.arkBotBaseUrl,
    arkBotModel: full.arkBotModel,
    arkBotModelSource: sources.arkBotModel,
    hasArkBotApiKey: Boolean(full.arkBotApiKey?.trim()),
    arkBotApiKeySource: sources.arkBotApiKey,
    arkBotApiKeyMasked: row?.arkBotApiKey?.trim() ? maskSecret(row.arkBotApiKey) : null,
    volcengineRoutingHint: volcengineRoutingHint(full.llmBaseUrl, full.llmModel)
  };
}

/** 火山方舟等：保存/展示时提示路径与 model 形态是否可能混用 */
export function volcengineRoutingHint(llmBaseUrl: string, llmModel: string): string | null {
  const u = llmBaseUrl.toLowerCase();
  const m = (llmModel || "").trim();
  if (!u.includes("volces.com") && !u.includes("volcengine")) return null;
  if (u.includes("/api/coding/v3")) {
    if (m.startsWith("ep-")) {
      return "当前 Base URL 为 Coding（/api/coding/v3），Model 为 ep- 开头时更像「在线推理」Endpoint ID；请改用 /api/v3 类地址，或把 Model 改为 ark-code-latest 等 Coding 模型名。";
    }
    return null;
  }
  if (u.includes("/api/v3") && !u.includes("coding")) {
    if (m && !m.startsWith("ep-") && /^(ark-|doubao)/i.test(m)) {
      return "当前 Base URL 为在线推理（/api/v3），Model 名像 Coding Plan（如 ark-*）；请改用 /api/coding/v3，或把 Model 改为 ep-xxxx 形式的 Endpoint ID。";
    }
    return null;
  }
  return null;
}

export type RuntimeConfigPatch = {
  llmBaseUrl?: string | null;
  llmApiKey?: string | null;
  llmModel?: string | null;
  replyLlmProvider?: string | null;
  arkBotBaseUrl?: string | null;
  arkBotModel?: string | null;
  arkBotApiKey?: string | null;
  embeddingBaseUrl?: string | null;
  embeddingApiKey?: string | null;
  embeddingModel?: string | null;
  defaultLanguage?: string | null;
  defaultReplyProfileId?: string | null;
  retrievalMode?: RetrievalMode;
  knowledgeFirst?: boolean;
  allowLlmFallback?: boolean;
  maxReplyChars?: number;
  defaultStyleHint?: string | null;
};

/** 若字段为 undefined 跳过；传 null 清空；API Key 传 "__keep__" 表示不修改 */
export async function updateRuntimeConfig(patch: RuntimeConfigPatch) {
  await ensureRuntimeConfigRow();
  const data: Prisma.RuntimeConfigUpdateInput = {};
  if (patch.llmBaseUrl !== undefined) data.llmBaseUrl = patch.llmBaseUrl;
  if (patch.llmModel !== undefined) data.llmModel = patch.llmModel;
  if (patch.replyLlmProvider !== undefined) {
    data.replyLlmProvider = normalizeReplyLlmProvider(patch.replyLlmProvider ?? "standard");
  }
  if (patch.arkBotBaseUrl !== undefined) data.arkBotBaseUrl = patch.arkBotBaseUrl;
  if (patch.arkBotModel !== undefined) data.arkBotModel = patch.arkBotModel;
  if (patch.embeddingBaseUrl !== undefined) data.embeddingBaseUrl = patch.embeddingBaseUrl;
  if (patch.embeddingModel !== undefined) data.embeddingModel = patch.embeddingModel;
  if (patch.defaultLanguage !== undefined) data.defaultLanguage = patch.defaultLanguage ?? "zh-CN";
  if (patch.defaultReplyProfileId !== undefined) data.defaultReplyProfileId = patch.defaultReplyProfileId;
  if (patch.retrievalMode !== undefined) data.retrievalMode = patch.retrievalMode;
  if (patch.knowledgeFirst !== undefined) data.knowledgeFirst = patch.knowledgeFirst;
  if (patch.allowLlmFallback !== undefined) data.allowLlmFallback = patch.allowLlmFallback;
  if (patch.maxReplyChars !== undefined) data.maxReplyChars = patch.maxReplyChars;
  if (patch.defaultStyleHint !== undefined) data.defaultStyleHint = patch.defaultStyleHint;
  if (patch.llmApiKey !== undefined && patch.llmApiKey !== "__keep__") {
    const v = patch.llmApiKey;
    data.llmApiKey = v === null || v === "" ? null : v.trim();
  }
  if (patch.arkBotApiKey !== undefined && patch.arkBotApiKey !== "__keep__") {
    const v = patch.arkBotApiKey;
    data.arkBotApiKey = v === null || v === "" ? null : v.trim();
  }
  if (patch.embeddingApiKey !== undefined && patch.embeddingApiKey !== "__keep__") {
    const v = patch.embeddingApiKey;
    data.embeddingApiKey = v === null || v === "" ? null : v.trim();
  }
  return prisma.runtimeConfig.update({
    where: { id: SINGLETON_ID },
    data
  });
}
