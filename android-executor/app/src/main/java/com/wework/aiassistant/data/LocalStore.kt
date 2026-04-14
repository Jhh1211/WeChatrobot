package com.wework.aiassistant.data

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.dataStore by preferencesDataStore("executor_prefs")

/** 与 Service 等组件共用同一套 DataStore，避免 Activity / Service Context 不一致导致读不到刚写入的配置。 */
private fun Context.prefsContext(): Context = applicationContext

object LocalStore {
  private val KEY_BASE = stringPreferencesKey("base_url")
  private val KEY_TOKEN = stringPreferencesKey("executor_token")
  private val KEY_ROBOT = stringPreferencesKey("robot_id")
  private val KEY_NAME = stringPreferencesKey("device_name")
  private val KEY_ANDROID_DEVICE_ID = stringPreferencesKey("android_device_id")
  private val KEY_DEBUG_NODES = booleanPreferencesKey("debug_print_nodes")
  private val KEY_MESSAGE_LIST_WATCH = booleanPreferencesKey("message_list_watch")

  fun configFlow(context: Context): Flow<ExecutorConfig?> =
    context.prefsContext().dataStore.data.map { prefs ->
      val base = prefs[KEY_BASE] ?: return@map null
      val token = prefs[KEY_TOKEN] ?: return@map null
      val robot = prefs[KEY_ROBOT] ?: return@map null
      val name = prefs[KEY_NAME] ?: "device"
      val debugNodes = prefs[KEY_DEBUG_NODES] ?: false
      val messageListWatch = prefs[KEY_MESSAGE_LIST_WATCH] ?: true
      ExecutorConfig(
        baseUrl = base.trimEnd('/'),
        executorToken = token,
        robotId = robot,
        deviceName = name,
        debugPrintNodes = debugNodes,
        messageListWatchEnabled = messageListWatch
      )
    }

  suspend fun getAndroidDeviceId(context: Context): String {
    val snapshot = context.prefsContext().dataStore.data.first()
    val existing = snapshot[KEY_ANDROID_DEVICE_ID]
    if (!existing.isNullOrBlank()) return existing
    val id =
      android.provider.Settings.Secure.getString(context.contentResolver, android.provider.Settings.Secure.ANDROID_ID)
        ?: "unknown"
    context.prefsContext().dataStore.edit { it[KEY_ANDROID_DEVICE_ID] = id }
    return id
  }

  suspend fun save(
    context: Context,
    baseUrl: String,
    token: String,
    robotId: String,
    deviceName: String
  ) {
    context.prefsContext().dataStore.edit { prefs ->
      prefs[KEY_BASE] = baseUrl.trim().trimEnd('/')
      prefs[KEY_TOKEN] = token.trim()
      prefs[KEY_ROBOT] = robotId.trim()
      prefs[KEY_NAME] = deviceName.trim().ifEmpty { "device" }
    }
  }

  suspend fun setDebugPrintNodes(context: Context, enabled: Boolean) {
    context.prefsContext().dataStore.edit { it[KEY_DEBUG_NODES] = enabled }
  }

  suspend fun setMessageListWatchEnabled(context: Context, enabled: Boolean) {
    context.prefsContext().dataStore.edit { it[KEY_MESSAGE_LIST_WATCH] = enabled }
  }

  fun debugPrintNodesFlow(context: Context): Flow<Boolean> =
    context.prefsContext().dataStore.data.map { it[KEY_DEBUG_NODES] ?: false }

  fun messageListWatchEnabledFlow(context: Context): Flow<Boolean> =
    context.prefsContext().dataStore.data.map { it[KEY_MESSAGE_LIST_WATCH] ?: true }
}

data class ExecutorConfig(
  val baseUrl: String,
  val executorToken: String,
  val robotId: String,
  val deviceName: String,
  val debugPrintNodes: Boolean = false,
  /** 消息列表未读群自动点入；发消息后回退到消息 Tab */
  val messageListWatchEnabled: Boolean = true
)
