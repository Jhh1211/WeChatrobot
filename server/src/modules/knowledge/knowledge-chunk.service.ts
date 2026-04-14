import { prisma } from "../../common/config/prisma.js";
import { embedText, embedTexts, type EmbeddingClientConfig } from "../../integrations/embeddings/embeddings.client.js";
import { cosineSimilarity, parseEmbeddingJson } from "../../common/utils/vector.js";
import type { RetrievalMode } from "@prisma/client";

const DEFAULT_CHUNK = 480;

export function splitContentToChunks(content: string, maxLen = DEFAULT_CHUNK): string[] {
  const t = content.trim();
  if (!t) return [];
  const parts = t.split(/\n\n+/);
  const chunks: string[] = [];
  let cur = "";
  for (const p of parts) {
    const piece = p.trim();
    if (!piece) continue;
    if (cur.length + piece.length + 2 > maxLen) {
      if (cur) chunks.push(cur.trim());
      if (piece.length > maxLen) {
        for (let i = 0; i < piece.length; i += maxLen) {
          chunks.push(piece.slice(i, i + maxLen));
        }
        cur = "";
      } else {
        cur = piece;
      }
    } else {
      cur = cur ? `${cur}\n\n${piece}` : piece;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.length ? chunks : [t.slice(0, maxLen)];
}

export async function reindexKnowledgeDocument(
  documentId: string,
  embedConfig: EmbeddingClientConfig | null
): Promise<{ chunkCount: number }> {
  const doc = await prisma.knowledgeDocument.findUnique({ where: { id: documentId } });
  if (!doc) throw new Error("document_not_found");

  await prisma.knowledgeChunk.deleteMany({ where: { documentId } });
  const texts = splitContentToChunks(doc.content);
  if (texts.length === 0) return { chunkCount: 0 };

  let vectors: number[][] = [];
  if (embedConfig && embedConfig.apiKey && embedConfig.model) {
    try {
      vectors = await embedTexts(embedConfig, texts);
    } catch (e) {
      vectors = texts.map(() => []);
    }
  }

  for (let i = 0; i < texts.length; i++) {
    const emb = vectors[i]?.length ? vectors[i] : null;
    await prisma.knowledgeChunk.create({
      data: {
        documentId,
        content: texts[i],
        chunkIndex: i,
        embedding: emb ?? undefined,
        enabled: true
      }
    });
  }
  return { chunkCount: texts.length };
}

export type RetrievedChunk = {
  chunkId: string;
  documentId: string;
  title: string;
  content: string;
  score: number;
};

function keywordScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const hay = text.toLowerCase();
  if (hay.includes(q)) return 1;
  const tokens = q.split(/\s+/).filter((t) => t.length > 1);
  if (tokens.length === 0) return 0;
  const hits = tokens.filter((t) => hay.includes(t)).length;
  return hits / tokens.length;
}

export async function retrieveChunks(params: {
  collectionId: string | null | undefined;
  queryText: string;
  mode: RetrievalMode;
  topK: number;
  embedConfig: EmbeddingClientConfig | null;
}): Promise<RetrievedChunk[]> {
  const topK = params.topK ?? 8;
  const q = params.queryText.trim();

  const docWhere =
    params.collectionId != null && params.collectionId !== ""
      ? { enabled: true, collectionId: params.collectionId }
      : { enabled: true };

  if (params.mode === "off") return [];

  const chunks = await prisma.knowledgeChunk.findMany({
    where: {
      enabled: true,
      document: docWhere
    },
    include: { document: true },
    take: 2000
  });

  let queryVec: number[] | null = null;
  if (
    (params.mode === "vector_first" || params.mode === "hybrid") &&
    params.embedConfig?.apiKey &&
    params.embedConfig.model &&
    q.length > 0
  ) {
    try {
      queryVec = await embedText(params.embedConfig, q);
    } catch {
      queryVec = null;
    }
  }

  const scored: RetrievedChunk[] = [];
  for (const ch of chunks) {
    const emb = parseEmbeddingJson(ch.embedding);
    let score = 0;
    if (params.mode === "off") {
      score = 0;
    } else if (params.mode === "keyword_first" || params.mode === "hybrid") {
      const ks = keywordScore(q, ch.content);
      score = ks;
      if (params.mode === "hybrid" && queryVec && emb) {
        score = ks * 0.45 + cosineSimilarity(queryVec, emb) * 0.55;
      }
    } else if (params.mode === "vector_first") {
      if (queryVec && emb) {
        score = cosineSimilarity(queryVec, emb);
      } else {
        score = keywordScore(q, ch.content) * 0.5;
      }
    }

    scored.push({
      chunkId: ch.id,
      documentId: ch.documentId,
      title: ch.document.title,
      content: ch.content,
      score
    });
  }

  scored.sort((a, b) => b.score - a.score);
  const positive = scored.filter((s) => s.score > 0);
  const pick = (positive.length >= topK ? positive : scored).slice(0, topK);
  return pick;
}
