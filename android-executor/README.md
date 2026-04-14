# android-executor

自建 Android 执行端：无障碍读取企业微信 UI、上报消息、拉取发送任务并自动发文本。

## 构建

使用 Android Studio 打开 `android-executor` 目录，同步 Gradle 后运行 `app`。

- minSdk 26，targetSdk 34
- 需真机 + 手动登录企业微信
- 在 App 内配置 Base URL、Executor Token、Robot ID

## 合规

仅用于用户本人设备与账号的 UI 自动化；禁止用于逆向、抓包、自动登录或绕过验证。
