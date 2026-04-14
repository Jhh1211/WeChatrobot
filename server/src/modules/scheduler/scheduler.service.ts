import { JobStatus } from "@prisma/client";
import { prisma } from "../../common/config/prisma.js";
import { logger } from "../../common/logger/pino.js";
import { refreshRobotOnlineFromDevices } from "../robots/robots.service.js";

let started = false;

async function runJob(jobName: string, task: () => Promise<void>) {
  const run = await prisma.jobRun.create({
    data: { jobName, status: JobStatus.running, startedAt: new Date() }
  });
  try {
    await task();
    await prisma.jobRun.update({
      where: { id: run.id },
      data: { status: JobStatus.success, finishedAt: new Date() }
    });
  } catch (error) {
    logger.error({ error, jobName }, "scheduler job failed");
    await prisma.jobRun.update({
      where: { id: run.id },
      data: { status: JobStatus.failed, finishedAt: new Date(), detail: { message: String(error) } }
    });
  }
}

async function aggregateGroupActive(): Promise<void> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const grouped = await prisma.inboundMessage.groupBy({
    by: ["groupId"],
    where: { createdAt: { gte: oneHourAgo }, groupId: { not: null } },
    _count: { _all: true }
  });
  for (const item of grouped) {
    if (!item.groupId) continue;
    await prisma.auditLog.create({
      data: {
        entityType: "group",
        entityId: item.groupId,
        action: "hourly_active_count",
        detail: { count: item._count._all, at: new Date().toISOString() }
      }
    });
  }
}

async function generateDailyReport(): Promise<void> {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const totalInbound = await prisma.inboundMessage.count({ where: { createdAt: { gte: oneDayAgo } } });
  const totalOutbound = await prisma.outboundMessage.count({ where: { createdAt: { gte: oneDayAgo } } });
  await prisma.auditLog.create({
    data: {
      entityType: "system",
      entityId: "daily-report",
      action: "daily_summary",
      detail: { totalInbound, totalOutbound, generatedAt: new Date().toISOString() }
    }
  });
}

export function startSchedulers(): void {
  if (started) return;
  started = true;

  setInterval(() => void runJob("refresh_robot_from_devices", refreshRobotOnlineFromDevices), 60_000);
  setInterval(() => void runJob("hourly_group_activity", aggregateGroupActive), 3_600_000);
  setInterval(() => void runJob("daily_report", generateDailyReport), 24 * 3_600_000);
}
