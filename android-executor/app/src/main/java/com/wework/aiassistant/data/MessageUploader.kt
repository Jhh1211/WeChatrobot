package com.wework.aiassistant.data

import android.util.Log
import com.wework.aiassistant.network.ApiClient
import com.wework.aiassistant.network.InboundNormalized
import com.wework.aiassistant.storage.RuntimeStatsStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

object MessageUploader {
  private const val TAG = "WeworkExecutor"

  fun tryUploadDispatch(
    scope: CoroutineScope,
    cfg: ExecutorConfig,
    deviceId: String,
    chatTitle: String,
    text: String,
    senderName: String?,
    isFromSelf: Boolean,
    dedup: MessageDedup
  ) {
    scope.launch(Dispatchers.IO) {
      try {
        tryUploadBlocking(cfg, deviceId, chatTitle, text, senderName, isFromSelf, dedup)
      } catch (e: Exception) {
        Log.e(TAG, "inbound_upload fail message=${e.message}", e)
      }
    }
  }

  private fun tryUploadBlocking(
    cfg: ExecutorConfig,
    deviceId: String,
    chatTitle: String,
    text: String,
    senderName: String?,
    isFromSelf: Boolean,
    dedup: MessageDedup
  ) {
    Log.i(TAG, "inbound_upload start groupTitle=$chatTitle")

    val ts = MessageDedup.roundTo5sEpoch(System.currentTimeMillis())
    val h = MessageDedup.hash(chatTitle, senderName ?: "", text, ts)
    synchronized(dedup) {
      if (dedup.seenBefore(h)) {
        Log.i(TAG, "inbound_upload skipped_duplicate hash=$h")
        return
      }
    }
    val raw =
      buildJsonObject {
        put("messageHash", JsonPrimitive(h))
        put("chatTitle", JsonPrimitive(chatTitle))
      }
    val norm =
      InboundNormalized(
        chatTitle = chatTitle,
        senderName = senderName,
        text = text,
        timestamp = java.time.Instant.now().toString(),
        isFromSelf = isFromSelf,
        messageType = "text"
      )
    ApiClient.postInbound(cfg, deviceId, raw, norm)
    RuntimeStatsStore.recordUploadSummary("${chatTitle.take(12)}: ${text.take(40)}")
    Log.i(TAG, "inbound_upload success messageHash=$h")
  }
}
