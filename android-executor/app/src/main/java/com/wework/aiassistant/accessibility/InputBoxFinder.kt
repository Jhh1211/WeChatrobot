package com.wework.aiassistant.accessibility

import android.graphics.Rect
import android.os.Build
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo

object InputBoxFinder {
  private const val TAG = "WeworkExecutor"

  fun find(root: AccessibilityNodeInfo?): AccessibilityNodeInfo? = findForChatPending(root)

  /**
   * 群聊页输入区：可编辑节点、EditText/AppCompatEditText、hint/desc 含「发消息」。
   */
  fun findForChatPending(root: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
    if (root == null) return null
    NodeFinder.findEditable(root)?.let {
      logInputCandidate(it, "editable")
      return it
    }
    NodeFinder.dfs(root) { n ->
      val cn = n.className?.toString().orEmpty()
      cn.contains("EditText", ignoreCase = true) && n.isEditable
    }?.let {
      logInputCandidate(it, "class_edittext")
      return it
    }
    NodeFinder.dfs(root) { n ->
      if (!n.isEditable) return@dfs false
      if (Build.VERSION.SDK_INT >= 26) {
        val h = n.hintText?.toString().orEmpty()
        if (h.contains("发消息", ignoreCase = true)) return@dfs true
      }
      val t = n.text?.toString().orEmpty()
      val cd = n.contentDescription?.toString().orEmpty()
      t.contains("发消息", ignoreCase = true) || cd.contains("发消息", ignoreCase = true)
    }?.let {
      logInputCandidate(it, "hint_or_desc_faxiaoxi")
      return it
    }
    return null
  }

  private fun logInputCandidate(n: AccessibilityNodeInfo, reason: String) {
    val cn = n.className?.toString().orEmpty()
    val id = n.viewIdResourceName ?: ""
    val r = Rect()
    n.getBoundsInScreen(r)
    Log.i(
      TAG,
      "input_candidate class=$cn viewId=$id bounds=[${r.left},${r.top},${r.right},${r.bottom}] reason=$reason"
    )
  }
}
