package com.wework.aiassistant.data

import java.security.MessageDigest
import java.util.ArrayDeque

class MessageDedup(private val maxSize: Int = 500) {
  private val order = ArrayDeque<String>()
  private val seen = HashSet<String>()

  fun seenBefore(hash: String): Boolean {
    if (seen.contains(hash)) return true
    seen.add(hash)
    order.addLast(hash)
    while (order.size > maxSize) {
      val rm = order.removeFirst()
      seen.remove(rm)
    }
    return false
  }

  companion object {
    fun hash(chatTitle: String, sender: String, text: String, roundedTs: String): String {
      val raw = "$chatTitle|$sender|$text|$roundedTs"
      val md = MessageDigest.getInstance("SHA-256")
      val bytes = md.digest(raw.toByteArray(Charsets.UTF_8))
      return bytes.joinToString("") { b -> (b.toInt() and 0xff).toString(16).padStart(2, '0') }
    }

    fun roundTo5sEpoch(ms: Long): String {
      val bucket = (ms / 5000L) * 5000L
      return bucket.toString()
    }
  }
}
