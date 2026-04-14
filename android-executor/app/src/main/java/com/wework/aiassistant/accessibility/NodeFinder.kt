package com.wework.aiassistant.accessibility

import android.view.accessibility.AccessibilityNodeInfo
import java.util.ArrayDeque

object NodeFinder {
  fun dfs(root: AccessibilityNodeInfo?, predicate: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo? {
    if (root == null) return null
    if (predicate(root)) return root
    for (i in 0 until root.childCount) {
      val c = root.getChild(i) ?: continue
      val r = dfs(c, predicate)
      if (r != null) return r
      c.recycle()
    }
    return null
  }

  fun bfs(root: AccessibilityNodeInfo?, predicate: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo? {
    if (root == null) return null
    val q = ArrayDeque<AccessibilityNodeInfo>()
    q.add(root)
    while (q.isNotEmpty()) {
      val n = q.removeFirst()
      if (predicate(n)) return n
      for (i in 0 until n.childCount) {
        val c = n.getChild(i) ?: continue
        q.add(c)
      }
    }
    return null
  }

  fun findByText(root: AccessibilityNodeInfo?, text: String, ignoreCase: Boolean = true): AccessibilityNodeInfo? {
    return dfs(root) { n ->
      val t = n.text?.toString() ?: return@dfs false
      t.contains(text, ignoreCase)
    }
  }

  fun findEditable(root: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
    return dfs(root) { it.isEditable }
  }

  fun findClickableWithText(root: AccessibilityNodeInfo?, contains: String): AccessibilityNodeInfo? {
    return dfs(root) { n -> n.isClickable && (n.text?.toString()?.contains(contains, true) == true) }
  }
}
