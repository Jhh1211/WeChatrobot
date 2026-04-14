package com.wework.aiassistant.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import com.wework.aiassistant.R
import com.wework.aiassistant.accessibility.WeworkAccessibilityService
import com.wework.aiassistant.data.LocalStore
import com.wework.aiassistant.diagnostics.toDiagSummary
import com.wework.aiassistant.executor.ExecutorRuntime
import com.wework.aiassistant.executor.SendTaskInput
import com.wework.aiassistant.executor.SendTextTaskExecutor
import com.wework.aiassistant.network.ApiClient
import com.wework.aiassistant.storage.RuntimeStatsStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

class ExecutorForegroundService : Service() {
  private val job = SupervisorJob()
  private val scope = CoroutineScope(Dispatchers.Default + job)

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    createChannel()
    startForeground(NOTIF_ID, buildNotification())
    scope.launch { heartbeatLoop() }
    scope.launch { taskLoop() }
    return START_STICKY
  }

  override fun onDestroy() {
    job.cancel()
    super.onDestroy()
  }

  private fun createChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val ch = NotificationChannel(CHANNEL_ID, "Executor", NotificationManager.IMPORTANCE_LOW)
      getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
    }
  }

  private fun buildNotification(): Notification {
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle(getString(R.string.app_name))
      .setContentText("心跳与任务拉取运行中")
      .setSmallIcon(R.drawable.ic_launcher_simple)
      .build()
  }

  private suspend fun heartbeatLoop() {
    while (scope.isActive) {
      try {
        val cfg = LocalStore.configFlow(this@ExecutorForegroundService).first()
        if (cfg != null) {
          val deviceId = LocalStore.getAndroidDeviceId(this@ExecutorForegroundService)
          ExecutorRuntime.update(cfg, deviceId)
          ApiClient.heartbeat(cfg, deviceId)
          RuntimeStatsStore.markHeartbeat()
        }
      } catch (e: Exception) {
        val d = e.toDiagSummary()
        Log.w(TAG, "后台心跳失败 $d", e)
        RuntimeStatsStore.recordDiag("后台心跳失败 $d")
      }
      delay(30_000)
    }
  }

  private suspend fun taskLoop() {
    while (scope.isActive) {
      try {
        val cfg = LocalStore.configFlow(this@ExecutorForegroundService).first()
        if (cfg == null) {
          delay(5000)
          continue
        }
        val deviceId = LocalStore.getAndroidDeviceId(this@ExecutorForegroundService)
        ExecutorRuntime.update(cfg, deviceId)
        val task = ApiClient.pullTask(cfg, deviceId)
        if (task == null) {
          delay(5000)
          continue
        }
        ApiClient.ackTask(cfg, task.id, deviceId)
        val svc = WeworkAccessibilityService.Instance
        if (svc == null) {
          ApiClient.resultTask(
            cfg,
            task.id,
            deviceId,
            ok = false,
            detail = buildJsonObject { put("reason", JsonPrimitive("no_accessibility")) },
            errorMessage = "no_accessibility"
          )
          delay(5000)
          continue
        }
        val payloadObj = task.payload as? JsonObject
        val result =
          SendTextTaskExecutor.run(
            svc,
            SendTaskInput(taskId = task.id, targetChatTitle = task.targetChatTitle, payload = payloadObj)
          )
        if (result.isSuccess) {
          ApiClient.resultTask(
            cfg,
            task.id,
            deviceId,
            ok = true,
            detail = buildJsonObject { put("ok", JsonPrimitive(true)) },
            errorMessage = null
          )
          RuntimeStatsStore.recordTaskResult("ok ${task.targetChatTitle}")
        } else {
          val err = result.exceptionOrNull()?.message ?: "failed"
          ApiClient.resultTask(
            cfg,
            task.id,
            deviceId,
            ok = false,
            detail = buildJsonObject { put("error", JsonPrimitive(err)) },
            errorMessage = err
          )
          RuntimeStatsStore.recordTaskResult("fail $err")
        }
      } catch (e: Exception) {
        Log.e(TAG, "task loop", e)
      }
      delay(5000)
    }
  }

  companion object {
    private const val TAG = "WeworkExecutor"
    private const val CHANNEL_ID = "executor_fg"
    private const val NOTIF_ID = 7101

    fun start(ctx: Context) {
      val i = Intent(ctx, ExecutorForegroundService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        ctx.startForegroundService(i)
      } else {
        ctx.startService(i)
      }
    }
  }
}
