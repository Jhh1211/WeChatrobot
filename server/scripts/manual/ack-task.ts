import { executorFetch, loadManualEnv } from "./config.js";



async function main(): Promise<void> {

  const env = loadManualEnv();

  const taskId = env.taskId;

  if (!taskId) {

    throw new Error("请设置环境变量 MANUAL_TASK_ID（可先运行 pull-task.ts）");

  }

  const out = await executorFetch(env, `/api/executor/tasks/${taskId}/ack`, {

    deviceId: env.deviceId

  });

  console.log(JSON.stringify(out, null, 2));

}



main().catch((e) => {

  console.error(e);

  process.exit(1);

});


