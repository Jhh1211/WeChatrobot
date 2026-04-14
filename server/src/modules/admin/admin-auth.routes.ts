import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { env } from "../../common/config/env.js";
import {
  ADMIN_SESSION_COOKIE,
  createAdminSessionToken,
  timingSafeEqualUtf8
} from "../../common/guards/admin-session.js";

const SESSION_MAX_AGE_SEC = 7 * 24 * 3600;

function appendSetCookie(reply: FastifyReply, value: string): void {
  reply.header("Set-Cookie", value);
}

export async function registerAdminAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/admin/auth/login", async (request, reply) => {
    const body = z
      .object({
        username: z.string().min(1),
        password: z.string().min(1)
      })
      .parse(request.body);

    const userOk = timingSafeEqualUtf8(body.username, env.ADMIN_USERNAME);
    const passOk = timingSafeEqualUtf8(body.password, env.ADMIN_PASSWORD);
    if (!userOk || !passOk) {
      return reply.status(401).send({
        success: false,
        data: null,
        error: { code: "INVALID_CREDENTIALS", message: "用户名或密码错误" }
      });
    }

    const token = createAdminSessionToken(body.username, SESSION_MAX_AGE_SEC);
    const secure = env.NODE_ENV === "production";
    appendSetCookie(
      reply,
      `${ADMIN_SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SEC}${secure ? "; Secure" : ""}`
    );

    return { success: true, data: { username: body.username }, error: null };
  });

  app.post("/api/admin/auth/logout", async (_request, reply) => {
    const secure = env.NODE_ENV === "production";
    appendSetCookie(
      reply,
      `${ADMIN_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`
    );
    return { success: true, data: { ok: true }, error: null };
  });

  app.get("/api/admin/auth/me", async (request) => {
    const u = request.adminUser;
    return {
      success: true,
      data: {
        username: u?.username ?? null,
        via: u?.via ?? null
      },
      error: null
    };
  });
}
