import { executorFetch, loadManualEnv } from "./config.js";



async function main(): Promise<void> {

  const env = loadManualEnv();

  const out = (await executorFetch(env, "/api/executor/tasks/pull", {

    deviceId: env.deviceId,

    robotId: env.robotId,

    capability: ["send_text"]

  })) as { success?: boolean; data?: { task?: { id?: string } | null } };

  console.log(JSON.stringify(out, null, 2));

  const id = out.data?.task?.id;

  if (id) {

    console.error("\n# 将下列变量写入 .env 或在命令行导出后执行 ack/result：");

    console.error(`MANUAL_TASK_ID=${id}`);

    console.log(`SMOKE_TASK_ID=${id}`);

  }

}



main().catch((e) => {

  console.error(e);

  process.exit(1);

});

