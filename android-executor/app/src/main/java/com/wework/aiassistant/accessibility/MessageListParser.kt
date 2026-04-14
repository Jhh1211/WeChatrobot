package com.wework.aiassistant.accessibility

import android.graphics.Rect
import android.view.accessibility.AccessibilityNodeInfo

data class ParsedBubble(
  val text: String,
  val senderHint: String?,
  val isFromSelf: Boolean
)

/**
 * 从企微聊天页取「最近消息」：必须优先从消息 [ListView] 解析。
 * 全局 DFS + takeLast 会把底部工具条 RecyclerView（商品图册/快捷回复等）误当成最后一条气泡。
 */
object MessageListParser {
  /** 底部快捷入口等，绝不是聊天正文 */
  private val TOOLBAR_LABELS =
    setOf(
      "发起收款",
      "快捷回复",
      "推荐客服",
      "商品图册",
      "直播",
      "客户朋友圈",
      "会议",
      "微文档",
      "收集表",
      "打卡",
      "审批",
      "汇报",
      "同事吧",
      "按住说话",
      "发消息",
      "发送",
      "语音",
      "相册",
      "拍摄",
      "文件",
      "位置",
      "名片",
      "更多"
    )

  /**
   * 优先从 [ListView] 每行提取「最长且像正文」的叶节点文本；若无 ListView 再回退并过滤工具条文案。
   */
  /**
   * 查找聊天消息区常见的 [ListView]（与 [parseRecentMessages] 同源）。
   * 调用方必须在用完或即将丢弃根树时对该节点 [AccessibilityNodeInfo.recycle]。
   */
  fun findMessageListView(root: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
    if (root == null) return null
    return findListView(root, depth = 0)
  }

  fun parseRecentMessages(root: AccessibilityNodeInfo?, maxItems: Int = 12): List<ParsedBubble> {
    if (root == null) return emptyList()
    val listView = findListView(root, depth = 0)
    if (listView != null) {
      val fromList = parseBubblesFromMessageListView(listView, maxItems)
      if (fromList.isNotEmpty()) return fromList
    }
    return parseRecentMessagesLegacyFiltered(root, maxItems)
  }

  private fun findListView(node: AccessibilityNodeInfo?, depth: Int): AccessibilityNodeInfo? {
    if (node == null || depth > 40) return null
    val cn = node.className?.toString().orEmpty()
    if (cn.contains("ListView", ignoreCase = true)) return node
    for (i in 0 until node.childCount) {
      val c = node.getChild(i) ?: continue
      val found = findListView(c, depth + 1)
      if (found != null) {
        // found 是 c 的子树，不能 recycle c
        return found
      }
      c.recycle()
    }
    return null
  }

  /**
   * 企微群聊里「星星人 @购房通」常在气泡**上方**单独占一行 ListView child，真正问句在下一行。
   * 若不合并，[takeLast] 后 [lastOrNull] 会把昵称行当最后一条用户消息。
   */
  private data class RowBubble(val text: String, val senderHint: String?, val isFromSelf: Boolean)

  /** 明显是独立短回复，勿与下一行合并成一条 */
  private val SHORT_PEER_ACK =
    setOf(
      "收到",
      "好的",
      "好",
      "嗯",
      "嗯嗯",
      "行",
      "OK",
      "ok",
      "谢谢",
      "多谢",
      "你好",
      "在吗",
      "在",
      "是的",
      "对的",
      "没错",
      "可以",
      "不行"
    )

  private fun parseBubblesFromMessageListView(listView: AccessibilityNodeInfo, maxItems: Int): List<ParsedBubble> {
    val rows = mutableListOf<RowBubble>()
    for (i in 0 until listView.childCount) {
      val row = listView.getChild(i) ?: continue
      try {
        val body = extractPrimaryMessageTextFromRow(row)?.trim().orEmpty()
        if (body.isBlank()) continue
        val sender = extractSenderHintFromRow(row, body)
        val self = isRowLikelySelfMessage(row, listView)
        rows.add(RowBubble(text = body, senderHint = sender, isFromSelf = self))
      } finally {
        row.recycle()
      }
    }
    val merged = mergeSplitPeerRows(rows)
    return merged.takeLast(maxItems)
  }

