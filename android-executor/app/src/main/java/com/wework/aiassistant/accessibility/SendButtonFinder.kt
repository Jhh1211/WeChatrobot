package com.wework.aiassistant.accessibility

import android.view.accessibility.AccessibilityNodeInfo

object SendButtonFinder {
  fun find(root: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
    val byLabel = NodeFinder.findClickableWithText(root, "发送")
    if (byLabel != null) return byLabel
    return NodeFinder.dfs(root) { n ->
      n.isClickable && (n.text?.toString() == "发送" || n.contentDescription?.toString()?.contains("发送") == true)
    }
  }
}
