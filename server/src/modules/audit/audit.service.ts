import { prisma } from "../../common/config/prisma.js";

export async function writeAuditLog(params: {
  entityType: string;
  entityId: string;
  action: string;
  detail: unknown;
}) {
  return prisma.auditLog.create({
    data: {
      entityType: params.entityType,
      entityId: params.entityId,
      action: params.action,
      detail: (params.detail ?? {}) as object
    }
  });
}
