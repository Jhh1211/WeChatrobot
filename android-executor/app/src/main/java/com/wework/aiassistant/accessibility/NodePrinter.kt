package com.wework.aiassistant.accessibility



import android.util.Log

import android.view.accessibility.AccessibilityNodeInfo



object NodePrinter {

  private const val TAG = "WeworkExecutor"

  private const val LOG_CHUNK = 3500



  fun printTree(root: AccessibilityNodeInfo?, maxDepth: Int = 8) {

    if (root == null) return

    val sb = StringBuilder()

    walk(root, sb, 0, maxDepth)

    val full = sb.toString()

    if (full.length <= LOG_CHUNK) {

      Log.d(TAG, "[node-tree]\n$full")

      return

    }

    var i = 0

    var part = 0

    while (i < full.length) {

      val end = minOf(i + LOG_CHUNK, full.length)

      Log.d(TAG, "[node-tree part=${part++}]\n${full.substring(i, end)}")

      i = end

    }

  }



  private fun walk(node: AccessibilityNodeInfo, sb: StringBuilder, depth: Int, maxDepth: Int) {

    if (depth > maxDepth) return

    val indent = "  ".repeat(depth)

    val txt = node.text?.toString()?.take(80) ?: ""

    val cls = node.className?.toString()?.substringAfterLast('.') ?: ""

    val cd = node.contentDescription?.toString()?.take(40) ?: ""

    val vid = node.viewIdResourceName?.toString()?.take(120).orEmpty()

    sb.append(indent)
      .append(cls)
      .append(" id=")
      .append(vid)
      .append(" text=")
      .append(txt)
      .append(" desc=")
      .append(cd)
      .append('\n')

    for (i in 0 until node.childCount) {

      val c = node.getChild(i) ?: continue

      walk(c, sb, depth + 1, maxDepth)

      c.recycle()

    }

  }

}

