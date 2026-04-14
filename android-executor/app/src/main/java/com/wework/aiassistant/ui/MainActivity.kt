package com.wework.aiassistant.ui



import android.content.Intent

import android.net.Uri

import android.app.Activity

import android.content.Context

import android.os.Build

import android.util.Log

import android.os.Bundle

import android.view.inputmethod.InputMethodManager

import android.provider.Settings

import androidx.activity.ComponentActivity

import androidx.activity.compose.setContent

import androidx.compose.foundation.layout.Column

import androidx.compose.foundation.layout.Spacer

import androidx.compose.foundation.layout.fillMaxSize

import androidx.compose.foundation.layout.height

import androidx.compose.foundation.layout.padding

import androidx.compose.foundation.rememberScrollState

import androidx.compose.foundation.verticalScroll

import androidx.compose.material3.Button

import androidx.compose.material3.HorizontalDivider

import androidx.compose.material3.MaterialTheme

import androidx.compose.material3.OutlinedTextField

import androidx.compose.material3.Surface

import androidx.compose.material3.Switch

import androidx.compose.material3.Text

import androidx.compose.runtime.Composable

import androidx.compose.runtime.LaunchedEffect

import androidx.compose.runtime.getValue

import androidx.compose.runtime.mutableStateOf

import androidx.compose.runtime.remember

import androidx.compose.runtime.rememberCoroutineScope

import androidx.compose.runtime.setValue

import androidx.compose.ui.Modifier

import androidx.compose.ui.platform.LocalContext

import androidx.compose.ui.platform.LocalFocusManager

import androidx.compose.ui.unit.dp

import com.wework.aiassistant.data.LocalStore

import com.wework.aiassistant.diagnostics.toConfigPreviewLine

import com.wework.aiassistant.diagnostics.toDiagSummary

import com.wework.aiassistant.executor.ExecutorRuntime

import com.wework.aiassistant.network.ApiClient

import com.wework.aiassistant.service.ExecutorForegroundService

import com.wework.aiassistant.storage.RuntimeStatsStore

import java.text.DateFormat

import java.util.Date

import kotlinx.coroutines.Dispatchers

import kotlinx.coroutines.flow.first

import kotlinx.coroutines.launch

import kotlinx.coroutines.withContext



private const val MAIN_DIAG_TAG = "WeworkExecutor"



class MainActivity : ComponentActivity() {

  override fun onCreate(savedInstanceState: Bundle?) {

    super.onCreate(savedInstanceState)

    setContent {

      MaterialTheme {

        Surface(modifier = Modifier.fillMaxSize()) {

          SettingsScreen()

        }

      }

    }

  }

}



private fun fmtTime(ms: Long): String =

  if (ms == 0L) "—" else DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.MEDIUM).format(Date(ms))



@Composable

