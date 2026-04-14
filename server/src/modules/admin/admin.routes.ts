import type { FastifyInstance } from "fastify";
import { EventSourceType } from "@prisma/client";
import { z } from "zod";
import { adminAuthGuard } from "../../common/guards/admin-auth.js";
import { prisma } from "../../common/config/prisma.js";
import { env } from "../../common/config/env.js";
import { listGroups, updateGroup } from "../groups/groups.service.js";
import { acceptWebhookEvent } from "../webhook/webhook.service.js";
import { createKnowledgeDocument, listKnowledge, updateKnowledge } from "../knowledge/knowledge.service.js";
import { evaluateReplyDecision } from "../rules/reply-decision.engine.js";
import { getDeviceDetailForAdmin, listDevicesForAdmin } from "../devices/devices.service.js";
import {
  adminCreateTestSendTask,
  cancelExecutorTaskAdmin,
  listExecutorTasksForAdmin
} from "../executor/executor.service.js";
import { registerAdminV1Routes } from "./admin-v1.routes.js";
import { registerAdminAuthRoutes } from "./admin-auth.routes.js";

const paginationSchema = z.object({
  page: z.coerce.number().default(1),
  pageSize: z.coerce.number().default(20)
});

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  await registerAdminAuthRoutes(app);

  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/admin")) return;
    const path = request.url.split("?")[0];
    if (path === "/api/admin/auth/login" && request.method === "POST") return;
    const denied = await adminAuthGuard(request, reply);
    if (denied) return denied;
  });

  app.post("/api/admin/worktool/configure-callback", async () => {
    return {
      success: false,
      data: null,
      error: {
        code: "DEPRECATED",
        message:
          "WorkTool commercial API is deprecated. Use Android executor: register device, heartbeat, and inbound-events."
      }
    };
  });

  app.get("/api/admin/worktool/callback-config", async () => {
    return {
      success: false,
      data: null,
      error: { code: "DEPRECATED", message: "WorkTool provider deprecated." }
    };
  });

  app.get("/api/admin/worktool/online-status", async () => {
    return {
      success: true,
      data: {
        hint: "Robot online status is derived from executor device heartbeats (last 90s).",
        defaultRobotId: env.DEFAULT_ROBOT_ID
      },
      error: null
    };
  });

  app.get("/api/admin/groups", async (request) => {
    const query = paginationSchema.extend({ keyword: z.string().optional() }).parse(request.query);
    const data = await listGroups(query);
    return { success: true, data, error: null };
  });

  app.patch("/api/admin/groups/:id", async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.record(z.any()).parse(request.body);
    const data = await updateGroup(params.id, body);
    return { success: true, data, error: null };
  });

  app.get("/api/admin/messages", async (request) => {
    const query = paginationSchema
      .extend({
        groupId: z.string().optional(),
        chatType: z.enum(["group", "private", "system"]).optional()
      })
      .parse(request.query);
    const where = {
      groupId: query.groupId,
      chatType: query.chatType
    };
    const [items, total] = await Promise.all([
      prisma.inboundMessage.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize
      }),
      prisma.inboundMessage.count({ where })
    ]);
    return { success: true, data: { items, total, ...query }, error: null };
  });

  app.get("/api/admin/messages/:id", async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const data = await prisma.inboundMessage.findUnique({
      where: { id: params.id },
      include: { replyDecisions: true }
    });
    return { success: true, data, error: null };
  });

  app.get("/api/admin/replies", async (request) => {
    const query = paginationSchema.parse(request.query);
    const [items, total] = await Promise.all([
      prisma.outboundMessage.findMany({
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize
      }),
      prisma.outboundMessage.count()
    ]);
    return { success: true, data: { items, total, ...query }, error: null };
  });

  app.get("/api/admin/audit", async (request) => {
    const query = paginationSchema
      .extend({ entityType: z.string().optional(), action: z.string().optional() })
      .parse(request.query);
    const where = {
      entityType: query.entityType,
      action: query.action
    };
    const [items, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize
      }),
      prisma.auditLog.count({ where })
    ]);
    return { success: true, data: { items, total, ...query }, error: null };
  });

  app.post("/api/admin/test/replay-event/:id", async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const event = await prisma.inboundEvent.findUnique({ where: { id: params.id } });
    if (!event) return { success: false, data: null, error: { code: "NOT_FOUND", message: "event not found" } };
    const data = await acceptWebhookEvent(
      event.rawPayload as Record<string, unknown>,
      EventSourceType.manual_replay
    );
    return { success: true, data, error: null };
  });

  app.post("/api/admin/rules/evaluate", async (request) => {
    const body = z.object({ inboundMessageId: z.string() }).parse(request.body);
    const message = await prisma.inboundMessage.findUnique({ where: { id: body.inboundMessageId } });
    if (!message || !message.groupId) {
      return { success: false, data: null, error: { code: "INVALID_INPUT", message: "message not eligible" } };
    }
    const group = await prisma.group.findUnique({ where: { id: message.groupId } });
    if (!group) {
      return { success: false, data: null, error: { code: "GROUP_NOT_FOUND", message: "group not found" } };
    }
    const recentMessages = await prisma.inboundMessage.findMany({
      where: { groupId: message.groupId },
      orderBy: { createdAt: "desc" },
      take: 20
    });
    const decision = await evaluateReplyDecision({ message, group, recentMessages });
    return { success: true, data: decision, error: null };
  });

  app.post("/api/admin/knowledge", async (request) => {
    const body = z
      .object({
        title: z.string(),
        type: z.enum(["faq", "activity", "project", "talk", "risk"]),
        city: z.string().optional(),
        tags: z.array(z.string()).optional(),
        content: z.string()
      })
      .parse(request.body);
    const data = await createKnowledgeDocument(body);
    return { success: true, data, error: null };
  });

  app.get("/api/admin/knowledge", async (request) => {
    const query = paginationSchema.extend({
      type: z.enum(["faq", "activity", "project", "talk", "risk"]).optional()
    }).parse(request.query);
    const data = await listKnowledge(query);
    return { success: true, data, error: null };
  });

  app.patch("/api/admin/knowledge/:id", async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.record(z.any()).parse(request.body);
    const data = await updateKnowledge(params.id, body);
    return { success: true, data, error: null };
  });

  app.get("/api/admin/devices", async (request) => {
    const query = paginationSchema.parse(request.query);
    const data = await listDevicesForAdmin(query);
    return { success: true, data, error: null };
  });

  app.get("/api/admin/devices/:id", async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const data = await getDeviceDetailForAdmin(params.id);
    if (!data) {
      return { success: false, data: null, error: { code: "NOT_FOUND", message: "device not found" } };
    }
    return { success: true, data, error: null };
  });

  app.get("/api/admin/executor-tasks", async (request) => {
    const query = paginationSchema.extend({ status: z.string().optional() }).parse(request.query);
    const data = await listExecutorTasksForAdmin({
      page: query.page,
      pageSize: query.pageSize,
      status: query.status
    });
    return { success: true, data, error: null };
  });

  app.post("/api/admin/executor-tasks/:id/cancel", async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const task = await cancelExecutorTaskAdmin(params.id);
    if (!task) {
      return { success: false, data: null, error: { code: "NOT_FOUND", message: "task not found" } };
    }
    return { success: true, data: { cancelled: true }, error: null };
  });

  app.post("/api/admin/test/create-send-task", async (request) => {
    const body = z
      .object({
        robotId: z.string().default(env.DEFAULT_ROBOT_ID),
        targetChatTitle: z.string().min(1),
        text: z.string().min(1)
      })
      .parse(request.body);
    try {
      const task = await adminCreateTestSendTask(body);
      return { success: true, data: { taskId: task.id, taskUid: task.taskUid }, error: null };
    } catch {
      return {
        success: false,
        data: null,
        error: { code: "CREATE_FAILED", message: "robot not found" }
      };
    }
  });

  await registerAdminV1Routes(app);
}
