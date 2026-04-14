package com.wework.aiassistant.executor

import com.wework.aiassistant.data.ExecutorConfig
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

object ExecutorRuntime {
  private val cfgRef = AtomicReference<ExecutorConfig?>(null)
  private val deviceRef = AtomicReference<String?>(null)

  /** 外发任务从拉取到执行完毕（含 returnToMessageList）整段为 true，禁止消息列表监听抢点 */
  private val outboundSendInProgress = AtomicBoolean(false)

  /** 回到会话列表后的冷却：避免与 returnToMessageList 动画叠加以致误点未读行 */
  private val messageListWatchSuppressedUntilMs = AtomicLong(0L)

  /** 发送成功后短窗内抑制误采（回列表/刷新时把己方气泡当对方） */
  private val inboundQuietUntilEpochMs = AtomicLong(0L)
  private val lastSentNormalizedRef = AtomicReference<String?>(null)
  private val lastSentMatchUntilEpochMs = AtomicLong(0L)

  /**
   * 点击「发送」后、验证完成前，气泡已出现在列表但 lastSent 尚未写入；用 pending 与入站候选比对，避免自发自收首帧上报。
   */
  private val pendingOutboundNormalizedRef = AtomicReference<String?>(null)
  private val pendingOutboundMatchUntilEpochMs = AtomicLong(0L)

  fun update(cfg: ExecutorConfig?, deviceId: String?) {
    cfgRef.set(cfg)
    deviceRef.set(deviceId)
  }

  fun config(): ExecutorConfig? = cfgRef.get()

  fun deviceId(): String? = deviceRef.get()

  fun markPostSendQuiet(sentText: String, quietMs: Long = 4500L, sentMatchTtlMs: Long = 120_000L) {
    val now = System.currentTimeMillis()
    inboundQuietUntilEpochMs.set(now + quietMs)
    val n = normalizeForInboundMatch(sentText)
    if (n.isNotEmpty()) {
      lastSentNormalizedRef.set(n)
      lastSentMatchUntilEpochMs.set(now + sentMatchTtlMs)
    }
    clearPendingOutboundBubbleMatch()
  }

  /** 发送按钮已点击、消息即将/已经出现在会话列表时调用，早于 verify 完成。 */
  fun markPendingOutboundBubbleMatch(sentText: String, ttlMs: Long = 90_000L) {
    val now = System.currentTimeMillis()
    val n = normalizeForInboundMatch(sentText)
    if (n.isEmpty()) return
    pendingOutboundNormalizedRef.set(n)
    pendingOutboundMatchUntilEpochMs.set(now + ttlMs.coerceAtLeast(5000L))
  }

  fun clearPendingOutboundBubbleMatch() {
    pendingOutboundNormalizedRef.set(null)
    pendingOutboundMatchUntilEpochMs.set(0L)
  }

  fun shouldSuppressInboundCapture(): Boolean = System.currentTimeMillis() < inboundQuietUntilEpochMs.get()

  fun markOutboundSendStarted() {
    outboundSendInProgress.set(true)
  }

  /**
   * 外发任务结束（成功或失败均调用）。释放互斥并启动消息列表监听冷却。
   * @param listWatchCooldownMs 回到消息列表后多久内不自动点未读群（毫秒）
   */
  fun markOutboundSendFinished(listWatchCooldownMs: Long = 3200L) {
    outboundSendInProgress.set(false)
    val until = System.currentTimeMillis() + listWatchCooldownMs.coerceAtLeast(0L)
    messageListWatchSuppressedUntilMs.updateAndGet { prev -> maxOf(prev, until) }
  }

  fun shouldSuppressMessageListWatch(): Boolean {
    if (outboundSendInProgress.get()) return true
    return System.currentTimeMillis() < messageListWatchSuppressedUntilMs.get()
  }

  fun matchesRecentSelfSentBubble(candidateText: String): Boolean {
    val n = normalizeForInboundMatch(candidateText)
    if (n.isEmpty()) return false
    val now = System.currentTimeMillis()

    val pending = pendingOutboundNormalizedRef.get()
    if (pending != null && now < pendingOutboundMatchUntilEpochMs.get()) {
      if (n == pending || bubbleTextLikelySameAfterUiTruncate(n, pending)) return true
    }

    val target = lastSentNormalizedRef.get() ?: return false
    if (now >= lastSentMatchUntilEpochMs.get()) return false
    return n == target || bubbleTextLikelySameAfterUiTruncate(n, target)
  }

  /**
   * 列表里气泡可能被截断；若一方是另一方前缀且主体足够长，仍视为同一条己方消息。
   */
  private fun bubbleTextLikelySameAfterUiTruncate(a: String, b: String): Boolean {
    val minCore = 48
    if (a.length < minCore || b.length < minCore) return false
    return a.startsWith(b) || b.startsWith(a)
  }

  /**
   * 剥除文首 @昵称（半角/全角），企微常把 mention 芯片渲染在气泡正文前，与 payload.text 不一致。
   */
  private fun stripLeadingInlineMentions(s: String): String {
    var t = s.trim()
    repeat(3) {
      val next = t.replaceFirst(Regex("""^[@＠]\S+\s+"""), "").trim()
      if (next == t) return@repeat
      t = next
    }
    return t
  }

  private fun normalizeForInboundMatch(s: String): String {
    return stripLeadingInlineMentions(s).lowercase().replace(Regex("\\s+"), " ")
  }
}
