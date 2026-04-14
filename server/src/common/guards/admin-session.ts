import crypto from "node:crypto";
import { env } from "../config/env.js";

export const ADMIN_SESSION_COOKIE = "admin_session";

function sessionSecret(): string {
  const custom = env.ADMIN_SESSION_SECRET?.trim();
  if (custom) return custom;
  return `${env.ADMIN_TOKEN}:admin_session`;
}

export function createAdminSessionToken(username: string, maxAgeSeconds: number): string {
  const exp = Math.floor(Date.now() / 1000) + maxAgeSeconds;
  const payload = Buffer.from(JSON.stringify({ u: username, exp }), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyAdminSessionToken(token: string): { username: string } | null {
  const i = token.lastIndexOf(".");
  if (i <= 0) return null;
  const payloadB64 = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expected = crypto.createHmac("sha256", sessionSecret()).update(payloadB64).digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const json = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as { u: string; exp: number };
    if (typeof json.exp !== "number" || json.exp < Math.floor(Date.now() / 1000)) return null;
    if (typeof json.u !== "string" || !json.u) return null;
    return { username: json.u };
  } catch {
    return null;
  }
}

export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

export function timingSafeEqualUtf8(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
