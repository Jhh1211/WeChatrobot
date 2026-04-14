import "dotenv/config";



export type ManualEnv = {

  baseUrl: string;

  executorToken: string;

  robotId: string;

  deviceId: string;

  adminToken?: string;

  taskId?: string;

  resultStatus?: "success" | "failed";

};



export function loadManualEnv(): ManualEnv {

  const baseUrl = (process.env.MANUAL_API_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");

  const executorToken = process.env.EXECUTOR_SHARED_TOKEN ?? "";

  const robotId = process.env.MANUAL_ROBOT_ID ?? process.env.DEFAULT_ROBOT_ID ?? "default_robot";

  const deviceId = process.env.MANUAL_DEVICE_ID ?? "manual-device-1";

  if (!executorToken) {

    throw new Error("请在 server/.env 配置 EXECUTOR_SHARED_TOKEN（与 App Executor Token 一致）");

  }

  return {

    baseUrl,

    executorToken,

    robotId,

    deviceId,

    adminToken: process.env.ADMIN_TOKEN,

    taskId: process.env.MANUAL_TASK_ID,

    resultStatus: (process.env.MANUAL_RESULT_STATUS as "success" | "failed") || "success"

  };

}



export async function executorFetch(

  env: ManualEnv,

  path: string,

  body: Record<string, unknown>

): Promise<unknown> {

  const url = `${env.baseUrl}${path}`;

  const res = await fetch(url, {

    method: "POST",

    headers: {

      "Content-Type": "application/json",

      Authorization: `Bearer ${env.executorToken}`

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


