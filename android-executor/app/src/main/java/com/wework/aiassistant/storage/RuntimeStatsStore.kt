package com.wework.aiassistant.storage

import java.text.SimpleDateFormat
import java.util.ArrayDeque
import java.util.Date
import java.util.Locale
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/**
 * 进程内最近上报 / 任务统计（重启清空）。持久化可后续接 DataStore。
 */
object RuntimeStatsStore {
  private val uploadCount = AtomicInteger(0)
  private val taskCount = AtomicInteger(0)
  private val lastHeartbeatAt = AtomicLong(0L)
  private val lastRegisterAt = AtomicLong(0L)

  private val recentUploads = ArrayDeque<String>(128)
  private val recentTasks = ArrayDeque<String>(64)
  private val recentDiags = ArrayDeque<String>(80)

  /** 联调诊断：保存 / 注册 / 心跳等一行摘要，进程内保留最近若干条。 */
  fun recordDiag(line: String) {
    synchronized(recentDiags) {
      while (recentDiags.size >= 64) recentDiags.removeFirst()
      recentDiags.addLast("${SimpleDateFormat("MM-dd HH:mm:ss", Locale.US).format(Date())} $line")
    }
  }

  fun recordUploadSummary(line: String) {
    uploadCount.incrementAndGet()
    synchronized(recentUploads) {
      while (recentUploads.size >= 100) recentUploads.removeFirst()
      recentUploads.addLast(line)
    }
  }

  fun recordTaskResult(line: String) {
    taskCount.incrementAndGet()
    synchronized(recentTasks) {
      while (recentTasks.size >= 50) recentTasks.removeFirst()
      recentTasks.addLast(line)
    }
  }

  fun markHeartbeat() {
    lastHeartbeatAt.set(System.currentTimeMillis())
  }

  fun markRegister() {
    lastRegisterAt.set(System.currentTimeMillis())
  }

  fun snapshot(): StatsSnapshot =
    StatsSnapshot(
      uploadCount = uploadCount.get(),
      taskCount = taskCount.get(),
      lastHeartbeatAt = lastHeartbeatAt.get(),
      lastRegisterAt = lastRegisterAt.get(),
      recentUploads = synchronized(recentUploads) { recentUploads.toList() },
      recentTasks = synchronized(recentTasks) { recentTasks.toList() },
      recentDiags = synchronized(recentDiags) { recentDiags.toList() }
    )
}

data class StatsSnapshot(
  val uploadCount: Int,
  val taskCount: Int,
  val lastHeartbeatAt: Long,
  val lastRegisterAt: Long,
  val recentUploads: List<String>,
  val recentTasks: List<String>,
  val recentDiags: List<String>
)
