package com.wework.aiassistant.accessibility

import android.graphics.Rect
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo

enum class WeworkPage {
  HOME,
  SESSION_LIST,
  CHAT,
  /** 顶栏标题已匹配目标会话，输入区/页面结构尚未完全就绪 */
  CHAT_PENDING,
  SEARCH,
  /** 企业资料 / 认证 / 错误结果页，勿当会话列表或聊天页 */
  PROFILE_PAGE,
  UNKNOWN
}

/**
 * 不依赖固定 resource-id，按常见文案/类名粗判页面（不同版本企业微信可能需微调）。
 * SEARCH 需在 HOME 之前识别（搜索浮层叠在消息页上时优先判为搜索态）。
 */
object ChatPageDetector {
  private const val TAG = "WeworkExecutor"

  private val BAD_PAGE_SNIPPETS =
    listOf(
      "企业信息",
      "企业简称",
      "企业名片",
      "企业未认证信息真实性",
      "前往认证",
      "@机器人测试"
    )

  /**
   * 是否为企业资料 / 坏页（用于熔断与候选过滤文案特征）。
   */
  fun isEnterpriseProfileOrBadPage(root: AccessibilityNodeInfo?): Boolean {
    if (root == null) return false
    val d = dumpText(root)
    if (d.contains("企业未认证信息真实性", ignoreCase = true)) return true
    if (d.contains("@机器人测试", ignoreCase = true) &&
      (
        d.contains("企业信息", ignoreCase = true) ||
          d.contains("企业简称", ignoreCase = true) ||
          d.contains("企业名片", ignoreCase = true)
      )
    ) {
      return true
    }
    if (d.contains("企业信息", ignoreCase = true) && d.contains("企业简称", ignoreCase = true)) return true
    val corpHits =
      listOf("企业信息", "企业简称", "企业名片", "前往认证").count { d.contains(it, ignoreCase = true) }
    if (corpHits >= 2) return true
    if (d.contains("前往认证", ignoreCase = true) &&
      (
        d.contains("企业信息", ignoreCase = true) ||
          d.contains("企业简称", ignoreCase = true) ||
          d.contains("企业名片", ignoreCase = true)
      )
    ) {
      return true
    }
    return false
  }

  private val CHAT_TITLE_EXCLUDE =
    setOf(
      "消息",
      "搜索",
      "返回",
      "按住说话",
      "发消息",
      "发送",
      "语音",
      "表情",
      "更多",
      "未知"
    )

  /**
   * 从聊天页顶栏区域粗取当前会话标题（用于与 targetChatTitle 严格比对）。
   */
  fun guessChatBarTitle(root: AccessibilityNodeInfo?): String {
    if (root == null) return ""
    data class Cand(val text: String, val top: Int, val left: Int)

    val cands = mutableListOf<Cand>()
    fun walk(n: AccessibilityNodeInfo, d: Int) {
      if (d > 10) return
      val t = n.text?.toString()?.trim().orEmpty()
      if (t.length in 2..56 &&
        CHAT_TITLE_EXCLUDE.none { ex -> t.equals(ex, ignoreCase = true) } &&
        !t.contains("按住", ignoreCase = true)
      ) {
        val r = Rect()
        n.getBoundsInScreen(r)
        cands.add(Cand(t, r.top, r.left))
      }
      for (i in 0 until n.childCount) {
        val c = n.getChild(i) ?: continue
        walk(c, d + 1)
        c.recycle()
      }
    }
    walk(root, 0)
    if (cands.isEmpty()) return ""
    return cands.minWith(compareBy<Cand> { it.top }.thenBy { it.left }).text
  }

