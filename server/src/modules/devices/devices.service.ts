import type { DevicePlatform, DeviceRuntimeStatus, Prisma } from "@prisma/client";
import { prisma } from "../../common/config/prisma.js";

export async function upsertDeviceFromRegistration(input: {
  deviceId: string;
  robotId: string;
  name: string;
  appVersion?: string | null;
  deviceModel?: string | null;
  androidVersion?: string | null;
  capability: Prisma.JsonValue;
}) {
  const robot = await prisma.robot.upsert({
    where: { robotId: input.robotId },
    update: { platform: "self_hosted" },
    create: {
      robotId: input.robotId,
      name: `Robot-${input.robotId}`,
      platform: "self_hosted"
    }
  });

  return prisma.device.upsert({
    where: { deviceId: input.deviceId },
    update: {
      name: input.name,
      appVersion: input.appVersion ?? undefined,
      deviceModel: input.deviceModel ?? undefined,
      androidVersion: input.androidVersion ?? undefined,
      capability: input.capability as Prisma.InputJsonValue,
      robotId: robot.id
    },
    create: {
      deviceId: input.deviceId,
      robotId: robot.id,
      name: input.name,
      platform: "android" as DevicePlatform,
      appVersion: input.appVersion ?? undefined,
      deviceModel: input.deviceModel ?? undefined,
      androidVersion: input.androidVersion ?? undefined,
      capability: input.capability as Prisma.InputJsonValue,
      status: "offline" as DeviceRuntimeStatus
    }
  });
}

export async function recordHeartbeat(input: {
  deviceId: string;
  robotId: string;
  status: DeviceRuntimeStatus;
  detail?: Prisma.JsonValue | null;
}) {
  const robot = await prisma.robot.findUnique({ where: { robotId: input.robotId } });
  if (!robot) {
    throw new Error("robot_not_found");
  }
  const device = await prisma.device.findFirst({
    where: { deviceId: input.deviceId, robotId: robot.id }
  });
  if (!device) {
    throw new Error("device_not_found");
  }

  await prisma.deviceHeartbeat.create({
    data: {
      deviceId: device.id,
      detail: (input.detail ?? undefined) as Prisma.InputJsonValue | undefined
    }
  });

  return prisma.device.update({
    where: { id: device.id },
    data: {
      status: input.status,
      lastSeenAt: new Date()
    }
  });
}

export async function getDeviceByExternalId(deviceId: string) {
  return prisma.device.findUnique({ where: { deviceId } });
}

export async function listDevicesForAdmin(params: { page: number; pageSize: number }) {
  const [items, total] = await Promise.all([
    prisma.device.findMany({
      include: { robot: true },
      orderBy: { updatedAt: "desc" },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize
    }),
    prisma.device.count()
  ]);
  return { items, total, page: params.page, pageSize: params.pageSize };
}

export async function getDeviceDetailForAdmin(id: string) {
  return prisma.device.findUnique({
    where: { id },
    include: { robot: true, heartbeats: { orderBy: { receivedAt: "desc" }, take: 20 } }
  });
}
