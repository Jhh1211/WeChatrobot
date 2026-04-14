package com.wework.aiassistant.service

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters

/** 占位：任务拉取由前台服务 5s 循环完成。 */
class TaskPullWorker(appContext: Context, params: WorkerParameters) : CoroutineWorker(appContext, params) {
  override suspend fun doWork(): Result = Result.success()
}