  /**
   * 会话标题比对用规范化：空白/全角空格、末尾成员数括号 (3)（3）、群后缀等。
   */
  /**
   * 上报给服务端的群名：去掉末尾成员数「测试群(3)」→「测试群」，与 DB 中 `title:测试群` 策略对齐。
   * 不做小写（与入库 `group_name` 保持一致）。
   */
  fun normalizeGroupTitleForServer(barTitle: String): String {
    var t = barTitle.trim().replace('\u3000', ' ').trim()
    var changed = true
    while (changed) {
      changed = false
      val n = t.replace(Regex("""\s*[（(［\[]\s*[0-9０-９]+\s*[）)］\]]\s*$"""), "").trim()
      if (n != t) {
        t = n
        changed = true
      }
    }
    return t.trim()
  }

  /** 列表/顶栏截断：去掉省略号、末尾人数括号、尾部分隔符，不做群后缀剥离。 */
  fun stripUiNoiseForTitle(s: String): String {
    var t = s.trim().replace('\u3000', ' ').trim()
    var changed = true
    while (changed) {
      changed = false
      val n =
        t.removeSuffix("…")
          .removeSuffix("...")
          .removeSuffix("⋯")
          .removeSuffix("．．．")
          .trim()
      if (n != t) {
        t = n
        changed = true
      }
    }
    changed = true
    while (changed) {
      changed = false
      val n1 = t.replace(Regex("""\s*[（(［\[]\s*[0-9０-９]+\s*[）)］\]]\s*$"""), "").trim()
      if (n1 != t) {
        t = n1
        changed = true
      }
    }
    return t.trimEnd('-', '－', ' ', '　').trim()
  }

  /**
   * 会话名在截断、省略号、列表/顶栏文案不一致时是否仍应视为同一会话（外发/校验用）。
   */
  fun titlesLikelySameConversation(a: String, b: String): Boolean {
    val x = stripUiNoiseForTitle(a).lowercase()
    val y = stripUiNoiseForTitle(b).lowercase()
    if (x.isEmpty() || y.isEmpty()) return false
    if (x == y) return true
    val short = if (x.length <= y.length) x else y
    val long = if (x.length <= y.length) y else x
    if (short.length < 6) return false
    if (long.startsWith(short)) return true
    if (short.length >= 8 && long.contains(short)) return true
    var lcp = 0
    val lim = minOf(short.length, long.length)
    while (lcp < lim && short[lcp] == long[lcp]) lcp++
    return lcp >= 8 && lcp * 100 >= short.length * 60
  }

  fun normalizeChatTitleForMatch(s: String): String {
    var t = stripUiNoiseForTitle(s).trim()
    var changed = true
    while (changed) {
      changed = false
      val n1 = t.replace(Regex("""\s*[（(［\[]\s*[0-9０-９]+\s*[）)］\]]\s*$"""), "").trim()
      if (n1 != t) {
        t = n1
        changed = true
      }
    }
    val suffixes = listOf("群", "讨论组", "聊天", "（群）", "(群)")
    changed = true
    while (changed) {
      changed = false
      for (suf in suffixes) {
        if (t.endsWith(suf, ignoreCase = true)) {
          t = t.dropLast(suf.length).trim()
          changed = true
        }
      }
    }
    return t.lowercase()
  }

  /** 顶栏标题与期望会话名是否一致（精确、规范化相等，或截断/省略号下同一会话）。 */
  fun chatTitleMatchesExpected(barTitle: String, expectedChatTitle: String): Boolean {
    val a = barTitle.trim()
    val e = expectedChatTitle.trim()
    if (a.isEmpty() || e.isEmpty()) return false
    if (a.equals(e, ignoreCase = true)) return true
    if (normalizeChatTitleForMatch(a) == normalizeChatTitleForMatch(e)) return true
    return titlesLikelySameConversation(a, e)
  }

  /** 顶栏已匹配目标时，是否应禁止再按消息列表去点 row（非 HOME/SESSION 会话列表）。 */
  fun shouldSuppressHomeConversationPick(root: AccessibilityNodeInfo?, targetChatTitle: String): Boolean {
    if (root == null || targetChatTitle.isBlank()) return false
    val base = detect(root)
    if (base == WeworkPage.HOME || base == WeworkPage.SESSION_LIST) return false
    if (base == WeworkPage.SEARCH || base == WeworkPage.PROFILE_PAGE) return false
    val bar = guessChatBarTitle(root)
    if (!chatTitleMatchesExpected(bar, targetChatTitle)) return false
    Log.w(TAG, "ignore_row_model_inside_chat_page barTitle=\"$bar\" basePage=$base")
    return true
  }

