import { executorFetch, loadManualEnv } from "./config.js";



async function main(): Promise<void> {

  const env = loadManualEnv();

  const out = await executorFetch(env, "/api/executor/device/heartbeat", {

    deviceId: env.deviceId,

    robotId: env.robotId,

    status: "online",

    detail: { source: "manual-script" }

  });

  console.log(JSON.stringify(out, null, 2));

}



main().catch((e) => {

  console.error(e);

  process.exit(1);

});


