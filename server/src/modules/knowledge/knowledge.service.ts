import { KnowledgeType } from "@prisma/client";
import { prisma } from "../../common/config/prisma.js";
import { logger } from "../../common/logger/pino.js";

export async function createKnowledgeDocument(input: {
  title: string;
  type: KnowledgeType;
  city?: string;
  tags?: string[];
  content: string;
}) {
  return prisma.knowledgeDocument.create({
    data: {
      title: input.title,
      type: input.type,
      city: input.city,
      tags: input.tags ?? [],
      content: input.content
    }
  });
}

export async function listKnowledge(params: { page: number; pageSize: number; type?: KnowledgeType }) {
  const where = params.type ? { type: params.type, enabled: true } : { enabled: true };
  const [items, total] = await Promise.all([
    prisma.knowledgeDocument.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize
    }),
    prisma.knowledgeDocument.count({ where })
  ]);
  return { items, total, page: params.page, pageSize: params.pageSize };
}

export async function updateKnowledge(id: string, patch: Record<string, unknown>) {
  return prisma.knowledgeDocument.update({
    where: { id },
    data: patch
  });
}

export async function retrieveKnowledge(params: {
  groupId?: string | null;
  city?: string | null;
  tags?: string[];
  queryText: string;
  topK?: number;
}) {
  const topK = params.topK ?? 5;
  const q = params.queryText.trim();
  const baseDocs =
    q.length > 0
      ? await prisma.knowledgeDocument.findMany({
          where: {
            enabled: true,
            OR: [{ city: params.city ?? undefined }, { city: null }],
            content: {
              contains: q,
              mode: "insensitive"
            }
          },
          take: 50
        })
      : [];
  const documents = baseDocs
    .filter((doc) => {
      if (!params.tags?.length) return true;
      const docTags = (doc.tags as unknown[])?.map((tag) => String(tag)) ?? [];
      return params.tags.some((tag) => docTags.includes(tag));
    })
    .slice(0, topK);

  if (documents.length >= 2) {
    logger.info(
      {
        mode: "contains_priority",
        count: documents.length,
        titles: documents.map((d) => d.title).slice(0, 8)
      },
      "knowledge_retrieval"
    );
    return documents;
  }
  const fallback = await prisma.knowledgeDocument.findMany({
    where: { enabled: true },
    take: topK,
    orderBy: { updatedAt: "desc" }
  });
  logger.info(
    {
      mode: documents.length === 0 ? "fallback_recent_only" : "contains_lt2_use_fallback_recent",
      containsHits: documents.length,
      fallbackCount: fallback.length,
      titles: fallback.map((d) => d.title).slice(0, 8)
    },
    "knowledge_retrieval"
  );
  return fallback;
}
