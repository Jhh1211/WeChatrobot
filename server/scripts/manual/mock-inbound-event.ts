import { executorFetch, loadManualEnv } from "./config.js";



async function main(): Promise<void> {

  const env = loadManualEnv();

  const text = process.env.MANUAL_INBOUND_TEXT ?? "hello from manual script";

  const chatTitle = process.env.MANUAL_CHAT_TITLE ?? "测试群";

  const out = await executorFetch(env, "/api/executor/inbound-events", {

    deviceId: env.deviceId,

    robotId: env.robotId,

    source: "manual_script",

    rawPayload: { hello: true, at: new Date().toISOString() },

    normalizedMessage: {

      chatTitle,

      senderName: "脚本用户",

      text,

      timestamp: new Date().toISOString(),

      isFromSelf: false,

      messageType: "text"

    }

  });

  console.log(JSON.stringify(out, null, 2));

}



main().catch((e) => {

  console.error(e);

  process.exit(1);

});


