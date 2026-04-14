# 手动联调脚本（Executor HTTP）

在 `server` 目录下执行，依赖已配置的 `server/.env`（至少 `DATABASE_URL`、`EXECUTOR_SHARED_TOKEN`、`DEFAULT_ROBOT_ID` / `MANUAL_ROBOT_ID`）。

## 环境变量

| 变量 | 说明 |
|------|------|
| `MANUAL_API_BASE_URL` | 默认 `http://127.0.0.1:3000` |
| `EXECUTOR_SHARED_TOKEN` | 与 Android「Executor Token」一致 |
| `MANUAL_ROBOT_ID` | 可选，默认用 `DEFAULT_ROBOT_ID` |
| `MANUAL_DEVICE_ID` | 可选，默认 `manual-device-1` |
| `MANUAL_DEVICE_NAME` | 仅 `register-device` 使用 |
| `MANUAL_TASK_ID` | `pull-task` 打印后填入，供 ack/result |
| `MANUAL_RESULT_STATUS` | `success` 或 `failed` |
| `MANUAL_CHAT_TITLE` / `MANUAL_INBOUND_TEXT` | `mock-inbound-event` |
| `MANUAL_TARGET_CHAT_TITLE` / `MANUAL_SEND_TEXT` | `create-test-send-task` |
| `ADMIN_TOKEN` | 仅创建测试发送任务脚本需要 |

## 推荐顺序（模拟全链路）

1. 启动数据库、Redis 与 `pnpm dev`（在 monorepo 根目录可用 `pnpm dev`）。
2. `pnpm manual:register-device` — 注册设备。
3. `pnpm manual:send-heartbeat` — 心跳（机器人在线状态由调度器读心跳推断）。
4. `pnpm manual:mock-inbound-event` — 模拟上行（是否产生自动回复取决于规则与 LLM，此处仅测接口）。
5. `pnpm manual:create-test-send-task` — 创建 `send_text` 任务（需 `ADMIN_TOKEN`）。
6. `pnpm manual:pull-task` — 拉取任务，按终端提示设置 `MANUAL_TASK_ID`。
7. `pnpm manual:ack-task` — 认领。
8. `MANUAL_RESULT_STATUS=success pnpm manual:report-task-result` — 上报结果。

Windows PowerShell 示例：

```powershell
$env:MANUAL_TASK_ID="cmxxxx"

pnpm manual:ack-task

pnpm manual:report-task-result

```

## 与真机关系

脚本与 Android App 调用同一套 `/api/executor/*` 接口；真机联调前可用脚本验证鉴权、任务状态机与 outbound 联动。
