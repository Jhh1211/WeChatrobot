package com.wework.aiassistant.service

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters

/**
 * 备用 Worker：主心跳由 [ExecutorForegroundService] 承担（30s）。
 * 可在此扩展为 WorkManager 周期任务（系统最小间隔约 15 分钟）。
 */
class HeartbeatWorker(appContext: Context, params: WorkerParameters) : CoroutineWorker(appContext, params) {
  override suspend fun doWork(): Result = Result.success()
}
