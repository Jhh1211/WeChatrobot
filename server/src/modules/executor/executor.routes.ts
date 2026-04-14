import type { FastifyInstance } from "fastify";

import type { Prisma } from "@prisma/client";

import { z } from "zod";

import { executorAuthGuard } from "../../common/guards/executor-auth.js";

import {

  ackExecutorTask,

  pullExecutorTask,

  reportExecutorTaskResult,

  submitExecutorInboundEvent

} from "./executor.service.js";

import { recordHeartbeat, upsertDeviceFromRegistration } from "../devices/devices.service.js";

import type { DeviceRuntimeStatus } from "@prisma/client";



export async function registerExecutorRoutes(app: FastifyInstance): Promise<void> {

  app.addHook("preHandler", async (request, reply) => {

    if (request.url.startsWith("/api/executor")) {

      await executorAuthGuard(request, reply);

      if (reply.sent) return;

    }

  });



  app.post("/api/executor/device/register", async (request, reply) => {

    const body = z

      .object({

        deviceId: z.string().min(1),

        robotId: z.string().min(1),

        name: z.string().min(1),

        appVersion: z.string().optional().nullable(),

        deviceModel: z.string().optional().nullable(),

        androidVersion: z.string().optional().nullable(),

        capability: z.union([z.array(z.string()), z.record(z.any())])

      })

      .parse(request.body);



    const capabilityJson = Array.isArray(body.capability)

      ? { list: body.capability }

      : body.capability;



    const device = await upsertDeviceFromRegistration({

      deviceId: body.deviceId,

      robotId: body.robotId,

      name: body.name,

      appVersion: body.appVersion,

      deviceModel: body.deviceModel,

      androidVersion: body.androidVersion,

      capability: capabilityJson

    });



    return reply.send({

      success: true,

      data: { deviceId: device.deviceId, id: device.id }

    });

  });



  app.post("/api/executor/device/heartbeat", async (request, reply) => {

    const body = z

      .object({

        deviceId: z.string().min(1),

        robotId: z.string().min(1),

        status: z.enum(["online", "offline"]),

        detail: z.record(z.any()).optional().nullable()

      })

      .parse(request.body);



    try {

      const device = await recordHeartbeat({

        deviceId: body.deviceId,

        robotId: body.robotId,

        status: body.status as DeviceRuntimeStatus,

        detail: body.detail

      });

      return reply.send({

        success: true,

        data: { deviceId: device.deviceId, lastSeenAt: device.lastSeenAt?.toISOString() ?? null }

      });

    } catch {

      return reply.status(404).send({

        success: false,

        error: { code: "NOT_FOUND", message: "device or robot not registered" }

      });

    }

  });



  app.post("/api/executor/inbound-events", async (request, reply) => {

    const body = z

      .object({

        deviceId: z.string().min(1),

        robotId: z.string().min(1),

        source: z.string().min(1),

        rawPayload: z.record(z.any()),

        normalizedMessage: z.object({

          chatTitle: z.string().min(1),

          senderName: z.string().optional().nullable(),

          text: z.string().min(1),

          timestamp: z.string().optional().nullable(),

          isFromSelf: z.boolean(),

          messageType: z.string().min(1)

        })

      })

      .parse(request.body);



    const result = await submitExecutorInboundEvent({

      deviceId: body.deviceId,

      robotId: body.robotId,

      source: body.source,

      rawPayload: body.rawPayload as Prisma.JsonObject,

      normalizedMessage: body.normalizedMessage

    });



    return reply.send({

      success: true,

      data: result

    });

  });



  app.post("/api/executor/tasks/pull", async (request, reply) => {

    const body = z

      .object({

        deviceId: z.string().min(1),

        robotId: z.string().min(1),

        capability: z.array(z.string())

      })

      .parse(request.body);



    const data = await pullExecutorTask(body);

    return reply.send({ success: true, data });

  });



  app.post("/api/executor/tasks/:taskId/ack", async (request, reply) => {

    const params = z.object({ taskId: z.string().min(1) }).parse(request.params);

    const body = z.object({ deviceId: z.string().min(1) }).parse(request.body);



    const result = await ackExecutorTask(params.taskId, body.deviceId);

    if (!result.ok) {

      return reply.status(409).send({

        success: false,

        error: { code: "ACK_FAILED", message: "task not pending or device invalid" }

      });

    }

    return reply.send({ success: true, data: { acknowledged: true } });

  });



  app.post("/api/executor/tasks/:taskId/result", async (request, reply) => {

    const params = z.object({ taskId: z.string().min(1) }).parse(request.params);

    const body = z

      .object({

        deviceId: z.string().min(1),

        status: z.enum(["success", "failed"]),

        detail: z.record(z.any()).optional(),

        executedAt: z.string().optional().nullable(),

        errorMessage: z.string().optional().nullable()

      })

      .parse(request.body);



    try {

      await reportExecutorTaskResult({

        taskId: params.taskId,

        externalDeviceId: body.deviceId,

        status: body.status,

        detail: body.detail,

        executedAt: body.executedAt,

        errorMessage: body.errorMessage

      });

      return reply.send({ success: true, data: { recorded: true } });

    } catch (error) {

      const message = error instanceof Error ? error.message : "unknown";

      const code =

        message === "invalid_task_state" || message === "invalid_task_transition"

          ? "INVALID_TRANSITION"

          : message === "device_not_found" || message === "task_not_found"

            ? "NOT_FOUND"

            : "RESULT_FAILED";

      const status = code === "NOT_FOUND" ? 404 : code === "INVALID_TRANSITION" ? 409 : 400;

      return reply.status(status).send({

        success: false,

        error: { code, message }

      });

    }

  });

}

