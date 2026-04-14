package com.wework.aiassistant.receiver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.wework.aiassistant.service.ExecutorForegroundService

class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    if (intent?.action != Intent.ACTION_BOOT_COMPLETED) return
    ExecutorForegroundService.start(context.applicationContext)
  }
}