  private fun isLikelyPeerHeaderOnlyLine(s: String): Boolean {
    val t = s.trim()
    if (t.length > 24) return false
    if (t.any { ch -> ch in "？。！…，、" }) return false
    return t.contains('@') || t.contains('＠')
  }

  private fun shouldMergePeerHeaderRowWithNext(cur: RowBubble, next: RowBubble): Boolean {
    if (cur.isFromSelf || next.isFromSelf) return false
    if (next.text.length <= cur.text.length) return false
    if (cur.text in SHORT_PEER_ACK) return false
    val delta = next.text.length - cur.text.length
    if (delta < 4) return false
    // 「星星人 @购房通」一类抬头
    if (isLikelyPeerHeaderOnlyLine(cur.text)) return true
    // 纯昵称行常 ≤6 字且无句读；要求下一条足够长，避免两条真人短句误并
    if (cur.text.length <= 6 && next.text.length >= 8 && delta >= 5) return true
    return false
  }

  private fun mergeSplitPeerRows(rows: List<RowBubble>): List<ParsedBubble> {
    if (rows.isEmpty()) return emptyList()
    val out = mutableListOf<ParsedBubble>()
    var i = 0
    while (i < rows.size) {
      val cur = rows[i]
      val next = rows.getOrNull(i + 1)
      if (next != null && shouldMergePeerHeaderRowWithNext(cur, next)) {
        val sender = cur.senderHint ?: next.senderHint
        out.add(ParsedBubble(text = next.text, senderHint = sender, isFromSelf = false))
        i += 2
      } else {
        out.add(ParsedBubble(text = cur.text, senderHint = cur.senderHint, isFromSelf = cur.isFromSelf))
        i += 1
      }
    }
    return out
  }

  /**
   * 企微群聊：己方气泡通常在列表区域中线以右；启发式，外部群/主题模式可能需再调。
   */
  private fun isRowLikelySelfMessage(row: AccessibilityNodeInfo, listView: AccessibilityNodeInfo): Boolean {
    val rr = Rect()
    val lr = Rect()
    row.getBoundsInScreen(rr)
    listView.getBoundsInScreen(lr)
    if (lr.width() <= 0) return false
    val mid = lr.left + lr.width() / 2
    return rr.centerX() > mid + 24
  }

  /**
   * 企微群聊常见：先昵称「星星人」再企业后缀「购房通」（无 @ 的短 TextView）。按 DFS 顺序取**第一个**
   * 像人名的短标签，避免把企业后缀当地发送者（否则 trace 里发言人错、@ 人也错）。
   * 若无命中再回退「最长候选」（保留「购房通-鱼丸」优于「购房通」一类差异）。
   */
  private fun extractSenderHintFromRow(row: AccessibilityNodeInfo, body: String): String? {
    val fragments = mutableListOf<String>()
    collectAllVisibleTexts(row, fragments, depth = 0)
    val seen = LinkedHashSet<String>()
    for (raw in fragments) {
      val s = raw.trim()
      if (s.length < 2 || s.length > 120) continue
      if (isLikelyTimestampOrMeta(s)) continue
      if (TOOLBAR_LABELS.contains(s)) continue
      if (s == body) continue
      if (!seen.add(s)) continue
      if (s.length <= 20 && !s.startsWith("@") && !s.startsWith("＠") && senderShortLabelLikely(s)) {
        return s
      }
    }
    val candidates = seen.toList()
    if (candidates.isEmpty()) return null
    return candidates.maxByOrNull { it.length }
  }

  /** 排除纯 @ 后缀等；短串即可（昵称区很少超过十几字） */
  private fun senderShortLabelLikely(s: String): Boolean {
    if (s in setOf("微信", "企业微信", "外部群")) return false
    return true
  }

