import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../config/env.js";
import {
  ADMIN_SESSION_COOKIE,
  parseCookieHeader,
  timingSafeEqualUtf8,
  verifyAdminSessionToken
} from "./admin-session.js";

declare module "fastify" {
  interface FastifyRequest {
    adminUser?: { username: string; via: "password_session" | "bearer_token" };
  }
}

/**
 * 管理端鉴权：Bearer ADMIN_TOKEN（脚本/兼容）或 HttpOnly Session Cookie（浏览器登录）。
 * 失败时返回 401 的 reply，成功返回 undefined。
 */
export async function adminAuthGuard(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply | undefined> {
  const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, "")?.trim();
  if (bearer && timingSafeEqualUtf8(bearer, env.ADMIN_TOKEN)) {
    request.adminUser = { username: "bearer", via: "bearer_token" };
    return undefined;
  }

  const cookies = parseCookieHeader(request.headers.cookie);
  const raw = cookies[ADMIN_SESSION_COOKIE];
  if (raw) {
    const v = verifyAdminSessionToken(raw);
    if (v) {
      request.adminUser = { username: v.username, via: "password_session" };
      return undefined;
    }
  }

  return reply.status(401).send({
    success: false,
    data: null,
    error: { code: "UNAUTHORIZED", message: "invalid admin token or session" }
  });
}
