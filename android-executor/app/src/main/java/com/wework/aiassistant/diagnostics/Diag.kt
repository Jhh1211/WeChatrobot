package com.wework.aiassistant.diagnostics

import com.wework.aiassistant.data.ExecutorConfig

fun ExecutorConfig.toConfigPreviewLine(): String =
  "baseUrl=$baseUrl tokenEmpty=${executorToken.isBlank()} robotId=$robotId deviceName=$deviceName listWatch=$messageListWatchEnabled"

/** class + message（空则占位）+ 前几帧栈，便于 Logcat / 本地摘要。 */
fun Throwable.toDiagSummary(stackFrames: Int = 8): String {
  val msg = message?.trim()?.takeUnless { it.isEmpty() } ?: "<no message>"
  val frames =
    stackTrace.take(stackFrames).joinToString("; ") { el ->
      "${el.className}.${el.methodName}:${el.lineNumber}"
    }
  return "${javaClass.name}: $msg | at: $frames"
}
