package com.wework.aiassistant.accessibility

import android.accessibilityservice.AccessibilityService
import android.graphics.Rect
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import kotlinx.coroutines.delay

/**
 * 企微：输入框输入 @ →「选择提醒的人」→ 搜索 → 点击成员。
 * 失败时由调用方降级为纯文本发送；任意一步超时会尝试 GLOBAL_ACTION_BACK。
 */
object AtMentionPicker {
  private const val TAG = "WeworkExecutor"

  suspend fun complete(
    service: AccessibilityService,
    inputBox: AccessibilityNodeInfo,
    mentionSearchQuery: String,
    mentionMatchLabel: String
  ): Boolean {
    val q = mentionSearchQuery.trim()
    val match = normalizeLabel(mentionMatchLabel)
    if (q.isEmpty() || match.isEmpty()) return false

    inputBox.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
    delay(120)
    if (!setNodeText(inputBox, "@")) {
      Log.e(TAG, "mention_at_set_failed")
      return false
    }
    delay(350)

    val pickerDeadline = SystemClock.uptimeMillis() + 4000L
    while (SystemClock.uptimeMillis() < pickerDeadline) {
      val root = service.rootInActiveWindow
      if (root == null) {
        delay(180)
        continue
      }
      try {
        if (subtreeContainsPickerTitle(root)) break
      } finally {
        root.recycle()
      }
      delay(180)
    }
    if (SystemClock.uptimeMillis() >= pickerDeadline) {
      Log.e(TAG, "mention_picker_timeout")
      service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
      delay(200)
      return false
    }

    delay(200)
    val root2 = service.rootInActiveWindow ?: return false
    try {
      val searchField = findPickerSearchEdit(root2)
      if (searchField == null) {
        Log.e(TAG, "mention_search_edit_not_found")
        service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
        delay(200)
        return false
      }
      try {
        searchField.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
        delay(80)
        if (!setNodeText(searchField, q)) {
          Log.e(TAG, "mention_search_set_failed")
          service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
          delay(200)
          return false
        }
      } finally {
        searchField.recycle()
      }
    } finally {
      root2.recycle()
    }

    delay(550)
    val root3 = service.rootInActiveWindow ?: return false
    try {
      if (!clickMemberRow(root3, match)) {
        Log.e(TAG, "mention_row_not_clicked")
        service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
        delay(200)
        return false
      }
    } finally {
      root3.recycle()
    }

    delay(350)
    Log.i(TAG, "mention_picker_success search=$q")
    return true
  }

  private fun normalizeLabel(s: String): String = s.replace('＠', '@').trim()

  private fun subtreeContainsPickerTitle(node: AccessibilityNodeInfo?): Boolean {
    if (node == null) return false
    val t = node.text?.toString().orEmpty()
    if (t.contains("选择提醒的人") || t.contains("提醒的人")) return true
    for (i in 0 until node.childCount) {
      val c = node.getChild(i) ?: continue
      try {
        if (subtreeContainsPickerTitle(c)) return true
      } finally {
        c.recycle()
      }
    }
    return false
  }

  /**
   * 弹窗出现后，聊天输入框通常在屏幕偏下；搜索框在弹层上半区。取「最靠上」的 EditText 作为搜索框。
   */
  private fun findPickerSearchEdit(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
    if (!subtreeContainsPickerTitle(root)) return null
    val rootRect = Rect()
    root.getBoundsInScreen(rootRect)
    if (rootRect.height() <= 0) return null
    val upperBound = rootRect.top + (rootRect.height() * 0.48f).toInt()
    var best: AccessibilityNodeInfo? = null
    var bestTop = Int.MAX_VALUE
    fun walk(n: AccessibilityNodeInfo, depth: Int) {
      if (depth > 48) return
      if (n.isEditable && n.className?.toString()?.contains("EditText", ignoreCase = true) == true) {
        val r = Rect()
        n.getBoundsInScreen(r)
        if (r.centerY() <= upperBound && r.top < bestTop) {
          best?.recycle()
          best = AccessibilityNodeInfo.obtain(n)
          bestTop = r.top
        }
      }
      for (i in 0 until n.childCount) {
        val c = n.getChild(i) ?: continue
        walk(c, depth + 1)
        c.recycle()
      }
    }
    walk(root, 0)
    return best
  }

  private fun clickMemberRow(root: AccessibilityNodeInfo, matchLabelNorm: String): Boolean {
    val needles =
      listOf(
        matchLabelNorm,
        matchLabelNorm.replace("@", ""),
        matchLabelNorm.substringBefore("@").trim()
      ).distinct().filter { it.isNotEmpty() }

    var clicked = false
    fun tryClick(target: AccessibilityNodeInfo): Boolean {
      var cur: AccessibilityNodeInfo? = AccessibilityNodeInfo.obtain(target)
      var depth = 0
      while (cur != null && depth < 8) {
        if (cur.isClickable && cur.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
          cur.recycle()
          return true
        }
        val p = cur.parent
        cur.recycle()
        cur = p
        depth++
      }
      return false
    }

    fun walk(n: AccessibilityNodeInfo, depth: Int) {
      if (depth > 45 || clicked) return
      val t = n.text?.toString()?.trim().orEmpty()
      if (t.isNotEmpty()) {
        val tn = normalizeLabel(t)
        if (needles.any { needle -> needle.length >= 2 && tn.contains(needle) }) {
          if (tryClick(n)) clicked = true
        }
      }
      for (i in 0 until n.childCount) {
        val c = n.getChild(i) ?: continue
        walk(c, depth + 1)
        c.recycle()
      }
    }
    walk(root, 0)
    return clicked
  }

  private fun setNodeText(node: AccessibilityNodeInfo, text: String): Boolean {
    val args = Bundle()
    args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
    return node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
  }
}
