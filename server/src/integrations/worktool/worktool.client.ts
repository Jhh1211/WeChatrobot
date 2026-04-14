import { AppError } from "../../common/errors/app-error.js";
import type { WorkToolApiResponse, WorkToolSendMessageRequest } from "./worktool.types.js";

/**
 * @deprecated 商业 WorkTool 接口已废弃。主链路请使用自建 Android 执行端（ExecutorTask + /api/executor/*）。
 * 保留此类仅为历史代码兼容，任何调用都会抛出 410。
 */
function notAvailable(): never {
  throw new AppError(
    "WorkTool commercial API provider is deprecated. Use self-hosted Android executor.",
    410,
    "WORKTOOL_DEPRECATED"
  );
}

export class WorkToolClient {
  async configureMessageCallback(_callbackUrl: string): Promise<WorkToolApiResponse> {
    notAvailable();
  }

  async queryCallbackConfig(): Promise<WorkToolApiResponse> {
    notAvailable();
  }

  async queryRobotOnlineStatus(): Promise<WorkToolApiResponse> {
    notAvailable();
  }

  async queryRobotLoginLogs(): Promise<WorkToolApiResponse> {
    notAvailable();
  }

  async sendRawMessage(_request: WorkToolSendMessageRequest): Promise<WorkToolApiResponse> {
    notAvailable();
  }

  async queryHistoryMessages(_params: { startTime: string; endTime: string }): Promise<WorkToolApiResponse> {
    notAvailable();
  }

  async queryCallbackLogs(_params: { startTime: string; endTime: string }): Promise<WorkToolApiResponse> {
    notAvailable();
  }
}

/** @deprecated 不再用于主链路成功判定 */
export function isWorkToolApiSuccess(_response: WorkToolApiResponse): boolean {
  return false;
}

export const workToolClient = new WorkToolClient();
