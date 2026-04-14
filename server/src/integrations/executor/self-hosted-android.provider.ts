/**
 * 自建 Android 执行端：通过无障碍在企业微信 UI 层完成收发。
 * 不调用第三方商业机器人 API；任务由服务端 ExecutorTask 表驱动，设备轮询拉取。
 */
export const SELF_HOSTED_ANDROID_CAPABILITIES = ["send_text"] as const;
