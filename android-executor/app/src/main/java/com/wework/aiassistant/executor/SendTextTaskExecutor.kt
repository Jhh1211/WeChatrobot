package com.wework.aiassistant.executor

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import com.wework.aiassistant.accessibility.AtMentionPicker
import com.wework.aiassistant.accessibility.ChatPageDetector
import com.wework.aiassistant.accessibility.InputBoxFinder
import com.wework.aiassistant.accessibility.SendButtonFinder
import com.wework.aiassistant.accessibility.SendVerifyHelper
import kotlin.coroutines.resume
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive

data class SendTaskInput(
  val taskId: String,
  val targetChatTitle: String,
  val payload: JsonObject?
)

object SendTextTaskExecutor {
  private const val TAG = "WeworkExecutor"
  private const val WEWORK_PKG = "com.tencent.wework"

  private fun requireWeworkRoot(root: AccessibilityNodeInfo, stage: String): Boolean {
    val pkg = root.packageName?.toString()
    Log.i(TAG, "send $stage foreground package=$pkg")
    if (pkg != WEWORK_PKG) {
      Log.e(TAG, "wrong_foreground_package send stage=$stage pkg=$pkg")
      return false
    }
    return true
  }

  suspend fun run(service: AccessibilityService, input: SendTaskInput): Result<Unit> {
    ExecutorRuntime.markOutboundSendStarted()
    try {
      val returnToList = ExecutorRuntime.config()?.messageListWatchEnabled == true
      val result = runImpl(service, input)
      if (returnToList) {
        try {
          ChatNavigator.returnToMessageList(service)
        } catch (e: Exception) {
          Log.w(TAG, "returnToMessageList failed", e)
        }
      }
      return result
    } finally {
      ExecutorRuntime.markOutboundSendFinished()
    }
  }

