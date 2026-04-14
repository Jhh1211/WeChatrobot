import { z } from "zod";
import { AppError } from "../../common/errors/app-error.js";

const STYLE_ENUM = ["faq_assistant", "proactive_operator", "warm_companion", "group_assistant"] as const;
type StyleEnum = (typeof STYLE_ENUM)[number];

const llmResponseSchema = z.object({
  should_reply: z.boolean(),
  reply_text: z.string(),
  intent: z.string().default("unknown"),
  confidence: z.number().min(0).max(1),
  risk_level: z.enum(["low", "medium", "high", "blocked"]),
  style: z.enum(STYLE_ENUM)
});

export type LlmStructuredReply = z.infer<typeof llmResponseSchema>;

function coerceShouldReply(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "true" || s === "1" || s === "yes" || s === "是";
  }
  return false;
}

function coerceConfidence(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

/** 中文/别名模型常把 risk_level、style 写成自然语言，与 Zod 枚举不一致 */
function normalizeRiskLevel(v: unknown): "low" | "medium" | "high" | "blocked" {
  const m = String(v ?? "").trim();
  if (!m) return "low";
  const lower = m.toLowerCase();
  if (lower === "low" || lower === "medium" || lower === "high" || lower === "blocked") {
    return lower;
  }
  if (m === "低" || m === "低风险") return "low";
  if (m === "中" || m === "中等" || m === "中风险") return "medium";
  if (m === "高" || m === "高风险") return "high";
  if (m === "拦截" || m === "封禁") return "blocked";
  return "low";
}

function normalizeStyle(v: unknown): StyleEnum {
  const raw = String(v ?? "").trim();
  if (!raw) return "faq_assistant";
  const compact = raw.toLowerCase().replace(/\s+/g, "_");
  if ((STYLE_ENUM as readonly string[]).includes(compact)) return compact as StyleEnum;
  const lower = raw.toLowerCase();
  if (["casual", "natural", "normal", "friendly", "concise", "简洁", "口语", "轻松"].some((k) => lower.includes(k))) {
    return "warm_companion";
  }
  if (["professional", "formal", "专业", "正式"].some((k) => lower.includes(k))) {
    return "faq_assistant";
  }
  return "faq_assistant";
}

/**
 * 将模型返回的松散 JSON 规范成 schema 可接受的形状（中英混排、枚举漂移）。
 */
export function normalizeLlmReplyJsonInput(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const o = { ...(raw as Record<string, unknown>) };
  if ("should_reply" in o) o.should_reply = coerceShouldReply(o.should_reply);
  if ("risk_level" in o) o.risk_level = normalizeRiskLevel(o.risk_level);
  if ("style" in o) o.style = normalizeStyle(o.style);
  if ("confidence" in o) o.confidence = coerceConfidence(o.confidence);
  if ("reply_text" in o && o.reply_text != null && typeof o.reply_text !== "string") {
    o.reply_text = String(o.reply_text);
  }
  return o;
}

function parseJsonFromModelContent(content: string): unknown {
  const t = content.trim();
  try {
    return JSON.parse(t) as unknown;
  } catch {
    const m = t.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) {
      return JSON.parse(m[1].trim()) as unknown;
    }
    throw new AppError("llm returned non-json content", 502, "LLM_BAD_JSON");
  }
}

export function parseLlmReplyFromModelContent(content: string): LlmStructuredReply {
  const parsedJson = parseJsonFromModelContent(content);
  const normalized = normalizeLlmReplyJsonInput(parsedJson);
  return llmResponseSchema.parse(normalized);
}