  private fun detectChatToolbarInDump(d: String): Boolean {
    val hasBack = d.contains("返回", ignoreCase = true)
    val hasMenu = d.contains("更多", ignoreCase = true)
    return hasBack && hasMenu
  }

  private fun detectChatMessageListInDump(d: String): Boolean {
    val timeHits = Regex("""\d{1,2}:\d{2}""").findAll(d).count()
    if (timeHits >= 2) return true
    if (d.contains("分钟前", ignoreCase = true) || d.contains("小时前", ignoreCase = true)) return true
    if (d.contains("昨天", ignoreCase = true) && d.length > 200) return true
    if (d.contains("上午", ignoreCase = true) && d.contains("下午", ignoreCase = true)) return true
    return false
  }

  private fun detectBottomInputAreaInDump(d: String): Boolean {
    return listOf("发消息", "按住说话", "按住 说话", "语音", "表情", "相册", "拍摄", "发送", "按住 发送")
      .any { d.contains(it, ignoreCase = true) }
  }

  /**
   * 在已排除 HOME/SESSION/SEARCH/PROFILE 后，结合顶栏标题判断是否为聊天页或待就绪聊天页。
   */
  fun detectForOpenNavigation(root: AccessibilityNodeInfo?, targetChatTitle: String): WeworkPage {
    if (root == null) return WeworkPage.UNKNOWN
    val base = detect(root)
    if (targetChatTitle.isBlank()) return base

    // [detect] 常把会话页误判为 SEARCH；若顶栏已是目标群且具备聊天壳，应走 CHAT 而非搜索流水线（否则 findSearchEditable 找不到「非输入框」的可编辑）
    if (base == WeworkPage.SEARCH) {
      val barEarly = guessChatBarTitle(root)
      if (chatTitleMatchesExpected(barEarly, targetChatTitle)) {
        if (hasChatPageStructure(root)) {
          Log.i(TAG, "openNav promote SEARCH->CHAT barTitle=\"$barEarly\"")
          return WeworkPage.CHAT
        }
        val dumpEarly = dumpText(root, maxDepth = 14)
        val chatLikeEarly =
          detectChatToolbarInDump(dumpEarly) ||
            detectChatMessageListInDump(dumpEarly) ||
            detectBottomInputAreaInDump(dumpEarly)
        if (chatLikeEarly) {
          Log.i(TAG, "openNav promote SEARCH->CHAT_PENDING barTitle=\"$barEarly\"")
          return WeworkPage.CHAT_PENDING
        }
      }
      return WeworkPage.SEARCH
    }

    if (base == WeworkPage.HOME ||
      base == WeworkPage.SESSION_LIST ||
      base == WeworkPage.PROFILE_PAGE
    ) {
      return base
    }
    val bar = guessChatBarTitle(root)
    if (!chatTitleMatchesExpected(bar, targetChatTitle)) {
      return base
    }
    if (hasChatPageStructure(root)) {
      Log.i(TAG, "detect_chat_structure=true barTitle=\"$bar\" promote=direct_chat baseWas=$base")
      return WeworkPage.CHAT
    }
    val dump = dumpText(root, maxDepth = 14)
    val toolbar = detectChatToolbarInDump(dump)
    val messageList = detectChatMessageListInDump(dump)
    val bottom = detectBottomInputAreaInDump(dump)
    Log.i(
      TAG,
      "detect_chat_pending barTitle=\"$bar\" detect_chat_toolbar=$toolbar detect_chat_message_list=$messageList detect_chat_structure=false bottom_input_hints=$bottom baseWas=$base"
    )
    // 顶栏已匹配：任一聊天壳特征即可待就绪（不强制依赖 composer / 返回 同时出现）
    val chatLike = toolbar || messageList || bottom
    if (chatLike || base == WeworkPage.UNKNOWN) {
      Log.i(TAG, "openChat promote_to_chat_pending barTitle=\"$bar\" baseWas=$base")
      return WeworkPage.CHAT_PENDING
    }
    return base
  }

