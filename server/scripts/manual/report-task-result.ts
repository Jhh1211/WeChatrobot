import { executorFetch, loadManualEnv } from "./config.js";



async function main(): Promise<void> {

  const env = loadManualEnv();

  const taskId = env.taskId;

  if (!taskId) {

    throw new Error("请设置环境变量 MANUAL_TASK_ID");

  }

  const status = env.resultStatus ?? "success";

  const out = await executorFetch(env, `/api/executor/tasks/${taskId}/result`, {

    deviceId: env.deviceId,

    status,

    detail: { source: "manual-script" },

    executedAt: new Date().toISOString(),

    errorMessage: status === "failed" ? process.env.MANUAL_ERROR_MESSAGE ?? "manual fail" : null

  });

  console.log(JSON.stringify(out, null, 2));

}



main().catch((e) => {

  console.error(e);

  process.exit(1);

});


