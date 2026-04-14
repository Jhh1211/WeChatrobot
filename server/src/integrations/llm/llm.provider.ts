import axios from "axios";
import { env } from "../../common/config/env.js";
import { AppError } from "../../common/errors/app-error.js";
import { parseLlmReplyFromModelContent } from "./llm-reply-parse.js";
import type { LlmGenerateReplyInput, LlmReplyOutput } from "./llm.types.js";

export class OpenAiCompatibleProvider {
  private readonly client = axios.create({
    baseURL: env.LLM_BASE_URL,
    timeout: 15_000,
    headers: {
      Authorization: `Bearer ${env.LLM_API_KEY}`,
      "Content-Type": "application/json"
    }
  });

  async generateReply(input: LlmGenerateReplyInput): Promise<LlmReplyOutput> {
    const response = await this.client.post("/chat/completions", {
      model: env.LLM_MODEL,
      messages: [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: input.userPrompt }
      ],
      temperature: 0.4,
      response_format: { type: "json_object" }
    });

    const content = response.data?.choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") {
      throw new AppError("llm returned empty content", 502, "LLM_EMPTY");
    }
    return parseLlmReplyFromModelContent(content);
  }
}

export const llmProvider = new OpenAiCompatibleProvider();