fun SettingsScreen() {

  val ctx = LocalContext.current

  val focusManager = LocalFocusManager.current

  val scope = rememberCoroutineScope()

  var base by remember { mutableStateOf("http://10.0.2.2:3000") }

  var token by remember { mutableStateOf("change_me_executor_token") }

  var robot by remember { mutableStateOf("default_robot") }

  var name by remember { mutableStateOf("android-1") }

  var debugNodes by remember { mutableStateOf(false) }

  var messageListWatch by remember { mutableStateOf(true) }

  var status by remember { mutableStateOf("") }

  val stats = remember { mutableStateOf(RuntimeStatsStore.snapshot()) }

  val scroll = rememberScrollState()



  LaunchedEffect(Unit) {

    val cfg = LocalStore.configFlow(ctx).first()

    if (cfg != null) {

      base = cfg.baseUrl

      token = cfg.executorToken

      robot = cfg.robotId

      name = cfg.deviceName

      debugNodes = cfg.debugPrintNodes

      messageListWatch = cfg.messageListWatchEnabled

    } else {

      debugNodes = LocalStore.debugPrintNodesFlow(ctx).first()

      messageListWatch = LocalStore.messageListWatchEnabledFlow(ctx).first()

    }

  }



  Column(modifier = Modifier.padding(16.dp).verticalScroll(scroll)) {

    Text("自托管执行端（MVP）", style = MaterialTheme.typography.titleMedium)

    Spacer(Modifier.height(8.dp))

    OutlinedTextField(base, onValueChange = { base = it }, label = { Text("Backend Base URL") }, singleLine = true)

    Spacer(Modifier.height(6.dp))

    OutlinedTextField(token, onValueChange = { token = it }, label = { Text("Executor Token") }, singleLine = true)

    Spacer(Modifier.height(6.dp))

    OutlinedTextField(robot, onValueChange = { robot = it }, label = { Text("Robot ID") }, singleLine = true)

    Spacer(Modifier.height(6.dp))

    OutlinedTextField(name, onValueChange = { name = it }, label = { Text("Device Name") }, singleLine = true)

    Spacer(Modifier.height(8.dp))

    Button(

      onClick = {

        scope.launch {

          try {

            LocalStore.save(ctx, base, token, robot, name)

            val readBack = LocalStore.configFlow(ctx).first()

            if (readBack != null) {

              val line = "配置保存成功 ${readBack.toConfigPreviewLine()}"

              Log.i(MAIN_DIAG_TAG, line)

              RuntimeStatsStore.recordDiag(line)

              status = "配置已保存"

            } else {

              val line = "配置保存后读回仍为 null（请检查 baseUrl / token / robotId 是否为空）"

              Log.e(MAIN_DIAG_TAG, line)

              RuntimeStatsStore.recordDiag(line)

              status = "保存异常：读回配置为 null，详见 Logcat 与下方诊断日志"

            }

          } catch (e: Exception) {

            val d = e.toDiagSummary()

            Log.e(MAIN_DIAG_TAG, "保存配置失败", e)

            RuntimeStatsStore.recordDiag("保存配置失败 $d")

            status = "保存失败: $d"

          }

          stats.value = RuntimeStatsStore.snapshot()

          focusManager.clearFocus()

          (ctx as? Activity)?.let { act ->

            val imm = act.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager

            val token = act.window?.decorView?.windowToken

            if (token != null) {

              imm?.hideSoftInputFromWindow(token, InputMethodManager.HIDE_NOT_ALWAYS)

            }

          }

          Log.i(MAIN_DIAG_TAG, "save_clear_focus_done")

        }

      }

    ) {

      Text("保存配置")

    }

    Spacer(Modifier.height(6.dp))

    Button(

      onClick = {

        scope.launch {

          try {

            LocalStore.save(ctx, base, token, robot, name)

            val cfg = LocalStore.configFlow(ctx).first()

            if (cfg == null) {

              val line = "注册前读配置为 null（请填写 Backend URL、Executor Token、Robot ID 并保存）"

              Log.e(MAIN_DIAG_TAG, line)

              RuntimeStatsStore.recordDiag(line)

              status = line

              stats.value = RuntimeStatsStore.snapshot()

              return@launch

            }

            val preview = cfg.toConfigPreviewLine()

            Log.i(MAIN_DIAG_TAG, "注册前 $preview")

            RuntimeStatsStore.recordDiag("注册前 $preview")

            val deviceId =

              withContext(Dispatchers.IO) {

                val id = LocalStore.getAndroidDeviceId(ctx)

                ApiClient.registerDevice(

                  cfg,

                  id,

                  appVersion = "0.1.0",

                  model = Build.MODEL ?: "",

                  sdk = Build.VERSION.RELEASE ?: ""

                )

                id

              }

            ExecutorRuntime.update(cfg, deviceId)

            RuntimeStatsStore.markRegister()

            ExecutorForegroundService.start(ctx)

            Log.i(MAIN_DIAG_TAG, "注册成功 deviceId=$deviceId")

            RuntimeStatsStore.recordDiag("注册成功 deviceId=$deviceId")

            status = "已注册设备并启动前台服务"

          } catch (e: Exception) {

            val d = e.toDiagSummary()

            Log.e(MAIN_DIAG_TAG, "注册设备失败 $d", e)

            RuntimeStatsStore.recordDiag("注册失败 $d")

            status = "注册失败: $d"

          }

          stats.value = RuntimeStatsStore.snapshot()

        }

      }

    ) {

      Text("注册设备并启动服务")

    }

    Spacer(Modifier.height(12.dp))

    RowSwitch(

      title = "调试：打印无障碍节点树到 Logcat",

      checked = debugNodes,

      onChecked = { v ->

        debugNodes = v

        scope.launch {

          LocalStore.setDebugPrintNodes(ctx, v)

          status = if (v) "节点调试已开启（标签 WeworkExecutor）" else "节点调试已关闭"

        }

      }

    )

    Spacer(Modifier.height(8.dp))

    RowSwitch(

      title = "消息列表：未读群自动点入；发消息后回消息列表",

      checked = messageListWatch,

      onChecked = { v ->

        messageListWatch = v

        scope.launch {

          LocalStore.setMessageListWatchEnabled(ctx, v)

          status = if (v) "消息列表监听已开启" else "消息列表监听已关闭（仅手动进群发消息）"

        }

      }

    )

    Spacer(Modifier.height(12.dp))

    Text("心跳与统计", style = MaterialTheme.typography.titleSmall)

    Text("最近一次心跳(本地成功上报): ${fmtTime(stats.value.lastHeartbeatAt)}")

    Text("最近一次注册(本地): ${fmtTime(stats.value.lastRegisterAt)}")

    Text("最近消息上报数: ${stats.value.uploadCount}")

    Text("最近任务执行数: ${stats.value.taskCount}")

    Spacer(Modifier.height(8.dp))

    Button(

      onClick = {

        scope.launch {

          try {

            val cfg = LocalStore.configFlow(ctx).first()

            if (cfg == null) {

              val line = "心跳跳过：配置为 null，请先保存配置"

              Log.w(MAIN_DIAG_TAG, line)

              RuntimeStatsStore.recordDiag(line)

              status = line

              stats.value = RuntimeStatsStore.snapshot()

              return@launch

            }

            val preview = cfg.toConfigPreviewLine()

            Log.i(MAIN_DIAG_TAG, "心跳前 $preview")

            RuntimeStatsStore.recordDiag("心跳前 $preview")

            val deviceId =

              withContext(Dispatchers.IO) {

                val id = LocalStore.getAndroidDeviceId(ctx)

                ApiClient.heartbeat(cfg, id)

                id

              }

            RuntimeStatsStore.markHeartbeat()

            Log.i(MAIN_DIAG_TAG, "心跳接口调用成功 deviceId=$deviceId")

            RuntimeStatsStore.recordDiag("心跳成功 deviceId=$deviceId")

            status = "心跳接口调用成功"

          } catch (e: Exception) {

            val d = e.toDiagSummary()

            Log.e(MAIN_DIAG_TAG, "心跳失败 $d", e)

            RuntimeStatsStore.recordDiag("心跳失败 $d")

            status = "心跳失败: $d"

          }

          stats.value = RuntimeStatsStore.snapshot()

        }

      }

    ) {

      Text("立即测试心跳")

    }

    Spacer(Modifier.height(12.dp))

    Text("系统设置", style = MaterialTheme.typography.titleSmall)

    Button(

      onClick = {

        val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)

        ctx.startActivity(intent)

      }

    ) {

      Text("打开无障碍设置")

    }

    Spacer(Modifier.height(6.dp))

    Button(

      onClick = {

        val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)

        intent.data = Uri.parse("package:${ctx.packageName}")

        ctx.startActivity(intent)

      }

    ) {

      Text("请求忽略电池优化")

    }

    Spacer(Modifier.height(6.dp))

    Button(

      onClick = {

        try {

          val intent = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)

          ctx.startActivity(intent)

        } catch (_: Exception) {

          status = "无法打开电池优化列表"

        }

      }

    ) {

      Text("打开电池优化设置列表")

    }

    Spacer(Modifier.height(12.dp))

    Text("本地日志摘要（进程内，重启清空）", style = MaterialTheme.typography.titleSmall)

    Text("联调诊断（保存 / 注册 / 心跳，最近约 64 条）:", style = MaterialTheme.typography.labelMedium)

    stats.value.recentDiags.takeLast(25).forEach { line ->

      Text(line, style = MaterialTheme.typography.bodySmall)

    }

    HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))

    Text("最近消息(最多100条):", style = MaterialTheme.typography.labelMedium)

    stats.value.recentUploads.takeLast(20).forEach { line ->

      Text(line, style = MaterialTheme.typography.bodySmall)

    }

    HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))

    Text("最近任务(最多50条):", style = MaterialTheme.typography.labelMedium)

    stats.value.recentTasks.takeLast(20).forEach { line ->

      Text(line, style = MaterialTheme.typography.bodySmall)

    }

    Spacer(Modifier.height(8.dp))

    Text(status, style = MaterialTheme.typography.bodyMedium)

  }

}



@Composable

private fun RowSwitch(title: String, checked: Boolean, onChecked: (Boolean) -> Unit) {

  Column {

    Text(title, style = MaterialTheme.typography.bodyMedium)

    Switch(checked = checked, onCheckedChange = onChecked)

  }

}

