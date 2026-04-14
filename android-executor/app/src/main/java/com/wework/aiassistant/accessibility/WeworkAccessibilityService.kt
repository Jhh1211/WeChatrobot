package com.wework.aiassistant.accessibility

import android.accessibilityservice.AccessibilityService
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import com.wework.aiassistant.data.MessageDedup
import com.wework.aiassistant.data.MessageUploader
import com.wework.aiassistant.accessibility.WeworkPage
import com.wework.aiassistant.executor.ExecutorRuntime
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * 安全边界（必读）：
 * - 不做抓包、协议逆向、自动登录、验证码绕过或风控规避。
 * - 仅在用户已登录的企业微信 **前台**，通过系统无障碍读取 UI。
 *
 * **入站消息**：仅当非消息列表（非 HOME/SESSION_LIST）、且判定为「会话聊天界面」时采集；发送成功后短窗内抑制误采。
 * **消息列表监听**（可配置）：在「消息」Tab 会话列表上自动点入「标题含群 + 未读」的行，进入聊天后再走入站上报。
 * **不支持**：后台、锁屏、仅通知栏、其他 App 前台；本服务未实现 NotificationListener，通知态不会触发上报。
 */
class WeworkAccessibilityService : AccessibilityService() {
  private val dedup = MessageDedup(500)
  private var lastDebugPrintAt = 0L
  private val serviceJob = SupervisorJob()
  /** 供 [MessageListWatchController] 等与入站共用 IO 协程域 */
  internal val serviceScope = CoroutineScope(Dispatchers.IO + serviceJob)

  override fun onServiceConnected() {
    super.onServiceConnected()
    Instance = this
    Log.i(TAG, "accessibility connected (inbound + optional message list watch; no notification listener)")
  }

  override fun onDestroy() {
    serviceJob.cancel()
    Instance = null
    super.onDestroy()
  }

  override fun onAccessibilityEvent(event: AccessibilityEvent?) {
    // event 为 null 时用 0 占位（避免依赖 API 34+ 的 AccessibilityEvent.TYPE_NULL）
    val evType = event?.eventType ?: 0
    Log.i(TAG, "inbound_capture eventType=${eventTypeToLabel(evType)}")

    val pkg = event?.packageName?.toString().orEmpty()
    Log.i(TAG, "inbound_capture packageName=$pkg")

    if (pkg != "com.tencent.wework") {
      Log.i(TAG, "inbound_capture ignored reason=not_wework packageName=$pkg")
      return
    }

    val cfg = ExecutorRuntime.config()
    if (cfg == null) {
      Log.w(TAG, "inbound_capture ignored reason=no_executor_config (open app and save server URL / register)")
      return
    }
    val deviceId = ExecutorRuntime.deviceId()
    if (deviceId == null) {
      Log.w(TAG, "inbound_capture ignored reason=no_device_id (complete device registration in app)")
      return
    }

    val root = rootInActiveWindow
    if (root == null) {
      Log.w(TAG, "inbound_capture ignored reason=no_root_window")
      return
    }

    try {
      val page = ChatPageDetector.detect(root)
      MessageListWatchController.scheduleScan(this, page)
      val inboundSurface = ChatPageDetector.isChatSurfaceForInbound(root)
      Log.i(TAG, "inbound_capture page=$page inboundChatSurface=$inboundSurface")

      if (!inboundSurface) {
        Log.i(TAG, "inbound_capture ignored reason=not_chat_page page=$page")
        return
      }

      if (page == WeworkPage.HOME || page == WeworkPage.SESSION_LIST) {
        Log.i(TAG, "inbound_capture ignored reason=list_page_not_chat page=$page")
        return
      }

      if (ExecutorRuntime.shouldSuppressInboundCapture()) {
        Log.i(TAG, "inbound_capture ignored reason=post_send_quiet_window")
        return
      }

      val titleBar = ChatPageDetector.guessChatBarTitle(root)
      val titleFallback = guessChatTitleShallow(root)
      val rawTitle = titleBar.ifBlank { titleFallback }
      val currentChatTitle = ChatPageDetector.normalizeGroupTitleForServer(rawTitle)
      Log.i(TAG, "inbound_capture currentChatTitle=$currentChatTitle (rawBar=$rawTitle)")

      val bubbles = MessageListParser.parseRecentMessages(root, maxItems = 12)
      val candidate = bubbles.lastOrNull()
      val candText = candidate?.text?.trim().orEmpty()
      Log.i(TAG, "inbound_capture candidateMessageText=${candText.take(160)}")

      if (candidate == null || candText.isBlank()) {
        Log.i(TAG, "inbound_capture ignored reason=parse_failed bubblesCount=${bubbles.size}")
        return
      }

      Log.i(
        TAG,
        "inbound_capture parsedMessage sender=${candidate.senderHint ?: "null"} text=${candText.take(200)} isFromSelf=${candidate.isFromSelf}"
      )

      if (ExecutorRuntime.matchesRecentSelfSentBubble(candText)) {
        Log.i(TAG, "inbound_capture ignored reason=recent_sent_payload_match")
        return
      }

      MessageUploader.tryUploadDispatch(
        scope = serviceScope,
        cfg = cfg,
        deviceId = deviceId,
        chatTitle = currentChatTitle,
        text = candText,
        senderName = candidate.senderHint,
        isFromSelf = candidate.isFromSelf,
        dedup = dedup
      )
    } finally {
      root.recycle()
    }

    if (cfg.debugPrintNodes) {
      val now = System.currentTimeMillis()
      if (now - lastDebugPrintAt >= 1200L) {
        lastDebugPrintAt = now
        val dbg = rootInActiveWindow
        try {
          NodePrinter.printTree(dbg, maxDepth = 10)
        } finally {
          dbg?.recycle()
        }
      }
    }
  }

  override fun onInterrupt() {}

  private fun guessChatTitleShallow(root: AccessibilityNodeInfo): String {
    val cands = mutableListOf<String>()
    fun walk(n: AccessibilityNodeInfo, d: Int) {
      if (d > 5) return
      val t = n.text?.toString()?.trim().orEmpty()
      if (t.length in 2..48) cands.add(t)
      for (i in 0 until n.childCount) {
        val c = n.getChild(i) ?: continue
        walk(c, d + 1)
        c.recycle()
      }
    }
    walk(root, 0)
    return cands.firstOrNull() ?: ""
  }

  private fun eventTypeToLabel(type: Int): String =
    when (type) {
      0 -> "NO_EVENT"
      AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> "WINDOW_STATE_CHANGED"
      AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED -> "WINDOW_CONTENT_CHANGED"
      AccessibilityEvent.TYPE_VIEW_SCROLLED -> "VIEW_SCROLLED"
      AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED -> "VIEW_TEXT_CHANGED"
      AccessibilityEvent.TYPE_VIEW_FOCUSED -> "VIEW_FOCUSED"
      AccessibilityEvent.TYPE_VIEW_CLICKED -> "VIEW_CLICKED"
      else -> "type_$type"
    }

  companion object {
    private const val TAG = "WeworkExecutor"
    @Volatile var Instance: WeworkAccessibilityService? = null
  }
}
