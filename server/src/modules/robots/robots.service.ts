import { OnlineStatus } from "@prisma/client";
import { prisma } from "../../common/config/prisma.js";

/** 设备心跳窗口：超过该时间无心跳则机器人视为离线（仅依据 device_heartbeats，不依赖 WorkTool）。 */
export const ROBOT_HEARTBEAT_WINDOW_MS = 90_000;

export async function refreshRobotOnlineFromDevices(): Promise<void> {
  const threshold = new Date(Date.now() - ROBOT_HEARTBEAT_WINDOW_MS);
  const robots = await prisma.robot.findMany();

  for (const robot of robots) {
    const recent = await prisma.deviceHeartbeat.findFirst({
      where: {
        device: { robotId: robot.id },
        receivedAt: { gte: threshold }
      },
      orderBy: { receivedAt: "desc" }
    });

    const online = Boolean(recent);
    await prisma.robot.update({
      where: { id: robot.id },
      data: {
        onlineStatus: online ? OnlineStatus.online : OnlineStatus.offline,
        lastOnlineAt: online ? new Date() : robot.lastOnlineAt,
        lastHealthCheckAt: new Date()
      }
    });
  }
}