  /**
   * 列表点击后校验：UNKNOWN 但顶栏已匹配目标且具备聊天壳（返回/底部栏/编辑区），视为 CHAT。
   */
  fun effectiveChatPageForOpenVerify(
    root: AccessibilityNodeInfo?,
    basePage: WeworkPage,
    expectedChatTitle: String
  ): WeworkPage {
    if (root == null) return basePage
    if (basePage == WeworkPage.CHAT_PENDING) return WeworkPage.CHAT
    if (basePage == WeworkPage.HOME ||
      basePage == WeworkPage.SESSION_LIST ||
      basePage == WeworkPage.SEARCH ||
      basePage == WeworkPage.PROFILE_PAGE
    ) {
      return basePage
    }
    if (basePage == WeworkPage.CHAT) return WeworkPage.CHAT
    val bar = guessChatBarTitle(root)
    if (!chatTitleMatchesExpected(bar, expectedChatTitle)) return basePage
    if (hasChatPageStructure(root)) return WeworkPage.CHAT
    val dump = dumpText(root, maxDepth = 14)
    val hasBack = dump.contains("返回", ignoreCase = true)
    val hasMoreOrVoice =
      dump.contains("更多", ignoreCase = true) ||
        dump.contains("语音", ignoreCase = true) ||
        dump.contains("表情", ignoreCase = true)
    val bottomHint =
      listOf("按住说话", "按住 说话", "发消息", "发送", "相册", "拍摄", "文件").any { dump.contains(it, ignoreCase = true) }
    if (hasBack && (hasMoreOrVoice || bottomHint)) {
      return WeworkPage.CHAT
    }
    return basePage
  }

  /** 日志用：当前树里命中的坏页特征片段（截断）。 */
  fun badPageReason(root: AccessibilityNodeInfo?): String {
    if (root == null) return "no_root"
    val d = dumpText(root)
    val hits = BAD_PAGE_SNIPPETS.filter { d.contains(it, ignoreCase = true) }
    return if (hits.isEmpty()) "matched_heuristic_no_snippet" else hits.joinToString("|")
  }

  /** 典型全局搜索壳层：有 ListView+输入框时也不能当成会话页 */
  private fun isStrongGlobalSearchShellDump(dump: String): Boolean {
    if (dump.contains("网络查找", ignoreCase = true)) return true
    if (dump.contains("无结果", ignoreCase = true) || dump.contains("没有找到", ignoreCase = true)) return true
    if (dump.contains("搜索", ignoreCase = true) &&
      dump.contains("清空", ignoreCase = true) &&
      dump.contains("取消", ignoreCase = true)
    ) {
      return true
    }
    return false
  }

  fun hasChatPageStructure(root: AccessibilityNodeInfo?): Boolean {
    if (root == null) return false
    val dump = dumpText(root, maxDepth = 14)
    val composerHints =
      listOf(
        "按住说话",
        "按住 说话",
        "发消息",
        "松开 发送",
        "按住 发送",
        "语音输入",
        "相册",
        "拍摄",
        "文件"
      )
    if (composerHints.any { dump.contains(it, ignoreCase = true) }) return true
    if (dump.contains("发送", ignoreCase = true) &&
      (
        dump.contains("返回", ignoreCase = true) ||
          dump.contains("语音", ignoreCase = true) ||
          dump.contains("表情", ignoreCase = true)
      )
    ) {
      return true
    }
    val edit = NodeFinder.findEditable(root) ?: return false

    // 企微常不把「发送」暴露为可点节点，且无「发消息」等可读文案；但有消息 ListView + 输入框即为会话壳。
    if (!isStrongGlobalSearchShellDump(dump)) {
      val listView = MessageListParser.findMessageListView(root)
      if (listView != null) {
        val hasRows = listView.childCount >= 1
        listView.recycle()
        if (hasRows) {
          val send = SendButtonFinder.find(root)
          if (send != null) send.recycle()
          edit.recycle()
          return true
        }
      }
    }

    val send = SendButtonFinder.find(root)
    if (send != null) {
      send.recycle()
      edit.recycle()
      return true
    }
    edit.recycle()
    return false
  }

