import axios from "axios";
import { AppError } from "../../common/errors/app-error.js";
import { parseLlmReplyFromModelContent } from "./llm-reply-parse.js";

export type LlmRuntimeConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

/** 火山方舟等部分网关不支持 OpenAI 的 response_format=json_object，传了会 400 */
function supportsOpenAiJsonObjectResponseFormat(baseUrl: string): boolean {
  const u = baseUrl.toLowerCase();
  if (u.includes("volces.com") || u.includes("volcengineapi.com")) return false;
  return true;
}

export async function generateLlmReplyJson(
  cfg: LlmRuntimeConfig,
  input: { systemPrompt: string; userPrompt: string }
) {
  const base = cfg.baseUrl.replace(/\/$/, "");
  const client = axios.create({
    baseURL: base,
    timeout: 120_000,
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json"
    }
  });
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: input.userPrompt }
    ],
    temperature: 0.4
  };
  const u = base.toLowerCase();
  if (u.includes("volces.com") || u.includes("volcengineapi.com")) {
    body.stream = false;
  }
  if (supportsOpenAiJsonObjectResponseFormat(base)) {
    body.response_format = { type: "json_object" };
  }
  const response = await client.post("/chat/completions", body);
  const content = response.data?.choices?.[0]?.message?.content;
  if (!content || typeof content !== "string") {
    throw new AppError("llm returned empty content", 502, "LLM_EMPTY");
  }
  return parseLlmReplyFromModelContent(content);
}
