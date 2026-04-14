import { prisma } from "../../common/config/prisma.js";
import type { InboundMessage } from "@prisma/client";

export async function updateConversationStateFromInbound(message: InboundMessage): Promise<void> {
  if (!message.groupId) return;
  const keyUserId = message.senderId ?? null;
  const now = message.sentAt ?? new Date();

  const updated = await prisma.conversationState.updateMany({
    where: { groupId: message.groupId, userId: keyUserId },
    data: {
      lastUserMessageAt: now,
      ...(message.isFromRobot ? {} : { lastHumanReplyAt: now })
    }
  });

  if (updated.count === 0) {
    await prisma.conversationState.create({
      data: {
        groupId: message.groupId,
        userId: keyUserId,
        lastUserMessageAt: now,
        lastHumanReplyAt: message.isFromRobot ? undefined : now
      }
    });
  }
}

/** 群级机器人回复时间：不能用 groupId_userId 复合 upsert 传 userId=null（Prisma 禁止）。 */
export async function markRobotReplied(groupId: string): Promise<void> {
  const now = new Date();
  const updated = await prisma.conversationState.updateMany({
    where: { groupId, userId: null },
    data: { lastRobotReplyAt: now }
  });
  if (updated.count === 0) {
    await prisma.conversationState.create({
      data: { groupId, userId: null, lastRobotReplyAt: now }
    });
  }
}

export async function getRecentGroupMessages(groupId: string, limit = 20) {
  return prisma.inboundMessage.findMany({
    where: { groupId },
    orderBy: { createdAt: "desc" },
    take: limit
  });
}