  private suspend fun runImpl(service: AccessibilityService, input: SendTaskInput): Result<Unit> {
    val text =
      input.payload?.get("text")?.let { el ->
        if (el is JsonPrimitive && el.isString) el.content else null
      }
        ?: return Result.failure(IllegalArgumentException("payload.text missing"))

    val payloadLen = text.length
    Log.i(TAG, "send start taskId=${input.taskId} targetChatTitle=\"${input.targetChatTitle}\" payloadLen=$payloadLen")

    val rowFpBlacklist = mutableSetOf<String>()
    val maxOpenPhases = 3
    var edit: AccessibilityNodeInfo? = null

    openPhases@ for (openPhase in 0 until maxOpenPhases) {
      if (!ChatNavigator.openChatBySearch(service, input.targetChatTitle, rowFpBlacklist)) {
        val reason = ChatNavigator.consumeLastOpenChatFailure() ?: "open_chat_failed"
        Log.e(TAG, "send aborted openChat failed reason=$reason targetChatTitle=\"${input.targetChatTitle}\" payloadLen=$payloadLen taskId=${input.taskId} phase=$openPhase")
        when (reason) {
          "stuck_on_home_without_match",
          "open_chat_failed_still_home",
          "title_false_positive",
          "search_entry_clicked_but_not_enter_search_mode",
          "open_chat_failed_not_in_chat",
          "open_chat_timeout",
          "open_chat_circuit_breaker",
          "wrong_foreground_package" ->
            Log.e(TAG, "send openChat detail reason=$reason taskId=${input.taskId} targetChatTitle=\"${input.targetChatTitle}\"")
        }
        return Result.failure(IllegalStateException(reason))
      }

      delay(600)
      Log.i(TAG, "final send stage start taskId=${input.taskId} targetChatTitle=\"${input.targetChatTitle}\" payloadLen=$payloadLen phase=$openPhase")

      val waitDeadline = SystemClock.uptimeMillis() + 4000L
      val waitStepMs = 500L
      var waitIndex = 0
      while (SystemClock.uptimeMillis() < waitDeadline && edit == null) {
        val rootLoop = service.rootInActiveWindow
        if (rootLoop == null) {
          Log.w(TAG, "chat_pending_wait_retry index=$waitIndex no_root phase=$openPhase")
          delay(waitStepMs)
          waitIndex++
          continue
        }
        try {
          if (!requireWeworkRoot(rootLoop, "chat_pending_wait")) {
            Log.e(TAG, "final send stage fail reason=wrong_foreground_package")
            return Result.failure(IllegalStateException("wrong_foreground_package"))
          }
          val bar = ChatPageDetector.guessChatBarTitle(rootLoop)
          if (!ChatPageDetector.chatTitleMatchesExpected(bar, input.targetChatTitle)) {
            Log.w(
              TAG,
              "send reopen_search title_mismatch_in_wait phase=$openPhase bar=\"$bar\" expected=\"${input.targetChatTitle}\""
            )
            ChatNavigator.leaveChatForOutboundRetry(service, rowFpBlacklist, null)
            continue@openPhases
          }
          Log.i(TAG, "chat_pending_wait_retry index=$waitIndex phase=$openPhase")
          val cand = InputBoxFinder.findForChatPending(rootLoop)
          val found = cand != null
          Log.i(TAG, "find_input_in_chat_pending found=$found")
          if (cand != null) {
            edit = AccessibilityNodeInfo.obtain(cand)
            Log.i(TAG, "send stage accepted from chat_pending waitIndex=$waitIndex phase=$openPhase")
          }
        } finally {
          rootLoop.recycle()
        }
        if (edit == null) {
          delay(waitStepMs)
          waitIndex++
        }
      }

      if (edit != null) break@openPhases
      Log.w(TAG, "send open_phase_timeout_no_input phase=$openPhase targetChatTitle=\"${input.targetChatTitle}\"")
      ChatNavigator.leaveChatForOutboundRetry(service, rowFpBlacklist, null)
    }

    if (edit == null) {
      Log.e(TAG, "final send stage fail reason=no_input_after_chat_pending_wait targetChatTitle=\"${input.targetChatTitle}\"")
      return Result.failure(IllegalStateException("not_chat_after_open"))
    }

    val payloadObj = input.payload
    val mentionUi = payloadObj != null && jsonTruthy(payloadObj, "mentionUi")
    val mentionSearch = payloadObj?.let { jsonString(it, "mentionSearchQuery") }
    val mentionMatch = payloadObj?.let { jsonString(it, "mentionMatchLabel") }
    val useMention =
      mentionUi &&
        !mentionSearch.isNullOrBlank() &&
        !mentionMatch.isNullOrBlank()

    var mentionOk = false
    try {
      val editPkg = edit.packageName?.toString()
      Log.i(TAG, "send setText target node package=$editPkg mentionUi=$useMention")
      if (editPkg != WEWORK_PKG) {
        Log.e(TAG, "blocked_non_wework_input editPkg=$editPkg")
        Log.e(TAG, "final send stage fail reason=blocked_non_wework_input")
        return Result.failure(IllegalStateException("blocked_non_wework_input"))
      }

      if (useMention) {
        mentionOk = AtMentionPicker.complete(service, edit, mentionSearch!!, mentionMatch!!)
        Log.i(TAG, "send mention_flow_done ok=$mentionOk taskId=${input.taskId}")
      } else {
        val setOk = setText(edit, text)
        Log.i(TAG, "send input hit=editable setTextOk=$setOk payloadLen=$payloadLen")
      }
    } finally {
      edit.recycle()
      edit = null
    }

    if (useMention) {
      delay(280)
      val rootFill = service.rootInActiveWindow
      var refill: AccessibilityNodeInfo? = null
      if (rootFill != null) {
        try {
          if (!requireWeworkRoot(rootFill, "mention_refill")) {
            return Result.failure(IllegalStateException("wrong_foreground_package"))
          }
          val cand = InputBoxFinder.findForChatPending(rootFill)
          if (cand != null) refill = AccessibilityNodeInfo.obtain(cand)
        } finally {
          rootFill.recycle()
        }
      }
      if (refill != null) {
        try {
          val rpkg = refill.packageName?.toString()
          if (rpkg != WEWORK_PKG) {
            Log.e(TAG, "mention_refill blocked pkg=$rpkg")
            return Result.failure(IllegalStateException("blocked_non_wework_input"))
          }
          if (!mentionOk) {
            setText(refill, text)
            Log.i(TAG, "send mention_failed_use_plain_text")
          } else {
            val base = refill.text?.toString().orEmpty()
            val combined =
              when {
                base.isEmpty() -> text
                base.endsWith(text) -> base
                base.last().isWhitespace() -> base + text
                text.isNotEmpty() && text.first().isWhitespace() -> base + text
                else -> "$base $text"
              }
            val setOk = setText(refill, combined)
            Log.i(TAG, "send mention_refill setOk=$setOk baseLen=${base.length} outLen=${combined.length}")
            if (!setOk) {
              Log.e(TAG, "mention_refill_set_failed fallback_plain")
              service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
              delay(200)
              val r2 = service.rootInActiveWindow
              if (r2 != null) {
                try {
                  val c2 = InputBoxFinder.findForChatPending(r2)
                  if (c2 != null) {
                    try {
                      setText(c2, text)
                    } finally {
                      c2.recycle()
                    }
                  }
                } finally {
                  r2.recycle()
                }
              }
            }
          }
        } finally {
          refill.recycle()
        }
      } else {
        Log.w(TAG, "mention_refill_no_input fallback_plain")
        val r2 = service.rootInActiveWindow
        if (r2 != null) {
          try {
            val c2 = InputBoxFinder.findForChatPending(r2)
            if (c2 != null) {
              try {
                setText(c2, text)
              } finally {
                c2.recycle()
              }
            }
          } finally {
            r2.recycle()
          }
        }
      }
    }

    delay(400)
    var sendClicked = false
    var sendIdx = 0
    while (sendIdx < 8 && !sendClicked) {
      val root2 = service.rootInActiveWindow ?: break
      try {
        if (!requireWeworkRoot(root2, "pre_send")) {
          Log.e(TAG, "final send stage fail reason=wrong_foreground_package_pre_send")
          return Result.failure(IllegalStateException("wrong_foreground_package"))
        }
        val page = ChatPageDetector.detect(root2)
        val send = SendButtonFinder.find(root2)
        if (send != null) {
          val clickOk = send.performAction(AccessibilityNodeInfo.ACTION_CLICK)
          Log.i(TAG, "send hit=sendButton clickOk=$clickOk page=$page payloadLen=$payloadLen sendIdx=$sendIdx")
          send.recycle()
          sendClicked = true
          // 气泡会先于 verify 出现在列表；pending 用于首帧入站与 payload 对齐（含 UI 文首 @昵称）
          ExecutorRuntime.markPendingOutboundBubbleMatch(text)
        }
      } finally {
        root2.recycle()
      }
      if (!sendClicked) {
        delay(400)
        sendIdx++
      }
    }

    if (!sendClicked) {
      Log.e(TAG, "final send stage fail reason=no_send_after_retries targetChatTitle=\"${input.targetChatTitle}\"")
      return Result.failure(IllegalStateException("no_send"))
    }

    delay(1200)
    val root3 = service.rootInActiveWindow
    if (root3 == null) {
      ExecutorRuntime.clearPendingOutboundBubbleMatch()
      return Result.failure(IllegalStateException("no_root3"))
    }
    try {
      if (!requireWeworkRoot(root3, "verify")) {
        Log.e(TAG, "final send stage fail reason=wrong_foreground_package_verify")
        ExecutorRuntime.clearPendingOutboundBubbleMatch()
        return Result.failure(IllegalStateException("wrong_foreground_package"))
      }
      val page = ChatPageDetector.detect(root3)
      Log.i(TAG, "send verify page=$page payloadLen=$payloadLen targetChatTitle=\"${input.targetChatTitle}\"")
      when (val vr = SendVerifyHelper.verifyAfterSend(root3, text, input.targetChatTitle)) {
        is SendVerifyHelper.Result.Ok -> {
          Log.i(TAG, "final send stage success reason=${vr.reason}")
          tapChatAreaToDismissIme(service)
          ExecutorRuntime.markPostSendQuiet(text)
          return Result.success(Unit)
        }
        is SendVerifyHelper.Result.Fail -> {
          Log.e(TAG, "final send stage fail reason=${vr.reason}")
          ExecutorRuntime.clearPendingOutboundBubbleMatch()
          return Result.failure(IllegalStateException(vr.reason))
        }
      }
    } finally {
      root3.recycle()
    }
  }