  /**
   * 单行会话气泡：取「最长且非时间/非工具条」的文案作为正文。
   * 必须用 [collectAllVisibleTexts]：仅叶节点会漏掉企微里带子节点的 TextView 气泡正文，导致最长叶文本退化成发送者昵称（如「星星人」）。
   */
  private fun extractPrimaryMessageTextFromRow(row: AccessibilityNodeInfo): String? {
    val fragments = mutableListOf<String>()
    collectAllVisibleTexts(row, fragments, depth = 0)
    val candidates =
      fragments
        .map { it.trim() }
        .filter { it.length >= 2 && it.length < 2000 }
        .filter { !isLikelyTimestampOrMeta(it) }
        .filter { !TOOLBAR_LABELS.contains(it) }
    if (candidates.isEmpty()) return null
    return candidates.maxByOrNull { it.length }
  }

  /**
   * 收集行子树内所有带 [AccessibilityNodeInfo.getText] 的节点（含非叶 TextView），避免正文只在父节点上而子节点为装饰/图标时选错。
   */
  private fun collectAllVisibleTexts(node: AccessibilityNodeInfo, out: MutableList<String>, depth: Int) {
    if (depth > 28) return
    val t = node.text?.toString()?.trim().orEmpty()
    val cd = node.contentDescription?.toString()?.trim().orEmpty()
    if (t.isNotEmpty()) {
      out.add(t)
    } else if (cd.isNotEmpty()) {
      out.add(cd)
    }
    for (i in 0 until node.childCount) {
      val c = node.getChild(i) ?: continue
      collectAllVisibleTexts(c, out, depth + 1)
      c.recycle()
    }
  }

  private fun isLikelyTimestampOrMeta(line: String): Boolean {
    val t = line.trim()
    if (t in setOf("＠微信", "@微信", "@所有人")) return true
    // 以下为「纯时间/日期条」，勿用「今天/下午 + 任意 20 字」——会误伤「今天是几号啊？清明节放几天假么」等整句正文
    if (t.matches(Regex("""^(上午|下午|中午)\s*\d{1,2}:\d{2}$"""))) return true
    if (t.matches(Regex("""^\d{1,2}:\d{2}$"""))) return true
    if (t in setOf("刚刚", "今天", "昨天")) return true
    if (t in setOf("上午", "下午", "中午", "早上", "昨晚", "今早", "今晚")) return true
    if (t.matches(Regex("""^星期[一二三四五六日天]$"""))) return true
    if (t.matches(Regex("""^\d{1,2}分钟前$"""))) return true
    if (t.matches(Regex("""^\d{1,2}小时前$"""))) return true
    return false
  }

  private fun collectLeafLines(node: AccessibilityNodeInfo, out: MutableList<String>, depth: Int) {
    if (depth > 28) return
    val t = node.text?.toString()?.trim().orEmpty()
    val cd = node.contentDescription?.toString()?.trim().orEmpty()
    val line =
      when {
        t.isNotEmpty() -> t
        cd.isNotEmpty() -> cd
        else -> ""
      }
    if (line.isNotEmpty() && node.childCount == 0) {
      out.add(line)
    }
    for (i in 0 until node.childCount) {
      val c = node.getChild(i) ?: continue
      collectLeafLines(c, out, depth + 1)
      c.recycle()
    }
  }

  /** 无 ListView 时的兜底：全树收集后去掉工具条文案再 takeLast */
  private fun parseRecentMessagesLegacyFiltered(root: AccessibilityNodeInfo, maxItems: Int): List<ParsedBubble> {
    val lines = mutableListOf<String>()
    collectLeafLines(root, lines, depth = 0)
    val meaningful =
      lines
        .map { it.trim() }
        .filter { it.length >= 2 && it.length < 800 }
        .filter { !TOOLBAR_LABELS.contains(it) }
        .filter { !isLikelyTimestampOrMeta(it) }
    return meaningful.takeLast(maxItems).map { ParsedBubble(text = it, senderHint = null, isFromSelf = false) }
  }
}
