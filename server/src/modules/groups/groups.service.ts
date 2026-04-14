import { prisma } from "../../common/config/prisma.js";

export async function listGroups(params: { page: number; pageSize: number; keyword?: string }) {
  const where = params.keyword
    ? { title: { contains: params.keyword, mode: "insensitive" as const } }
    : {};
  const [items, total] = await Promise.all([
    prisma.group.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize
    }),
    prisma.group.count({ where })
  ]);
  return { items, total, page: params.page, pageSize: params.pageSize };
}

export async function updateGroup(groupId: string, patch: Record<string, unknown>) {
  return prisma.group.update({
    where: { id: groupId },
    data: patch
  });
}
