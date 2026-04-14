package com.wework.aiassistant.accessibility

import android.graphics.Rect
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo

/**
 * 发送后校验：排除底部工具栏/扩展面板文案，优先在消息区匹配 payload，否则弱校验输入清空 + 发送键状态。
 */
object SendVerifyHelper {
  private const val TAG = "WeworkExecutor"

  private val EXTENSION_LABELS =
    setOf("商品图册", "快捷回复", "推荐客服", "发起收款")

  private val TOOLBAR_LABELS =
    setOf(
      "按住说话",
      "发消息",
      "发送",
      "语音",
      "表情",
      "更多",
      "相册",
      "拍摄",
      "文件",
      "搜索",
      "返回",
      "消息"
    )

  sealed class Result {
    data class Ok(val reason: String) : Result()
    data class Fail(val reason: String) : Result()
  }

  fun verifyAfterSend(
    root: AccessibilityNodeInfo,
    payloadText: String,
    targetChatTitle: String
  ): Result {
    val want = payloadText.trim()
    val rootRect = Rect()
    root.getBoundsInScreen(rootRect)
    val h = rootRect.height().coerceAtLeast(1)
    val messageZoneBottomY = rootRect.top + (h * 0.52f).toInt()

    val candidates = mutableListOf<String>()
    fun walk(n: AccessibilityNodeInfo, depth: Int) {
      if (depth > 26) return
      val t = n.text?.toString()?.trim().orEmpty()
      if (t.isNotEmpty() && n.childCount == 0) {
        when {
          EXTENSION_LABELS.any { lab -> t == lab || t.contains(lab) } ->
            Log.i(TAG, "verify_ignore_extension_panel text=\"${t.take(48)}\"")
          TOOLBAR_LABELS.any { lab -> t == lab || t.contains(lab) } ->
            Log.i(TAG, "verify_ignore_toolbar_text text=\"${t.take(48)}\"")
          else -> {
            val r = Rect()
            n.getBoundsInScreen(r)
            if (r.centerY() > messageZoneBottomY) {
              if (t.length >= 2) {
                Log.i(TAG, "verify_ignore_bottom_zone_text text=\"${t.take(48)}\"")
              }
            } else if (t.length >= 2 && t.length < 800) {
              candidates.add(t)
            }
          }
        }
      }
      for (i in 0 until n.childCount) {
        val c = n.getChild(i) ?: continue
        walk(c, depth + 1)
        c.recycle()
      }
    }
    walk(root, 0)

    val candSummary = candidates.take(16).joinToString(" | ") { it.take(32).replace('\n', ' ') }
    Log.i(TAG, "verify_message_candidates=$candSummary")

    for (c in candidates.asReversed()) {
      if (c.equals(want, ignoreCase = true) || c.contains(want, ignoreCase = true)) {
        Log.i(TAG, "verify_outgoing_bubble_match text=\"${want.take(80)}\"")
        return Result.Ok("outgoing_bubble_matched")
      }
    }

    val bar = ChatPageDetector.guessChatBarTitle(root)
    val titleOk = ChatPageDetector.chatTitleMatchesExpected(bar, targetChatTitle)

    var inputCleared = false
    val edit = NodeFinder.findEditable(root)
    if (edit != null) {
      try {
        val et = edit.text?.toString()?.trim().orEmpty()
        inputCleared = et.isEmpty() || !et.equals(want, ignoreCase = true)
      } finally {
        edit.recycle()
      }
    }
    Log.i(TAG, "verify_input_cleared=$inputCleared")

    val send = SendButtonFinder.find(root)
    val sendState =
      when {
        send == null -> "gone"
        !send.isEnabled -> "disabled"
        else -> "visible_enabled"
      }
    send?.recycle()
    Log.i(TAG, "verify_send_button_state=$sendState")

    val sendOkForWeak = sendState == "gone" || sendState == "disabled"
    if (titleOk && inputCleared && sendOkForWeak) {
      return Result.Ok("input_cleared_after_send")
    }

    return Result.Fail("verify_failed no_bubble_match weak_checks titleOk=$titleOk inputCleared=$inputCleared sendState=$sendState")
  }
}