  /**
   * 发送成功后点一下消息区中上方（相当于用户点空白处），让输入框失焦以收起键盘，
   * 避免焦点一直留在输入框导致后续误判搜索页等。
   */
  private suspend fun tapChatAreaToDismissIme(service: AccessibilityService) {
    if (Build.VERSION.SDK_INT < 24) {
      Log.i(TAG, "tap_dismiss_ime skip api=${Build.VERSION.SDK_INT}")
      return
    }
    val dm = service.resources.displayMetrics
    val x = dm.widthPixels / 2f
    val y = (dm.heightPixels * 0.32f).coerceIn(160f, dm.heightPixels * 0.55f)
    val path = Path().apply { moveTo(x, y) }
    val stroke = GestureDescription.StrokeDescription(path, 0, 50)
    val gesture = GestureDescription.Builder().addStroke(stroke).build()
    suspendCancellableCoroutine { cont ->
      val ok =
        service.dispatchGesture(
          gesture,
          object : AccessibilityService.GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription?) {
              cont.resume(Unit)
            }

            override fun onCancelled(gestureDescription: GestureDescription?) {
              cont.resume(Unit)
            }
          },
          null
        )
      if (!ok) {
        Log.w(TAG, "tap_dismiss_ime dispatchGesture=false")
        cont.resume(Unit)
      }
    }
    delay(200)
    Log.i(TAG, "tap_dismiss_ime done x=$x y=$y")
  }

  private fun setText(node: AccessibilityNodeInfo, text: String): Boolean {
    val args = Bundle()
    args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
    return node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
  }

  private fun jsonString(obj: JsonObject, key: String): String? {
    val el = obj[key] ?: return null
    return if (el is JsonPrimitive && el.isString) el.content.trim().takeIf { it.isNotEmpty() } else null
  }

  private fun jsonTruthy(obj: JsonObject, key: String): Boolean {
    val el = obj[key] as? JsonPrimitive ?: return false
    // kotlinx JsonPrimitive：boolean true 的 content 亦为 "true"
    return el.content.equals("true", ignoreCase = true) || el.content == "1"
  }
}
