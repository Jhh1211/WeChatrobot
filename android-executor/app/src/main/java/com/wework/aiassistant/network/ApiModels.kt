package com.wework.aiassistant.network

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

@Serializable
data class ApiEnvelope(
  val success: Boolean,
  val data: JsonElement? = null,
  val error: ApiErr? = null
)

@Serializable
data class ApiErr(val code: String? = null, val message: String? = null)

@Serializable
data class PullTaskData(val task: ExecutorTaskDto? = null)

@Serializable
data class ExecutorTaskDto(
  val id: String,
  val taskUid: String,
  val type: String,
  val targetChatTitle: String,
  val payload: JsonElement? = null
)

@Serializable
data class InboundNormalized(
  val chatTitle: String,
  val senderName: String? = null,
  val text: String,
  val timestamp: String? = null,
  @SerialName("isFromSelf") val isFromSelf: Boolean,
  val messageType: String
)
