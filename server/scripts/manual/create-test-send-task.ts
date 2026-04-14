import "dotenv/config";

import { loadManualEnv } from "./config.js";



async function adminFetch(

  baseUrl: string,

  adminToken: string,

  path: string,

  body: Record<string, unknown>

): Promise<unknown> {

  const url = `${baseUrl}${path}`;

  const res = await fetch(url, {

    method: "POST",

    headers: {

      "Content-Type": "application/json",

      Authorization: `Bearer ${adminToken}`

    },

    body: JSON.stringify(body)

  });

  const text = await res.text();

  let json: unknown;

  try {

    json = JSON.parse(text) as unknown;

  } catch {

    throw new Error(`非 JSON 响应 HTTP ${res.status}: ${text.slice(0, 500)}`);

  }

  if (!res.ok) {

    throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);

  }

  return json;

}



async function main(): Promise<void> {

  const env = loadManualEnv();

  const adminToken = env.adminToken;

  if (!adminToken) {

    throw new Error("请配置 ADMIN_TOKEN（与 server/.env 一致）");

  }

  const targetChatTitle = process.env.MANUAL_TARGET_CHAT_TITLE ?? "测试群";

  const text = process.env.MANUAL_SEND_TEXT ?? "manual hello";

  const out = await adminFetch(env.baseUrl, adminToken, "/api/admin/test/create-send-task", {

    robotId: env.robotId,

    targetChatTitle,

    text

  });

  console.log(JSON.stringify(out, null, 2));

}



main().catch((e) => {

  console.error(e);

  process.exit(1);

});


