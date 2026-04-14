package com.wework.aiassistant.network

import com.wework.aiassistant.data.ExecutorConfig
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

object ApiClient {
  private val json =
    Json {
      ignoreUnknownKeys = true
      encodeDefaults = true
    }

  private val client =
    OkHttpClient.Builder()
      .connectTimeout(20, TimeUnit.SECONDS)
      .readTimeout(30, TimeUnit.SECONDS)
      .writeTimeout(30, TimeUnit.SECONDS)
      .build()

  private val jsonMedia = "application/json; charset=utf-8".toMediaType()

  private fun authHeader(cfg: ExecutorConfig): String = "Bearer ${cfg.executorToken}"

  private fun jsonBody(obj: JsonObject): String = obj.toString()

  private fun post(cfg: ExecutorConfig, path: String, body: JsonObject): String {
    val url = "${cfg.baseUrl}$path"
    val req =
      Request.Builder()
        .url(url)
        .addHeader("Authorization", authHeader(cfg))
        .post(jsonBody(body).toRequestBody(jsonMedia))
        .build()
    client.newCall(req).execute().use { resp ->
      val text = resp.body?.string() ?: ""
      if (!resp.isSuccessful) error("HTTP ${resp.code}: $text")
      return text
    }
  }

  fun registerDevice(cfg: ExecutorConfig, deviceId: String, appVersion: String, model: String, sdk: String) {
    val cap = JsonArray(listOf(JsonPrimitive("send_text")))
    val body =
      buildJsonObject {
        put("deviceId", deviceId)
        put("robotId", cfg.robotId)
        put("name", cfg.deviceName)
        put("appVersion", appVersion)
        put("deviceModel", model)
        put("androidVersion", sdk)
        put("capability", cap)
      }
    val raw = post(cfg, "/api/executor/device/register", body)
    val env = json.decodeFromString<ApiEnvelope>(raw)
    if (!env.success) apiError("register", env)
  }

  fun heartbeat(cfg: ExecutorConfig, deviceId: String, detail: JsonObject? = null) {
    val body =
      buildJsonObject {
        put("deviceId", deviceId)
        put("robotId", cfg.robotId)
        put("status", JsonPrimitive("online"))
        if (detail != null) put("detail", detail)
      }
    val raw = post(cfg, "/api/executor/device/heartbeat", body)
    val env = json.decodeFromString<ApiEnvelope>(raw)
    if (!env.success) apiError("heartbeat", env)
  }

  private fun apiError(op: String, env: ApiEnvelope): Nothing {
    val parts = listOfNotNull(env.error?.code?.trim()?.takeIf { it.isNotEmpty() }, env.error?.message?.trim()?.takeIf { it.isNotEmpty() })
    error(if (parts.isEmpty()) "$op failed (success=false, no error detail)" else "$op failed: ${parts.joinToString(" | ")}")
  }

  fun postInbound(
    cfg: ExecutorConfig,
    deviceId: String,
    rawPayload: JsonObject,
    normalized: InboundNormalized
  ) {
    val normEl = json.encodeToJsonElement(InboundNormalized.serializer(), normalized)
    val body =
      buildJsonObject {
        put("deviceId", deviceId)
        put("robotId", cfg.robotId)
        put("source", JsonPrimitive("android_accessibility"))
        put("rawPayload", rawPayload)
        put("normalizedMessage", normEl)
      }
    val raw = post(cfg, "/api/executor/inbound-events", body)
    val env = json.decodeFromString<ApiEnvelope>(raw)
    if (!env.success) error(env.error?.message ?: "inbound failed")
  }

  fun pullTask(cfg: ExecutorConfig, deviceId: String): ExecutorTaskDto? {
    val body =
      buildJsonObject {
        put("deviceId", deviceId)
        put("robotId", cfg.robotId)
        put("capability", JsonArray(listOf(JsonPrimitive("send_text"))))
      }
    val raw = post(cfg, "/api/executor/tasks/pull", body)
    val env = json.decodeFromString<ApiEnvelope>(raw)
    if (!env.success) return null
    val data = env.data ?: return null
    val pull = json.decodeFromJsonElement(PullTaskData.serializer(), data)
    return pull.task
  }

  fun ackTask(cfg: ExecutorConfig, taskId: String, deviceId: String) {
    val body = buildJsonObject { put("deviceId", deviceId) }
    val raw = post(cfg, "/api/executor/tasks/$taskId/ack", body)
    val env = json.decodeFromString<ApiEnvelope>(raw)
    if (!env.success) error(env.error?.message ?: "ack failed")
  }

  fun resultTask(
    cfg: ExecutorConfig,
    taskId: String,
    deviceId: String,
    ok: Boolean,
    detail: JsonObject,
    errorMessage: String?
  ) {
    val body =
      buildJsonObject {
        put("deviceId", deviceId)
        put("status", JsonPrimitive(if (ok) "success" else "failed"))
        put("detail", detail)
        put("executedAt", JsonPrimitive(java.time.Instant.now().toString()))
        if (errorMessage != null) put("errorMessage", errorMessage)
      }
    post(cfg, "/api/executor/tasks/$taskId/result", body)
  }
}