  /**
   * 是否处于全局搜索/搜索输入/搜索结果页（含顶部可编辑且带搜索相关文案或焦点在搜索框）。
   */
  fun isSearchUi(root: AccessibilityNodeInfo?): Boolean {
    if (root == null) return false
    val dump = dumpText(root, maxDepth = 14)
    val hasEditable = NodeFinder.findEditable(root) != null
    if (!hasEditable) return false

    if (dump.contains("网络查找", ignoreCase = true) || dump.contains("网络查找同事", ignoreCase = true)) {
      return true
    }
    if (dump.contains("搜索", ignoreCase = true) &&
      (
        dump.contains("取消", ignoreCase = true) ||
          dump.contains("清空", ignoreCase = true) ||
          dump.contains("联系人", ignoreCase = true) ||
          dump.contains("群聊", ignoreCase = true) ||
          dump.contains("包含", ignoreCase = true) ||
          dump.contains("聊天记录", ignoreCase = true)
      )
    ) {
      return true
    }
    if (dump.contains("联系人", ignoreCase = true) &&
      (dump.contains("群聊", ignoreCase = true) || dump.contains("聊天记录", ignoreCase = true))
    ) {
      return true
    }
    // 聊天页键盘唤起时会话输入框带焦点；若仅凭「有焦点可编辑」判为搜索页，
    // openChat 搜索管会把群名写入会话输入框（用户见输入框里只有「测试群」且未发送）。
    if (hasFocusedEditable(root) && !hasChatPageStructure(root)) return true
    if (dump.contains("无结果", ignoreCase = true) || dump.contains("没有找到", ignoreCase = true)) {
      return true
    }
    return false
  }

  fun detect(root: AccessibilityNodeInfo?): WeworkPage {
    if (root == null) return WeworkPage.UNKNOWN
    val dump = dumpText(root)
    val hasEditable = NodeFinder.findEditable(root) != null

    if (isSearchUi(root)) {
      return WeworkPage.SEARCH
    }

    if (isEnterpriseProfileOrBadPage(root)) {
      return WeworkPage.PROFILE_PAGE
    }

    if (dump.contains("消息", ignoreCase = true) &&
      (
        dump.contains("邮件", ignoreCase = true) ||
          dump.contains("文档", ignoreCase = true) ||
          dump.contains("日历", ignoreCase = true) ||
          dump.contains("工作台", ignoreCase = true) ||
          dump.contains("通讯录", ignoreCase = true) ||
          dump.contains("会议", ignoreCase = true) ||
          dump.contains("更多", ignoreCase = true)
      )
    ) {
      return WeworkPage.HOME
    }

    if (hasChatPageStructure(root)) {
      return WeworkPage.CHAT
    }

    if (dump.contains("全部", ignoreCase = true) || dump.contains("未读", ignoreCase = true)) {
      return WeworkPage.SESSION_LIST
    }

    return WeworkPage.UNKNOWN
  }

