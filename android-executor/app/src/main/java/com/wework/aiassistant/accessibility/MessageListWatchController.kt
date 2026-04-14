package com.wework.aiassistant.accessibility

import android.os.SystemClock
import android.util.Log
import com.wework.aiassistant.executor.ChatNavigator
import com.wework.aiassistant.executor.ExecutorRuntime
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * 在企微「消息」会话列表上：发现标题含「群」且带未读角标/条数的行则自动点入；
 * 与 [WeworkAccessibilityService] 事件驱动 + 防抖配合，避免与发送任务并发时重复点行。
 */
object MessageListWatchController {
  private val mutex = Mutex()
  private var lastScheduleUptime = 0L

  fun scheduleScan(service: WeworkAccessibilityService, page: WeworkPage) {
    val cfg = ExecutorRuntime.config() ?: return
    if (!cfg.messageListWatchEnabled) return
    if (page != WeworkPage.HOME && page != WeworkPage.SESSION_LIST) return
    val now = SystemClock.uptimeMillis()
    if (now - lastScheduleUptime < 480L) return
    lastScheduleUptime = now

    service.serviceScope.launch {
      mutex.withLock {
        delay(300)
        if (ExecutorRuntime.shouldSuppressMessageListWatch()) {
          Log.i("WeworkExecutor", "message_list_watch skipped reason=outbound_or_cooldown")
          return@withLock
        }
        if (ExecutorRuntime.shouldSuppressInboundCapture()) return@withLock
        val svc = WeworkAccessibilityService.Instance ?: return@withLock
        ChatNavigator.openFirstUnreadGroupConversation(svc)
      }
    }
  }
}
