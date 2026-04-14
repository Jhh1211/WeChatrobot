import { executorFetch, loadManualEnv } from "./config.js";



async function main(): Promise<void> {

  const env = loadManualEnv();

  const out = await executorFetch(env, "/api/executor/device/register", {

    deviceId: env.deviceId,

    robotId: env.robotId,

    name: process.env.MANUAL_DEVICE_NAME ?? "manual-script",

    appVersion: "manual-script",

    deviceModel: "node",

    androidVersion: "20",

    capability: ["send_text"]

  });

  console.log(JSON.stringify(out, null, 2));

}



main().catch((e) => {

  console.error(e);

  process.exit(1);

});


