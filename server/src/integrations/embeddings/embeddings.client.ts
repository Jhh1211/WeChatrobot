import axios from "axios";
import { logger } from "../../common/logger/pino.js";

export type EmbeddingClientConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

export async function embedTexts(
  config: EmbeddingClientConfig,
  inputs: string[]
): Promise<number[][]> {
  const base = config.baseUrl.replace(/\/$/, "");
  const client = axios.create({
    baseURL: base,
    timeout: 120_000,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json"
    }
  });
  const response = await client.post("/embeddings", {
    model: config.model,
    input: inputs.length === 1 ? inputs[0] : inputs
  });
  const list = response.data?.data;
  if (!Array.isArray(list)) {
    logger.error({ data: response.data }, "embedding_api_unexpected_shape");
    throw new Error("embedding_api_unexpected_shape");
  }
  const out = list
    .sort((x: { index: number }, y: { index: number }) => x.index - y.index)
    .map((d: { embedding: number[] }) => d.embedding);
  return out;
}

export async function embedText(config: EmbeddingClientConfig, text: string): Promise<number[]> {
  const [vec] = await embedTexts(config, [text]);
  return vec ?? [];
}