  /**
   * 入站消息上报专用：比 [detect] 略宽松。
   * 列表刷新（TYPE_WINDOW_CONTENT_CHANGED）瞬间节点树可能短暂缺少底部输入区文案，[detect] 会得到 UNKNOWN，此处用顶栏+列表+底部启发式补判为聊天界面。
   *
   * **不支持**：后台、锁屏、仅通知栏、非 com.tencent.wework 前台——必须用户已打开企微且大致在会话页。
   */
  fun isChatSurfaceForInbound(root: AccessibilityNodeInfo?): Boolean {
    if (root == null) return false
    val p = detect(root)
    if (p == WeworkPage.CHAT) return true

    val relaxed = inboundRelaxedLooksLikeChat(root)

    // 会话页常被 [isSearchUi] 判成 SEARCH；刷新瞬间 hasChatPageStructure 也可能暂时为 false，必须用宽松启发式兜底
    if (p == WeworkPage.SEARCH) {
      return relaxed
    }

    if (p == WeworkPage.UNKNOWN) {
      return relaxed
    }

    // 底栏 Tab 文案「消息」与聊天顶栏「更多」会同时进 dump，[detect] 的 HOME 启发式误判；入站仍应按宽松会话特征接受
    if (p == WeworkPage.HOME && relaxed) {
      return true
    }

    return false
  }

  /**
   * 入站专用：不依赖 [detect] 的 SEARCH/UNKNOWN 细分，用顶栏+输入区+消息区痕迹判断是否在群聊页。
   */
  private fun inboundRelaxedLooksLikeChat(root: AccessibilityNodeInfo): Boolean {
    if (hasChatPageStructure(root)) return true
    val dump = dumpText(root, 0, 14)
    val bar = guessChatBarTitle(root)
    // 群资料条常见文案；无「发消息」进 dump 时仍可认定会话（与 hasChatPageStructure 互补）
    if (bar.isNotBlank() && !isStrongGlobalSearchShellDump(dump)) {
      val groupRibbon =
        dump.contains("群主", ignoreCase = true) ||
          dump.contains("外部群", ignoreCase = true) ||
          dump.contains("内部群", ignoreCase = true)
      if (groupRibbon) {
        val ed = NodeFinder.findEditable(root)
        if (ed != null) {
          ed.recycle()
          return true
        }
      }
    }
    val hasToolbar =
      dump.contains("返回", ignoreCase = true) && dump.contains("更多", ignoreCase = true)
    val bottom =
      listOf(
        "发消息",
        "按住说话",
        "按住 说话",
        "语音",
        "表情",
        "相册",
        "发送",
        "文件",
        "拍摄"
      ).any { dump.contains(it, ignoreCase = true) }
    val timeHits = Regex("""\d{1,2}:\d{2}""").findAll(dump).count()
    val msgList =
      timeHits >= 2 ||
        dump.contains("分钟前", ignoreCase = true) ||
        dump.contains("小时前", ignoreCase = true) ||
        (dump.contains("昨天", ignoreCase = true) && dump.length > 200)
    if (bar.isNotBlank() && bottom && (msgList || hasToolbar)) return true
    if (bar.isNotBlank() && msgList && dump.length > 120) return true
    // 消息很少时可能只有一个时间点，但有顶栏+返回+底部输入条仍是会话页
    if (bar.isNotBlank() && bottom && hasToolbar && timeHits >= 1 && dump.length > 80) return true
    return false
  }

  private fun hasFocusedEditable(node: AccessibilityNodeInfo, depth: Int = 0): Boolean {
    if (depth > 24) return false
    if (node.isEditable && node.isFocused) return true
    for (i in 0 until node.childCount) {
      val c = node.getChild(i) ?: continue
      val ok = hasFocusedEditable(c, depth + 1)
      c.recycle()
      if (ok) return true
    }
    return false
  }

  private fun dumpText(node: AccessibilityNodeInfo, depth: Int = 0, maxDepth: Int = 12): String {
    if (depth > maxDepth) return ""
    val sb = StringBuilder()
    val t = node.text?.toString() ?: ""
    val cd = node.contentDescription?.toString() ?: ""
    if (t.isNotBlank()) sb.append(t).append(' ')
    if (cd.isNotBlank()) sb.append(cd).append(' ')
    for (i in 0 until node.childCount) {
      val c = node.getChild(i) ?: continue
      sb.append(dumpText(c, depth + 1, maxDepth))
      c.recycle()
    }
    return sb.toString()
  }
}
