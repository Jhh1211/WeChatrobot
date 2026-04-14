package com.wework.aiassistant.executor

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import com.wework.aiassistant.accessibility.ChatPageDetector
import com.wework.aiassistant.accessibility.NodeFinder
import com.wework.aiassistant.accessibility.WeworkPage
import com.wework.aiassistant.storage.RuntimeStatsStore
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.resume
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * 通过无障碍在企业微信内导航；每步有重试与超时，避免死循环。
 */
object ChatNavigator {
  private const val TAG = "WeworkExecutor"
  private const val WEWORK_PKG = "com.tencent.wework"
  private const val MAX_STEPS = 35
  private const val STEP_DELAY_MS = 450L
  private const val VERIFY_AFTER_LIST_CLICK_MS = 550L
  private const val CHAT_VERIFY_RETRY_COUNT = 6
  private const val CHAT_VERIFY_RETRY_DELAY_MS = 420L
  private const val VERIFY_AFTER_SEARCH_ENTRY_MS = 420L
  private const val VERIFY_AFTER_SEARCH_RESULT_MS = 600L
  private const val MAX_CONSECUTIVE_HOME = 10
  private const val MIN_LIST_MATCH_SCORE = 68
  private const val MIN_SEARCH_RESULT_SCORE = 62
  /** 错会话恢复（BACK+回消息 Tab）累计超过则熔断，避免无限点同一行 */
  private const val OPEN_CHAT_MAX_WRONG_RECOVERIES = 10
  /** 监听点群后顶栏校验失败：该行冷却一段时间，避免反复误点 */
  private const val WATCH_ROW_FAILURE_COOLDOWN_MS = 45_000L
  /** 消息列表上未匹配到目标时，先向上滑动列表的次数上限 */
  private const val MAX_HOME_LIST_SCROLLS = 6

  private val lastOpenChatFailure = AtomicReference<String?>(null)
  /** 消息列表监听：同一行短时间内不重复点 */
  private val watchLastRowOpen = AtomicReference<Pair<String, Long>?>(null)
  /** 消息列表监听：校验顶栏不含「群」等问题行的冷却截止时间 (fingerprint -> epochMs) */
  private val watchRowVerifyFailureUntilEpochMs = ConcurrentHashMap<String, Long>()

  private fun isWatchRowInCooldown(fp: String): Boolean {
    val until = watchRowVerifyFailureUntilEpochMs[fp] ?: return false
    val now = System.currentTimeMillis()
    if (now >= until) {
      watchRowVerifyFailureUntilEpochMs.remove(fp, until)
      return false
    }
    return true
  }

  private fun markWatchRowVerifyFailed(fp: String) {
    val until = System.currentTimeMillis() + WATCH_ROW_FAILURE_COOLDOWN_MS
    watchRowVerifyFailureUntilEpochMs[fp] = until
    Log.i(TAG, "message_list_watch row_verify_fail_cooldown fp=$fp until=$until")
  }

  /**
   * 消息列表监听：含「群」视为群聊；企微外部群常在行内带 **「外部」** 标签（标题可能不含「群」字）。
   */
  private fun homeRowTitleQualifiesForGroupWatch(title: String, row: AccessibilityNodeInfo?): Boolean {
    val t = title.trim()
    if (t.length < 2) return false
    if (t.contains("群")) return true
    if (row != null && rowHasExternalBadge(row) && t.length >= 4) return true
    return false
  }

  /** 行内是否存在企微「外部」绿标（文案精确为「外部」的节点）。 */
  private fun rowHasExternalBadge(row: AccessibilityNodeInfo): Boolean {
    fun walk(n: AccessibilityNodeInfo, d: Int): Boolean {
      if (d > 16) return false
      val tx = n.text?.toString()?.trim().orEmpty()
      if (tx == "外部") return true
      for (i in 0 until n.childCount) {
        val c = n.getChild(i) ?: continue
        if (walk(c, d + 1)) {
          c.recycle()
          return true
        }
        c.recycle()
      }
      return false
    }
    return walk(row, 0)
  }

  private val HOME_CHROME_LABELS =
    setOf(
      "消息",
      "邮件",
      "文档",
      "日历",
      "工作台",
      "通讯录",
      "会议",
      "更多",
      "搜索",
      "我",
      "发现",
      "首页",
      "全部",
      "未读",
      "@我",
      "标为未读",
      "网络查找"
    )

  private val HOME_CANDIDATE_BLACKLIST =
    listOf(
      "企业信息",
      "企业简称",
      "企业名片",
      "企业未认证信息真实性",
      "前往认证",
      "@机器人测试"
    )

  private val PROFILE_ROW_TEXT_HINTS =
    listOf(
      "企业信息",
      "企业简称",
      "企业名片",
      "前往认证",
      "未认证",
      "认证信息真实性",
      "企业未认证"
    )

  private val SEARCH_CHROME_LABELS =
    setOf(
      "取消",
      "清空",
      "搜索",
      "联系人",
      "群聊",
      "网络查找",
      "网络查找同事",
      "聊天记录",
      "更多",
      "包含",
      "全部",
      "未读"
    )

  fun consumeLastOpenChatFailure(): String? = lastOpenChatFailure.getAndSet(null)

  /**
   * 发送阶段发现顶栏与目标不符时：返回会话列表并保留行指纹黑名单，供下一轮 [openChatBySearch] 走搜索。
   */
  suspend fun leaveChatForOutboundRetry(
    service: AccessibilityService,
    rowFingerprintBlacklist: MutableSet<String>,
    blacklistRowFingerprint: String?,
  ) {
    recoverFromWrongChatSession(service, rowFingerprintBlacklist, blacklistRowFingerprint, "send_stage_reopen_search")
  }

  suspend fun openChatBySearch(
    service: AccessibilityService,
    targetTitle: String,
    sharedRowFingerprintBlacklist: MutableSet<String>? = null,
  ): Boolean {
    lastOpenChatFailure.set(null)
    val rowFingerprintBlacklist = sharedRowFingerprintBlacklist ?: mutableSetOf()
    val recoveryCounter = intArrayOf(0)
    bringWeworkForeground(service)
    var consecutiveHome = 0
    val searchLabelBlacklist = mutableSetOf<String>()
    val searchEntryViaBlacklist = mutableSetOf<String>()
    var homeListScrollsDone = 0

    repeat(MAX_STEPS) { step ->
      if (recoveryCounter[0] >= OPEN_CHAT_MAX_WRONG_RECOVERIES) {
        Log.e(
          TAG,
          "open_chat_circuit_breaker recoveries=${recoveryCounter[0]} max=$OPEN_CHAT_MAX_WRONG_RECOVERIES target=\"$targetTitle\""
        )
        lastOpenChatFailure.set("open_chat_circuit_breaker")
        RuntimeStatsStore.recordDiag("open_chat_circuit_breaker target=\"$targetTitle\"")
        return false
      }
      var pendingListClick: String? = null
      var pendingSearchEntryVia: String? = null
      val root = service.rootInActiveWindow
      if (root == null) {
        Log.w(TAG, "nav step=$step page=NO_ROOT targetChatTitle=\"$targetTitle\"")
        delay(STEP_DELAY_MS)
        return@repeat
      }
      try {
        val fgPkg = root.packageName?.toString()
        Log.i(TAG, "nav foreground package=$fgPkg step=$step targetChatTitle=\"$targetTitle\"")
        if (fgPkg != WEWORK_PKG) {
          Log.w(TAG, "wrong_foreground_package relaunch_wework pkg=$fgPkg step=$step targetChatTitle=\"$targetTitle\"")
          RuntimeStatsStore.recordDiag("wrong_foreground_package relaunch pkg=$fgPkg")
          bringWeworkForeground(service)
          delay(650)
          return@repeat
        }

        val page = ChatPageDetector.detectForOpenNavigation(root, targetTitle)
        val hasComposer = ChatPageDetector.hasChatPageStructure(root)
        val inSearch = ChatPageDetector.isSearchUi(root)
        Log.i(
          TAG,
          "nav step=$step page=$page hasComposer=$hasComposer searchMode=$inSearch targetChatTitle=\"$targetTitle\""
        )

        when (page) {
          WeworkPage.CHAT_PENDING -> {
            consecutiveHome = 0
            Log.i(TAG, "suppress_home_pick_because_in_chat_pending targetChatTitle=\"$targetTitle\"")
            Log.i(TAG, "final openChat success reason=chat_pending_title_matched target=\"$targetTitle\"")
            return true
          }

          WeworkPage.PROFILE_PAGE -> {
            consecutiveHome = 0
            val reason = ChatPageDetector.badPageReason(root)
            Log.e(TAG, "detected_bad_page bad_page_reason=$reason step=$step")
            RuntimeStatsStore.recordDiag("detected_bad_page $reason step=$step")
            service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
            delay(420L)
            Log.i(TAG, "back_from_bad_page reason=detected_profile_step")
            return@repeat
          }

          WeworkPage.CHAT -> {
            consecutiveHome = 0
            if (hasComposer) {
              val barTitle = ChatPageDetector.guessChatBarTitle(root)
              val titleMatched = ChatPageDetector.chatTitleMatchesExpected(barTitle, targetTitle)
              if (titleMatched) {
                Log.i(
                  TAG,
                  "nav openChat ok page=CHAT hasComposer=true titleOk=true barTitle=\"$barTitle\" targetChatTitle=\"$targetTitle\""
                )
                Log.i(TAG, "final openChat success reason=title_matched target=\"$targetTitle\"")
                return true
              }
              Log.e(
                TAG,
                "opened_wrong_chat actualTitle=\"$barTitle\" expected=\"$targetTitle\" wrong_chat_type=single_or_mismatch source=in_loop"
              )
              recoverFromWrongChatSession(service, rowFingerprintBlacklist, null, "in_loop_chat_title_mismatch", recoveryCounter)
              return@repeat
            }
            if (!hasComposer) {
              val barTitle = ChatPageDetector.guessChatBarTitle(root)
              if (ChatPageDetector.chatTitleMatchesExpected(barTitle, targetTitle)) {
                Log.i(TAG, "suppress_home_pick_because_in_chat_pending page=CHAT no_composer barTitle=\"$barTitle\"")
                Log.i(TAG, "final openChat success reason=chat_pending_title_matched_no_composer target=\"$targetTitle\"")
                return true
              }
              Log.w(TAG, "nav title_false_positive detect=CHAT but no composer targetChatTitle=\"$targetTitle\"")
              lastOpenChatFailure.set("title_false_positive")
              RuntimeStatsStore.recordDiag("title_false_positive detect_CHAT no_composer")
              val (convOk, convDetail) =
                tryClickMatchingConversationRow(
                  service,
                  root,
                  targetTitle,
                  step,
                  searchLabelBlacklist,
                  rowFingerprintBlacklist
                )
              if (convOk) {
                Log.i(TAG, "openChat clicked candidate=$convDetail targetChatTitle=\"$targetTitle\"")
                pendingListClick = convDetail
              } else {
                val (searchOk, via) = attemptOpenSearchEntry(service, root, step, searchEntryViaBlacklist)
                if (searchOk) pendingSearchEntryVia = via
                Log.i(TAG, "nav false-CHAT recovery searchClicked=$searchOk via=$via")
              }
            }
          }

          WeworkPage.SEARCH -> {
            consecutiveHome = 0
            if (runSearchPipelineAndMaybeEnterChat(service, targetTitle, step, searchLabelBlacklist)) {
              return true
            }
          }

          WeworkPage.HOME -> {
            consecutiveHome++
            val (convOk, convDetail) =
              tryClickMatchingConversationRow(
                service,
                root,
                targetTitle,
                step,
                searchLabelBlacklist,
                rowFingerprintBlacklist
              )
            if (convOk) {
              Log.i(TAG, "openChat clicked candidate=$convDetail targetChatTitle=\"$targetTitle\"")
              pendingListClick = convDetail
            } else {
              if (homeListScrollsDone < MAX_HOME_LIST_SCROLLS) {
                homeListScrollsDone++
                scrollHomeSessionListUp(service)
                delay(420)
                consecutiveHome = 0
                Log.i(TAG, "nav HOME list_scroll attempt=$homeListScrollsDone targetChatTitle=\"$targetTitle\"")
                return@repeat
              }
              val (searchOk, via) = attemptOpenSearchEntry(service, root, step, searchEntryViaBlacklist)
              Log.i(TAG, "nav HOME consecutiveHome=$consecutiveHome searchClicked=$searchOk via=$via")
              if (searchOk) {
                pendingSearchEntryVia = via
                consecutiveHome = 0
              } else {
                logVisibleNodesSummary(root, "HOME no list match and no search entry")
                if (consecutiveHome >= MAX_CONSECUTIVE_HOME) {
                  lastOpenChatFailure.set("stuck_on_home_without_match")
                  val msg = "stuck_on_home_without_match steps=$consecutiveHome target=\"$targetTitle\""
                  RuntimeStatsStore.recordDiag(msg)
                  Log.e(TAG, msg)
                  Log.e(
                    TAG,
                    "final openChat failed reason=stuck_on_home_without_match target=\"$targetTitle\" steps=$consecutiveHome"
                  )
                  return false
                }
              }
            }
          }

          WeworkPage.SESSION_LIST -> {
            consecutiveHome = 0
            val (convOk, convDetail) =
              tryClickMatchingConversationRow(
                service,
                root,
                targetTitle,
                step,
                searchLabelBlacklist,
                rowFingerprintBlacklist
              )
            if (convOk) {
              Log.i(TAG, "openChat clicked candidate=$convDetail targetChatTitle=\"$targetTitle\"")
              pendingListClick = convDetail
            } else {
              if (homeListScrollsDone < MAX_HOME_LIST_SCROLLS) {
                homeListScrollsDone++
                scrollHomeSessionListUp(service)
                delay(420)
                Log.i(TAG, "nav SESSION_LIST list_scroll attempt=$homeListScrollsDone targetChatTitle=\"$targetTitle\"")
                return@repeat
              }
              val (searchOk, via) = attemptOpenSearchEntry(service, root, step, searchEntryViaBlacklist)
              Log.i(TAG, "nav SESSION_LIST searchClicked=$searchOk via=$via")
              if (searchOk) pendingSearchEntryVia = via
              if (!searchOk) logVisibleNodesSummary(root, "SESSION_LIST no list match and no search entry")
            }
          }

          WeworkPage.UNKNOWN -> {
            consecutiveHome = 0
            if (ChatPageDetector.chatTitleMatchesExpected(ChatPageDetector.guessChatBarTitle(root), targetTitle)) {
              Log.i(TAG, "suppress_home_pick_because_in_chat_pending fallback_unknown_title_match target=\"$targetTitle\"")
              Log.i(TAG, "final openChat success reason=chat_pending_unknown_title target=\"$targetTitle\"")
              return true
            }
            val (convOk, convDetail) =
              tryClickMatchingConversationRow(
                service,
                root,
                targetTitle,
                step,
                searchLabelBlacklist,
                rowFingerprintBlacklist
              )
            if (convOk) {
              Log.i(TAG, "openChat clicked candidate=$convDetail targetChatTitle=\"$targetTitle\"")
              pendingListClick = convDetail
            } else {
              if (homeListScrollsDone < MAX_HOME_LIST_SCROLLS) {
                homeListScrollsDone++
                scrollHomeSessionListUp(service)
                delay(420)
                Log.i(TAG, "nav UNKNOWN list_scroll attempt=$homeListScrollsDone targetChatTitle=\"$targetTitle\"")
                return@repeat
              }
              val (searchOk, via) = attemptOpenSearchEntry(service, root, step, searchEntryViaBlacklist)
              Log.i(TAG, "nav UNKNOWN searchClicked=$searchOk via=$via")
              if (searchOk) pendingSearchEntryVia = via
              if (!searchOk) logVisibleNodesSummary(root, "UNKNOWN try list/search")
            }
          }
        }
      } finally {
        root.recycle()
      }

      if (pendingSearchEntryVia != null) {
        delay(VERIFY_AFTER_SEARCH_ENTRY_MS)
        val inSearch = verifySearchModeEntered(service, pendingSearchEntryVia!!, targetTitle)
        Log.i(TAG, "openChat search entry verify inSearchMode=$inSearch via=${pendingSearchEntryVia!!}")
        if (!inSearch) {
          searchEntryViaBlacklist.add(pendingSearchEntryVia!!)
          Log.e(
            TAG,
            "search_entry_clicked_but_not_enter_search_mode via=${pendingSearchEntryVia!!} targetChatTitle=\"$targetTitle\" (blacklisted for this openChat)"
          )
          lastOpenChatFailure.set("search_entry_clicked_but_not_enter_search_mode")
          RuntimeStatsStore.recordDiag("search_entry_clicked_but_not_enter_search_mode via=${pendingSearchEntryVia!!}")
        }
      }

      if (pendingListClick != null) {
        if (verifyOpenChatAfterListClick(service, targetTitle, pendingListClick!!, rowFingerprintBlacklist, recoveryCounter)) {
          return true
        }
      }

      delay(STEP_DELAY_MS)
    }

    lastOpenChatFailure.set("open_chat_timeout")
    val timeoutMsg = "open_chat_timeout maxSteps=$MAX_STEPS target=\"$targetTitle\""
    RuntimeStatsStore.recordDiag(timeoutMsg)
    Log.e(TAG, timeoutMsg)
    Log.e(TAG, "final openChat failed reason=open_chat_timeout target=\"$targetTitle\" maxSteps=$MAX_STEPS")
    return false
  }

  private fun verifySearchModeEntered(service: AccessibilityService, via: String, targetTitle: String): Boolean {
    val root = service.rootInActiveWindow ?: return false
    try {
      val pkg = root.packageName?.toString()
      Log.i(TAG, "openChat verify search foreground package=$pkg via=$via")
      if (pkg != WEWORK_PKG) {
        Log.e(TAG, "wrong_foreground_package verify_search pkg=$pkg")
        return false
      }
      val ok = ChatPageDetector.isSearchUi(root)
      val page = ChatPageDetector.detect(root)
      Log.i(TAG, "openChat verify search entry page=$page isSearchUi=$ok via=$via targetChatTitle=\"$targetTitle\"")
      return ok
    } finally {
      root.recycle()
    }
  }

  /**
   * 在 SEARCH 页：写入关键词、扫结果、点击最佳项并校验是否进入 CHAT。
   * @return true 表示已进入目标会话（CHAT + composer + 标题匹配）
   */
  private suspend fun runSearchPipelineAndMaybeEnterChat(
    service: AccessibilityService,
    targetTitle: String,
    step: Int,
    searchLabelBlacklist: MutableSet<String>
  ): Boolean {
    val root0 = service.rootInActiveWindow ?: return false
    try {
      val rootPkg = root0.packageName?.toString()
      Log.i(TAG, "search pipeline foreground package=$rootPkg step=$step")
      if (rootPkg != WEWORK_PKG) {
        Log.e(TAG, "blocked_non_wework_input rootPkg=$rootPkg")
        return false
      }
      if (!ChatPageDetector.isSearchUi(root0)) {
        Log.e(TAG, "blocked_non_wework_input not_search_ui rootPkg=$rootPkg")
        Log.w(TAG, "nav SEARCH step=$step but isSearchUi=false, skip pipeline targetChatTitle=\"$targetTitle\"")
        return false
      }
      val edit = findSearchEditable(root0) ?: run {
        Log.w(TAG, "nav SEARCH step=$step no editable targetChatTitle=\"$targetTitle\"")
        return false
      }
      val editPkg = edit.packageName?.toString()
      if (editPkg != WEWORK_PKG) {
        Log.e(TAG, "blocked_non_wework_input editPkg=$editPkg")
        edit.recycle()
        return false
      }

      Log.i(TAG, "search setText target node package=$editPkg target=\"$targetTitle\" step=$step")
      edit.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
      var applied = setTextOnNode(edit, targetTitle)
      Log.i(TAG, "search setText actionPerformed=$applied target=\"$targetTitle\"")
      var hasQ = editableLikelyHasQuery(edit, targetTitle)
      if (!hasQ) {
        applied = setTextOnNode(edit, targetTitle)
        hasQ = editableLikelyHasQuery(edit, targetTitle)
      }
      if (!hasQ) {
        Log.w(TAG, "search setText fail field empty try paste target=\"$targetTitle\"")
        val pasteOk = tryPasteQuery(service, edit, targetTitle)
        hasQ = editableLikelyHasQuery(edit, targetTitle)
        if (hasQ) {
          Log.i(TAG, "search setText success via=paste target=\"$targetTitle\" pasteAction=$pasteOk")
        } else {
          Log.e(TAG, "search setText fail after paste target=\"$targetTitle\"")
        }
      } else {
        Log.i(TAG, "search setText success target=\"$targetTitle\"")
      }
      edit.recycle()
    } finally {
      root0.recycle()
    }

    delay(STEP_DELAY_MS + 320L)

    val root1 = service.rootInActiveWindow ?: return false
    if (root1.packageName?.toString() != WEWORK_PKG) {
      Log.e(TAG, "blocked_non_wework_input search_results rootPkg=${root1.packageName}")
      root1.recycle()
      return false
    }
    val clickedLabel: String
    try {
      val scores = mutableMapOf<String, Int>()
      collectSearchResultScores(root1, targetTitle, searchLabelBlacklist, scores, 0, 16)
      val sorted =
        scores.entries.sortedWith(
          compareByDescending<Map.Entry<String, Int>> { it.value }.thenBy { it.key.length }
        )
      val candStr = sorted.joinToString(",") { "${it.key}=${it.value}" }
      Log.i(
        TAG,
        "search results candidates=$candStr count=${sorted.size} targetChatTitle=\"$targetTitle\""
      )

      val sortedOk = sorted.filter { it.key !in searchLabelBlacklist }
      val best = sortedOk.firstOrNull { it.value >= MIN_SEARCH_RESULT_SCORE }
      if (best == null) {
        Log.w(TAG, "search no clickable result above threshold=$MIN_SEARCH_RESULT_SCORE target=\"$targetTitle\" blacklistSize=${searchLabelBlacklist.size}")
        return false
      }

      Log.i(TAG, "candidate type=conversation search pick score=${best.value} text=\"${best.key}\"")
      Log.i(TAG, "search pick result score=${best.value} text=\"${best.key}\"")
      val hit = findClickableWithDisplayText(root1, best.key)
      if (hit == null) {
        Log.w(TAG, "search no node for result text=\"${best.key}\"")
        return false
      }
      val clickOk = hit.performAction(AccessibilityNodeInfo.ACTION_CLICK)
      hit.recycle()
      clickedLabel = best.key
      Log.i(TAG, "clicked search result=\"$clickedLabel\" clickOk=$clickOk score=${best.value}")
    } finally {
      root1.recycle()
    }

    delay(VERIFY_AFTER_SEARCH_RESULT_MS)
    val root2 = service.rootInActiveWindow ?: return false
    try {
      val vPkg = root2.packageName?.toString()
      if (vPkg != WEWORK_PKG) {
        Log.e(TAG, "wrong_foreground_package after_search_click pkg=$vPkg")
        searchLabelBlacklist.add(clickedLabel)
        Log.i(TAG, "blacklist add candidate=$clickedLabel reason=search_verify_wrong_pkg")
        RuntimeStatsStore.recordDiag("clicked_result_but_not_chat wrong_pkg=$vPkg")
        Log.e(TAG, "clicked_result_but_not_chat pkg=$vPkg result=\"$clickedLabel\"")
        return false
      }
      val page = ChatPageDetector.detect(root2)
      val hasComposer = ChatPageDetector.hasChatPageStructure(root2)
      val titleOk = treeMatchesChatTitle(root2, targetTitle)
      Log.i(
        TAG,
        "openChat after search result foreground package=$vPkg page=$page hasComposer=$hasComposer titleOk=$titleOk clicked=\"$clickedLabel\" targetChatTitle=\"$targetTitle\""
      )
      if (page == WeworkPage.PROFILE_PAGE) {
        Log.e(
          TAG,
          "clicked_bad_result_type page=PROFILE_PAGE source=search_result clicked=\"$clickedLabel\""
        )
        searchLabelBlacklist.add(clickedLabel)
        Log.i(TAG, "blacklist add candidate=$clickedLabel reason=search_opened_profile")
        service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
        delay(420L)
        Log.i(TAG, "back_from_bad_page reason=search_profile")
        RuntimeStatsStore.recordDiag("clicked_bad_result_type search PROFILE clicked=$clickedLabel")
        return false
      }
      if (page == WeworkPage.CHAT && hasComposer) {
        val barTitle = ChatPageDetector.guessChatBarTitle(root2)
        if (ChatPageDetector.chatTitleMatchesExpected(barTitle, targetTitle)) {
          Log.i(TAG, "nav openChat ok after search page=CHAT hasComposer barTitle=\"$barTitle\" targetChatTitle=\"$targetTitle\"")
          return true
        }
        Log.e(TAG, "search_wrong_chat barTitle=\"$barTitle\" expected=\"$targetTitle\" clicked=\"$clickedLabel\"")
        searchLabelBlacklist.add(clickedLabel)
        RuntimeStatsStore.recordDiag("search_wrong_chat_title clicked=$clickedLabel bar=$barTitle")
        service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
        delay(420L)
        goHomeTabMessages(service)
        return false
      }
      Log.e(
        TAG,
        "clicked_result_but_not_chat page=$page hasComposer=$hasComposer titleOk=$titleOk result=\"$clickedLabel\""
      )
      searchLabelBlacklist.add(clickedLabel)
      Log.i(TAG, "blacklist add candidate=$clickedLabel reason=search_not_entered_chat page=$page")
      RuntimeStatsStore.recordDiag(
        "clicked_result_but_not_chat page=$page hasComposer=$hasComposer clicked=\"$clickedLabel\""
      )
      return false
    } finally {
      root2.recycle()
    }
  }

  private fun findSearchEditable(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
    val focused = NodeFinder.dfs(root) { it.isEditable && it.isFocused }
    if (focused != null && !isLikelyChatComposerEdit(focused, root)) {
      return focused
    }
    focused?.recycle()
    return NodeFinder.dfs(root) { n -> n.isEditable && !isLikelyChatComposerEdit(n, root) }
  }

  /** 会话底部「发消息」输入框：不可当作全局搜索框，否则会把 targetTitle 写进聊天草稿。 */
  private fun isLikelyChatComposerEdit(node: AccessibilityNodeInfo, root: AccessibilityNodeInfo): Boolean {
    if (Build.VERSION.SDK_INT >= 26) {
      val h = node.hintText?.toString().orEmpty()
      if (h.contains("发消息", ignoreCase = true)) return true
    }
    val nr = Rect()
    val rr = Rect()
    node.getBoundsInScreen(nr)
    root.getBoundsInScreen(rr)
    if (rr.height() > 0) {
      val splitY = rr.top + (rr.height() * 0.52f).toInt()
      if (nr.centerY() >= splitY) return true
    }
    return false
  }

  private fun setTextOnNode(node: AccessibilityNodeInfo, text: String): Boolean {
    val args = Bundle()
    args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
    return node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
  }

  private fun editableLikelyHasQuery(node: AccessibilityNodeInfo, q: String): Boolean {
    val needle = q.trim()
    if (needle.isEmpty()) return false
    val t = node.text?.toString().orEmpty()
    return t.contains(needle, ignoreCase = true)
  }

  private fun tryPasteQuery(service: AccessibilityService, edit: AccessibilityNodeInfo, q: String): Boolean {
    return try {
      val cm = service.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
      cm.setPrimaryClip(ClipData.newPlainText("wework_search", q))
      edit.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
      edit.performAction(AccessibilityNodeInfo.ACTION_PASTE)
    } catch (e: Exception) {
      Log.w(TAG, "paste search query", e)
      false
    }
  }

  private fun collectSearchResultScores(
    node: AccessibilityNodeInfo,
    targetTitle: String,
    searchLabelBlacklist: MutableSet<String>,
    out: MutableMap<String, Int>,
    depth: Int,
    maxDepth: Int
  ) {
    if (depth > maxDepth) return
    val t = node.text?.toString()?.trim().orEmpty()
    if (node.isClickable && t.isNotEmpty() && t.length <= 56 && !isSearchChromeLabel(t)) {
      if (t in searchLabelBlacklist) {
        Log.i(TAG, "candidate skipped by blacklist candidate=$t context=search_scan")
      } else {
        val vid = node.viewIdResourceName?.lowercase().orEmpty()
        if (vid.contains("corp")) {
          Log.i(TAG, "candidate type=bad skip search row viewId=$vid text=${t.take(40)}")
        } else {
          when (val kind = classifyCandidateKindText(t)) {
            "conversation" -> {
              val s = scoreListItemAgainstTarget(t, targetTitle)
              if (s > 0) {
                val prev = out[t] ?: 0
                if (s > prev) out[t] = s
              }
            }
            else -> Log.i(TAG, "candidate type=$kind skip search row text=${t.take(40)}")
          }
        }
      }
    }
    for (i in 0 until node.childCount) {
      val c = node.getChild(i) ?: continue
      collectSearchResultScores(c, targetTitle, searchLabelBlacklist, out, depth + 1, maxDepth)
      c.recycle()
    }
  }

  private fun isSearchChromeLabel(text: String): Boolean {
    if (text.length <= 1) return true
    if (SEARCH_CHROME_LABELS.any { text.equals(it, ignoreCase = true) }) return true
    return false
  }

  /** 会话行文案粗分：conversation 可参与打分，profile/bad 仅企业资料或 @ 等入口 */
  private fun classifyCandidateKindText(text: String): String {
    val t = text.trim()
    if (t.startsWith("@")) return "bad"
    if (PROFILE_ROW_TEXT_HINTS.any { hint -> t.contains(hint, ignoreCase = true) }) return "profile"
    return "conversation"
  }

  private fun listClickDetailFingerprint(clickedDetail: String): String? =
    when {
      clickedDetail.startsWith("conversation_row_fp:") ->
        clickedDetail.removePrefix("conversation_row_fp:").trim().takeIf { it.isNotEmpty() }
      else -> null
    }

  private suspend fun recoverFromWrongChatSession(
    service: AccessibilityService,
    rowFingerprintBlacklist: MutableSet<String>,
    fingerprintToBlacklist: String?,
    reason: String,
    recoveryCounter: IntArray? = null,
  ) {
    recoveryCounter?.let {
      it[0]++
      Log.w(TAG, "wrong_chat_recovery_count=${it[0]} reason=$reason")
    }
    fingerprintToBlacklist?.let { fp ->
      rowFingerprintBlacklist.add(fp)
      Log.i(TAG, "blacklist_row fingerprint=$fp reason=$reason")
    }
    service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
    delay(450L)
    Log.i(TAG, "back_from_wrong_chat reason=$reason")
    goHomeTabMessages(service)
  }

  private suspend fun goHomeTabMessages(service: AccessibilityService) {
    delay(320L)
    bringWeworkForeground(service)
    delay(280L)
    val root = service.rootInActiveWindow ?: run {
      Log.w(TAG, "reenter_home_tab_success=false no_root")
      return
    }
    try {
      if (root.packageName?.toString() != WEWORK_PKG) {
        Log.w(TAG, "reenter_home_tab_success=false wrong_pkg=${root.packageName}")
        return
      }
      val tab = NodeFinder.findClickableWithText(root, "消息")
      if (tab != null) {
        val ok = tab.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        tab.recycle()
        if (ok) {
          Log.i(TAG, "reenter_home_tab_success=true via=clickable_text_消息")
          return
        }
      }
      Log.w(TAG, "reenter_home_tab_success=false no_message_tab")
    } finally {
      root.recycle()
    }
  }

  private fun fingerprintForBounds(r: Rect): String = "${r.left}_${r.top}_${r.right}_${r.bottom}"

  private fun fingerprintForNodeBounds(node: AccessibilityNodeInfo): String {
    val r = Rect()
    node.getBoundsInScreen(r)
    return fingerprintForBounds(r)
  }

  private data class HomeRowModel(
    val titleText: String,
    val previewText: String,
    val timeText: String,
    val fingerprint: String,
    val rowBounds: Rect
  )

  private fun isLikelyTimeLine(s: String): Boolean {
    val t = s.trim()
    if (t.matches(Regex("""^\d{1,2}:\d{2}$"""))) return true
    if (t in setOf("昨天", "刚刚", "前天")) return true
    if (t.contains("月", ignoreCase = true) && t.contains("日", ignoreCase = true)) return true
    return false
  }

  private fun extractHomeRowModel(row: AccessibilityNodeInfo): HomeRowModel {
    val rowBounds = Rect()
    row.getBoundsInScreen(rowBounds)
    val lines = mutableListOf<Pair<String, Rect>>()
    fun walk(n: AccessibilityNodeInfo, depth: Int) {
      if (depth > 14) return
      val tx = n.text?.toString()?.trim().orEmpty()
      if (tx.isNotEmpty() && tx.length <= 120) {
        val r = Rect()
        n.getBoundsInScreen(r)
        lines.add(tx to r)
      }
      for (i in 0 until n.childCount) {
        val c = n.getChild(i) ?: continue
        walk(c, depth + 1)
        c.recycle()
      }
    }
    walk(row, 0)
    val sorted = lines.sortedWith(compareBy<Pair<String, Rect>> { it.second.top }.thenBy { it.second.left })
    val nonTime = sorted.map { it.first }.filter { !isLikelyTimeLine(it) && !isHomeChromeLabel(it) }
    val titleText = nonTime.getOrNull(0).orEmpty()
    val previewText = nonTime.getOrNull(1).orEmpty()
    val timeText = sorted.map { it.first }.firstOrNull { isLikelyTimeLine(it) }.orEmpty()
    val fingerprint = fingerprintForBounds(rowBounds)
    return HomeRowModel(titleText, previewText, timeText, fingerprint, rowBounds)
  }

  private fun homeTextMatchPriority(t: String, target: String): Int? {
    if (t.equals(target, ignoreCase = true)) return 0
    if (normalizeForMatch(t).equals(normalizeForMatch(target), ignoreCase = true)) return 1
    if (ChatPageDetector.titlesLikelySameConversation(t, target)) return 2
    if (t.contains(target, ignoreCase = true) && t.length <= target.length + 8) return 3
    return null
  }

  private fun collectAllHomeListMatchCopies(
    root: AccessibilityNodeInfo,
    targetTitle: String
  ): List<Triple<AccessibilityNodeInfo, String, Int>> {
    val target = targetTitle.trim()
    val out = mutableListOf<Triple<AccessibilityNodeInfo, String, Int>>()
    fun walk(n: AccessibilityNodeInfo, depth: Int) {
      if (depth > 18) return
      val t = n.text?.toString()?.trim().orEmpty()
      if (t.isNotEmpty() &&
        t.length <= 120 &&
        !isHomeChromeLabel(t) &&
        !isBlacklistedHomeCandidate(t) &&
        classifyCandidateKindText(t) == "conversation" &&
        !forbiddenRobotTestWhenTargetIsGroup(target, t)
      ) {
        val prio = homeTextMatchPriority(t, target)
        if (prio != null) {
          out.add(Triple(AccessibilityNodeInfo.obtain(n), t, prio))
        }
      }
      for (i in 0 until n.childCount) {
        val c = n.getChild(i) ?: continue
        walk(c, depth + 1)
        c.recycle()
      }
    }
    walk(root, 0)
    return out.sortedWith(
      compareBy<Triple<AccessibilityNodeInfo, String, Int>> { it.third }.thenBy { tr ->
        val r = Rect()
        tr.first.getBoundsInScreen(r)
        r.top
      }
    )
  }

  private fun matchInTitleVsPreview(target: String, model: HomeRowModel): String {
    val tgt = target.trim()
    val title = model.titleText
    val prev = model.previewText
    val titleHit =
      title.equals(tgt, ignoreCase = true) ||
        normalizeForMatch(title).equals(normalizeForMatch(tgt), ignoreCase = true) ||
        title.contains(tgt, ignoreCase = true) ||
        ChatPageDetector.titlesLikelySameConversation(title, tgt)
    val previewHit = prev.contains(tgt, ignoreCase = true)
    if (titleHit) return "title"
    if (previewHit && !titleHit) return "preview"
    return "none"
  }

  /**
   * 从标题文本向上找「会话行」尺度的可点击父节点，排除 RecyclerView 根与过大容器。
   */
  private fun ascendToConstrainedRowClickable(
    service: AccessibilityService,
    textNode: AccessibilityNodeInfo,
    maxUp: Int
  ): Pair<AccessibilityNodeInfo, Rect>? {
    val titleRect = Rect()
    textNode.getBoundsInScreen(titleRect)
    val dm = service.resources.displayMetrics
    val screenW = dm.widthPixels
    val screenH = dm.heightPixels
    val density = dm.density
    val rowMinH = (40 * density).toInt().coerceAtLeast(36)
    val rowMaxH = (190 * density).toInt().coerceAtMost(screenH / 4)
    val minRowW = (screenW * 0.36f).toInt().coerceAtLeast(200)

    var best: AccessibilityNodeInfo? = null
    var bestH = Int.MAX_VALUE
    var cur: AccessibilityNodeInfo? = textNode.parent
    var d = 0
    while (cur != null && d < maxUp) {
      if (cur.isClickable) {
        val cls = cur.className?.toString() ?: ""
        val skipRv = cls.contains("RecyclerView", ignoreCase = true) || cls.contains("ListView", ignoreCase = true)
        val r = Rect()
        cur.getBoundsInScreen(r)
        val h = r.height()
        val w = r.width()
        val tcx = titleRect.centerX()
        val tcy = titleRect.centerY()
        val coversTitle = tcx >= r.left && tcx <= r.right && tcy >= r.top && tcy <= r.bottom
        val valid =
          !skipRv &&
            h in rowMinH..rowMaxH &&
            w >= minRowW &&
            h <= screenH / 5 &&
            coversTitle
        Log.i(
          TAG,
          "ascend_clickable_parent candidateBounds=[${r.left},${r.top},${r.right},${r.bottom}] row_bounds_valid=$valid h=$h w=$w"
        )
        if (valid && h < bestH) {
          best?.recycle()
          best = AccessibilityNodeInfo.obtain(cur)
          bestH = h
        }
      }
      val p = cur.parent
      cur.recycle()
      cur = p
      d++
    }
    val b = best ?: return null
    val br = Rect()
    b.getBoundsInScreen(br)
    return b to br
  }

  private suspend fun verifyOpenChatAfterListClick(
    service: AccessibilityService,
    targetTitle: String,
    clickedDetail: String,
    rowFingerprintBlacklist: MutableSet<String>,
    recoveryCounter: IntArray? = null,
  ): Boolean {
    delay(VERIFY_AFTER_LIST_CLICK_MS)
    val rowFp = listClickDetailFingerprint(clickedDetail)
    var everTitleMatchedNormalized = false

    for (attempt in 0 until CHAT_VERIFY_RETRY_COUNT) {
      if (attempt > 0) {
        delay(CHAT_VERIFY_RETRY_DELAY_MS)
      }
      val root = service.rootInActiveWindow ?: continue
      try {
        val pkg = root.packageName?.toString()
        if (pkg != WEWORK_PKG) {
          Log.e(TAG, "wrong_foreground_package list_verify pkg=$pkg")
          continue
        }
        if (attempt == 0) {
          Log.i(
            TAG,
            "openChat verify list click foreground package=$pkg clicked=$clickedDetail clicked_row_fingerprint=${rowFp ?: "none"}"
          )
        }

        val page = ChatPageDetector.detectForOpenNavigation(root, targetTitle)
        if (page == WeworkPage.PROFILE_PAGE) {
          val br = ChatPageDetector.badPageReason(root)
          Log.e(
            TAG,
            "clicked_bad_result_type page=PROFILE_PAGE source=list_click bad_page_reason=$br fingerprint=${rowFp ?: "none"}"
          )
          rowFp?.let {
            rowFingerprintBlacklist.add(it)
            Log.i(TAG, "blacklist_row fingerprint=$it reason=list_opened_profile")
          }
          RuntimeStatsStore.recordDiag("clicked_bad_result_type list PROFILE fp=$rowFp")
          service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
          delay(420L)
          Log.i(TAG, "back_from_bad_page reason=list_click_profile")
          goHomeTabMessages(service)
          Log.e(TAG, "final openChat fail after retry reason=profile_page")
          return false
        }

        val barTitle = ChatPageDetector.guessChatBarTitle(root)
        val normalizedBar = ChatPageDetector.normalizeChatTitleForMatch(barTitle)
        val normalizedTarget = ChatPageDetector.normalizeChatTitleForMatch(targetTitle)
        val titleMatchedNormalized = ChatPageDetector.chatTitleMatchesExpected(barTitle, targetTitle)
        if (titleMatchedNormalized) {
          everTitleMatchedNormalized = true
        }
        Log.i(
          TAG,
          "normalizedBarTitle=$normalizedBar normalizedTargetTitle=$normalizedTarget titleMatchedNormalized=$titleMatchedNormalized"
        )

        val hasComposer = ChatPageDetector.hasChatPageStructure(root)
        val pageEff = ChatPageDetector.effectiveChatPageForOpenVerify(root, page, targetTitle)
        Log.i(
          TAG,
          "chat_verify_retry index=$attempt page=$page effectivePage=$pageEff hasComposer=$hasComposer barTitle=\"$barTitle\""
        )

        if (titleMatchedNormalized) {
          Log.i(
            TAG,
            "final openChat success after retry reason=title_matched_chat_pending attempts=${attempt + 1} page=$page effectivePage=$pageEff"
          )
          return true
        }
      } finally {
        root.recycle()
      }
    }

    val rootFinal = service.rootInActiveWindow ?: run {
      Log.e(TAG, "final openChat fail after retry reason=no_root_final")
      return false
    }
    try {
      val barTitle = ChatPageDetector.guessChatBarTitle(rootFinal)
      val normalizedBar = ChatPageDetector.normalizeChatTitleForMatch(barTitle)
      val normalizedTarget = ChatPageDetector.normalizeChatTitleForMatch(targetTitle)
      val titleMatchedNormalized = ChatPageDetector.chatTitleMatchesExpected(barTitle, targetTitle)
      Log.i(
        TAG,
        "verify_final normalizedBarTitle=$normalizedBar normalizedTargetTitle=$normalizedTarget titleMatchedNormalized=$titleMatchedNormalized everTitleMatchedNormalized=$everTitleMatchedNormalized"
      )

      if (everTitleMatchedNormalized || titleMatchedNormalized) {
        Log.i(TAG, "skip_back_because_title_matched fingerprint=${rowFp ?: "none"}")
        Log.i(
          TAG,
          "final openChat success after retry reason=title_matched_final_root ever=$everTitleMatchedNormalized title=$titleMatchedNormalized"
        )
        return true
      }

      val page = ChatPageDetector.detect(rootFinal)
      val hasComposer = ChatPageDetector.hasChatPageStructure(rootFinal)
      if (hasComposer && barTitle.isNotEmpty() && !titleMatchedNormalized) {
        Log.e(
          TAG,
          "opened_wrong_chat actualTitle=\"$barTitle\" expected=\"$targetTitle\" wrong_chat_type=single_or_mismatch"
        )
        rowFp?.let { fp ->
          rowFingerprintBlacklist.add(fp)
          Log.i(TAG, "delay_blacklist fingerprint=$fp reason=opened_wrong_chat_after_retry")
        }
        recoverFromWrongChatSession(service, rowFingerprintBlacklist, null, "opened_wrong_chat", recoveryCounter)
        Log.e(TAG, "final openChat fail after retry reason=opened_wrong_chat")
        return false
      }
      if (page == WeworkPage.HOME || page == WeworkPage.UNKNOWN) {
        Log.e(
          TAG,
          "clicked_row_but_not_chat page=$page hasComposer=$hasComposer targetChatTitle=\"$targetTitle\" fingerprint=${rowFp ?: "none"}"
        )
        rowFp?.let { fp ->
          rowFingerprintBlacklist.add(fp)
          Log.i(TAG, "delay_blacklist fingerprint=$fp reason=list_verify_not_chat_after_retry")
        }
        Log.e(TAG, "row_candidate_blacklisted fingerprint=${rowFp ?: "none"}")
        recoverFromWrongChatSession(service, rowFingerprintBlacklist, null, "list_verify_not_chat", recoveryCounter)
        if (page == WeworkPage.HOME) {
          lastOpenChatFailure.set("open_chat_failed_still_home")
          RuntimeStatsStore.recordDiag("open_chat_failed_still_home clicked=$clickedDetail target=\"$targetTitle\"")
        }
        Log.e(TAG, "final openChat fail after retry reason=list_verify_not_chat")
        return false
      }

      rowFp?.let { fp ->
        rowFingerprintBlacklist.add(fp)
        Log.i(TAG, "delay_blacklist fingerprint=$fp reason=list_verify_other_after_retry page=$page")
      }
      if (hasComposer && !titleMatchedNormalized) {
        lastOpenChatFailure.set("title_false_positive")
        RuntimeStatsStore.recordDiag("title_false_positive composer_title_mismatch clicked=$clickedDetail")
      } else if (!hasComposer && treeMatchesChatTitle(rootFinal, targetTitle)) {
        lastOpenChatFailure.set("title_false_positive")
        RuntimeStatsStore.recordDiag("title_false_positive title_in_tree_no_composer clicked=$clickedDetail")
      }
      recoverFromWrongChatSession(service, rowFingerprintBlacklist, null, "list_verify_fallback", recoveryCounter)
      Log.e(TAG, "final openChat fail after retry reason=list_verify_fallback page=$page")
      return false
    } finally {
      rootFinal.recycle()
    }
  }

  private fun tryClickMatchingConversationRow(
    service: AccessibilityService,
    root: AccessibilityNodeInfo,
    targetTitle: String,
    step: Int,
    searchLabelBlacklist: MutableSet<String>,
    rowFingerprintBlacklist: MutableSet<String>
  ): Pair<Boolean, String> {
    if (ChatPageDetector.shouldSuppressHomeConversationPick(root, targetTitle)) {
      Log.i(TAG, "suppress_home_pick_because_in_chat_pending tryClickMatchingConversationRow")
      return false to "suppress_in_chat_pending"
    }
    tryClickHomeRowByChildTextFirst(service, root, targetTitle, step, rowFingerprintBlacklist)?.let {
      return it
    }

    val scoresByText = mutableMapOf<String, Int>()
    collectHomeListClickableScores(root, targetTitle, scoresByText, depth = 0, maxDepth = 16)
    refineHomeCandidates(scoresByText, targetTitle)
    searchLabelBlacklist.forEach { bl ->
      if (scoresByText.remove(bl) != null) {
        Log.i(TAG, "candidate skipped by blacklist candidate=$bl context=home_pick")
      }
    }
    val sorted =
      scoresByText.entries.sortedWith(
        compareByDescending<Map.Entry<String, Int>> { it.value }.thenBy { it.key.length }
      )
    val candStr = sorted.joinToString(",") { "${it.key}=${it.value}" }
    Log.i(TAG, "nav step=$step home candidates=$candStr targetChatTitle=\"$targetTitle\"")

    val best = sorted.firstOrNull() ?: return false to "no_candidates"
    if (best.value < MIN_LIST_MATCH_SCORE) {
      Log.i(
        TAG,
        "nav step=$step candidate score=${best.value} below threshold=$MIN_LIST_MATCH_SCORE text=\"${best.key}\" skip list"
      )
      return false to "below_threshold"
    }

    Log.i(TAG, "candidate type=conversation home pick score=${best.value} text=\"${best.key}\" step=$step")
    Log.i(TAG, "nav step=$step candidate score=${best.value} text=\"${best.key}\"")
    val node = findClickableWithDisplayText(root, best.key)
    if (node == null) {
      Log.w(TAG, "nav step=$step no clickable node for winning text=\"${best.key}\"")
      return false to "no_node"
    }
    val fp = fingerprintForNodeBounds(node)
    if (fp in rowFingerprintBlacklist) {
      Log.i(TAG, "candidate skipped by blacklist fingerprint=$fp context=home_clickable_text")
      node.recycle()
      return false to "row_fp_blacklisted"
    }
    val clickOk = node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
    node.recycle()
    Log.i(TAG, "clicked_row_fingerprint=$fp text=\"${best.key}\" clickOk=$clickOk")
    return clickOk to "conversation_row_fp:$fp"
  }

  private fun tryClickHomeRowByChildTextFirst(
    service: AccessibilityService,
    root: AccessibilityNodeInfo,
    targetTitle: String,
    step: Int,
    rowFingerprintBlacklist: MutableSet<String>
  ): Pair<Boolean, String>? {
    val target = targetTitle.trim()
    if (target.isEmpty()) return null
    if (ChatPageDetector.shouldSuppressHomeConversationPick(root, targetTitle)) {
      Log.i(TAG, "ignore_message_bubble_as_home_row tryClickHomeRowByChildTextFirst target=\"$target\"")
      return null
    }

    val matches = collectAllHomeListMatchCopies(root, targetTitle)
    for (idx in matches.indices) {
      val (textCopy, matchedText, _) = matches[idx]
      try {
        Log.i(TAG, "text_match_nonclickable text=\"$matchedText\" target=\"$target\" step=$step")
        val ascended = ascendToConstrainedRowClickable(service, textCopy, maxUp = 16)
        if (ascended == null) {
          Log.w(TAG, "ascend_clickable_parent fail childText=\"$matchedText\"")
          continue
        }
        val (row, rowBounds) = ascended
        val fp = fingerprintForBounds(rowBounds)
        if (fp in rowFingerprintBlacklist) {
          Log.i(TAG, "candidate skipped by blacklist fingerprint=$fp context=row_pick")
          row.recycle()
          continue
        }
        Log.i(TAG, "ascend_clickable_parent success childText=\"$matchedText\"")
        val model = extractHomeRowModel(row)
        Log.i(
          TAG,
          "row_model title=\"${model.titleText}\" preview=\"${model.previewText.take(48)}\" time=\"${model.timeText}\" fingerprint=\"${model.fingerprint}\""
        )
        val matchIn = matchInTitleVsPreview(target, model)
        Log.i(TAG, "match_in=$matchIn matchedText=\"$matchedText\"")
        if (matchIn != "title") {
          row.recycle()
          continue
        }
        Log.i(TAG, "row_bounds_valid=true fingerprint=$fp")
        Log.i(TAG, "candidate row derived from child text=\"$matchedText\"")
        Log.i(TAG, "clicked_row_fingerprint=$fp")
        val clickOk = row.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        row.recycle()
        if (!clickOk) continue
        Log.i(TAG, "clicked conversation row by child-text match text=\"$matchedText\" fp=$fp")
        for (j in (idx + 1) until matches.size) {
          try {
            matches[j].first.recycle()
          } catch (_: Exception) {
          }
        }
        return true to "conversation_row_fp:$fp"
      } catch (_: Exception) {
        continue
      } finally {
        try {
          textCopy.recycle()
        } catch (_: Exception) {
        }
      }
    }
    return null
  }

  private fun isBlacklistedHomeCandidate(text: String): Boolean =
    HOME_CANDIDATE_BLACKLIST.any { text.contains(it, ignoreCase = true) }

  /**
   * 黑名单过滤；若存在与 target 完全一致的候选则只保留该候选，避免「测试群」退化点到「机器人测试」。
   */
  private fun refineHomeCandidates(scores: MutableMap<String, Int>, targetTitle: String) {
    val t = targetTitle.trim()
    scores.keys.toList().forEach { k ->
      if (isBlacklistedHomeCandidate(k)) {
        scores.remove(k)
        Log.i(TAG, "blocked_bad_home_candidate blacklist text=$k")
      }
    }
    val exactKey = scores.keys.find { it.equals(t, ignoreCase = true) && (scores[it] ?: 0) >= 90 }
    if (exactKey != null) {
      scores.keys.toList().forEach { k ->
        if (!k.equals(t, ignoreCase = true)) {
          scores.remove(k)
          Log.i(TAG, "blocked_bad_home_candidate prefer_exact=$exactKey removed=$k")
        }
      }
      return
    }
    val nT = normalizeForMatch(t)
    if (nT.isEmpty()) return
    val normKeys =
      scores.keys.filter { k ->
        normalizeForMatch(k).equals(nT, ignoreCase = true) && (scores[k] ?: 0) >= 85
      }
    if (normKeys.isEmpty()) return
    scores.keys.toList().forEach { k ->
      if (normKeys.none { it.equals(k, ignoreCase = true) }) {
        scores.remove(k)
        Log.i(TAG, "blocked_bad_home_candidate prefer_norm_exact targetNorm=$nT removed=$k")
      }
    }
  }

  private fun collectHomeListClickableScores(
    node: AccessibilityNodeInfo,
    targetTitle: String,
    out: MutableMap<String, Int>,
    depth: Int,
    maxDepth: Int
  ) {
    if (depth > maxDepth) return
    val t = node.text?.toString()?.trim().orEmpty()
    if (node.isClickable && t.isNotEmpty() && t.length <= 48 && !isHomeChromeLabel(t) && !isBlacklistedHomeCandidate(t)) {
      val vid = node.viewIdResourceName?.lowercase().orEmpty()
      if (vid.contains("corp")) {
        Log.i(TAG, "candidate type=bad skip home row viewId=$vid text=${t.take(40)}")
      } else {
        when (val kind = classifyCandidateKindText(t)) {
          "conversation" -> {
            val s = scoreListItemAgainstTarget(t, targetTitle)
            if (s > 0) {
              val prev = out[t] ?: 0
              if (s > prev) out[t] = s
            }
          }
          else -> Log.i(TAG, "candidate type=$kind skip home row text=${t.take(40)}")
        }
      }
    }
    for (i in 0 until node.childCount) {
      val c = node.getChild(i) ?: continue
      collectHomeListClickableScores(c, targetTitle, out, depth + 1, maxDepth)
      c.recycle()
    }
  }

  private fun isHomeChromeLabel(text: String): Boolean {
    if (text.length <= 1) return true
    if (HOME_CHROME_LABELS.any { text.equals(it, ignoreCase = true) }) return true
    if (HOME_CHROME_LABELS.any { text.startsWith(it, ignoreCase = true) && text.length <= it.length + 1 }) return true
    return false
  }

  private fun normalizeForMatch(s: String): String {
    var t = ChatPageDetector.stripUiNoiseForTitle(s).trim()
    val suffixes = listOf("群", "讨论组", "聊天", "（群）", "(群)")
    var changed = true
    while (changed) {
      changed = false
      for (suf in suffixes) {
        if (t.endsWith(suf, ignoreCase = true)) {
          t = t.dropLast(suf.length).trim()
          changed = true
        }
      }
    }
    return t
  }

  private fun scoreListItemAgainstTarget(itemText: String, targetTitle: String): Int {
    val item = itemText.trim()
    val target = targetTitle.trim()
    if (item.isEmpty() || target.isEmpty()) return 0

    if (ChatPageDetector.titlesLikelySameConversation(item, target)) return 92

    if (forbiddenRobotTestWhenTargetIsGroup(target, item)) {
      Log.i(TAG, "blocked_bad_home_candidate robot_test_vs_group_target target=\"$target\" item=\"$item\"")
      return 0
    }

    if (item.equals(target, ignoreCase = true)) return 100

    val nItem = normalizeForMatch(item)
    val nTarget = normalizeForMatch(target)

    if (nItem.equals(nTarget, ignoreCase = true)) return 95
    if (item.equals(nTarget, ignoreCase = true)) return 93
    if (nItem.equals(target, ignoreCase = true)) return 93

    if (item.contains(target, ignoreCase = true) || target.contains(item, ignoreCase = true)) return 88

    if (nItem.isNotEmpty() && nTarget.isNotEmpty()) {
      if (nItem.contains(nTarget, ignoreCase = true) || nTarget.contains(nItem, ignoreCase = true)) {
        val minL = minOf(nItem.length, nTarget.length)
        return if (minL >= 2) 86 else 72
      }
      if (nTarget.startsWith(nItem, ignoreCase = true) || nItem.startsWith(nTarget, ignoreCase = true)) {
        return 82
      }
      if (nTarget.length >= 2 && nItem.contains(nTarget, ignoreCase = true)) return 80
      if (nItem.length >= 2 && nTarget.contains(nItem, ignoreCase = true)) return 80
    }

    return fuzzyLevenshteinScore(item, target)
  }

  /** 目标为群聊名（含「群」）时，禁止把「机器人测试」等误当同一会话 */
  private fun forbiddenRobotTestWhenTargetIsGroup(targetTitle: String, itemText: String): Boolean {
    if (!targetTitle.contains("群")) return false
    if (!itemText.contains("机器人测试", ignoreCase = true)) return false
    if (itemText.equals(targetTitle, ignoreCase = true)) return false
    if (itemText.contains(targetTitle, ignoreCase = true) || targetTitle.contains(itemText, ignoreCase = true)) {
      return false
    }
    return true
  }

  private fun fuzzyLevenshteinScore(a: String, b: String): Int {
    val maxLen = maxOf(a.length, b.length)
    if (maxLen == 0) return 0
    val d = levenshtein(a.lowercase(), b.lowercase())
    val sim = 100 - (d * 100 / maxLen)
    return if (sim >= 55) sim else 0
  }

  private fun levenshtein(a: String, b: String): Int {
    val m = a.length
    val n = b.length
    var prevRow = IntArray(n + 1) { it }
    for (i in 1..m) {
      val cur = IntArray(n + 1)
      cur[0] = i
      for (j in 1..n) {
        val cost = if (a[i - 1].equals(b[j - 1], ignoreCase = true)) 0 else 1
        cur[j] = minOf(prevRow[j] + 1, cur[j - 1] + 1, prevRow[j - 1] + cost)
      }
      prevRow = cur
    }
    return prevRow[n]
  }

  private fun findClickableWithDisplayText(root: AccessibilityNodeInfo, text: String): AccessibilityNodeInfo? {
    return NodeFinder.dfs(root) { n ->
      n.isClickable && n.text?.toString()?.trim().equals(text.trim(), ignoreCase = true)
    }
  }

  private fun treeMatchesChatTitle(root: AccessibilityNodeInfo, targetTitle: String): Boolean {
    if (treeContains(root, targetTitle)) return true
    val n = normalizeForMatch(targetTitle)
    if (n.isNotEmpty() && treeContains(root, n)) return true
    return false
  }

  private fun nodeInsideListLikeContainer(node: AccessibilityNodeInfo): Boolean {
    var cur: AccessibilityNodeInfo? = node.parent
    var depth = 0
    while (cur != null && depth < 24) {
      val cls = cur.className?.toString().orEmpty()
      val isList = cls.contains("RecyclerView", ignoreCase = true) || cls.contains("ListView", ignoreCase = true)
      val next = cur.parent
      cur.recycle()
      if (isList) return true
      cur = next
      depth++
    }
    return false
  }

  private fun isSearchTextLikelyInTopBar(service: AccessibilityService, node: AccessibilityNodeInfo): Boolean {
    val r = Rect()
    node.getBoundsInScreen(r)
    val h = service.resources.displayMetrics.heightPixels
    if (h <= 0) return false
    return r.centerY() < h * 0.28f && r.top < h * 0.22f
  }

  private fun attemptOpenSearchEntry(
    service: AccessibilityService,
    root: AccessibilityNodeInfo,
    step: Int,
    bannedVias: Set<String>,
  ): Pair<Boolean, String> {
    if ("clickable_text_搜索" !in bannedVias) {
      val c1 = NodeFinder.findClickableWithText(root, "搜索")
      if (c1 != null) {
        if (!nodeInsideListLikeContainer(c1)) {
          val ok = c1.performAction(AccessibilityNodeInfo.ACTION_CLICK)
          c1.recycle()
          Log.i(TAG, "nav searchEntry step=$step type=clickable_text_搜索 clickOk=$ok")
          return ok to "clickable_text_搜索"
        }
        c1.recycle()
      }
    }

    if ("contentDescription_search" !in bannedVias) {
      val c2 =
        NodeFinder.dfs(root) { n ->
          val d = n.contentDescription?.toString().orEmpty()
          n.isClickable &&
            !nodeInsideListLikeContainer(n) &&
            (
              d.contains("搜索", ignoreCase = true) ||
                d.contains("search", ignoreCase = true) ||
                d.contains("查找", ignoreCase = true)
            )
        }
      if (c2 != null) {
        val ok = c2.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        val desc = c2.contentDescription?.toString().orEmpty()
        c2.recycle()
        Log.i(TAG, "nav searchEntry step=$step type=contentDescription clickOk=$ok descSnippet=${desc.take(40)}")
        return ok to "contentDescription_search"
      }
    }

    if ("viewId_search" !in bannedVias) {
      val c3 =
        NodeFinder.dfs(root) { n ->
          val id = n.viewIdResourceName?.lowercase().orEmpty()
          n.isClickable &&
            !nodeInsideListLikeContainer(n) &&
            (id.contains("search") || id.contains("find") || id.contains("global_search"))
        }
      if (c3 != null) {
        val ok = c3.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        val id = c3.viewIdResourceName.orEmpty()
        c3.recycle()
        Log.i(TAG, "nav searchEntry step=$step type=viewId clickOk=$ok id=$id")
        return ok to "viewId_search"
      }
    }

    if ("text_搜索_ancestor" !in bannedVias) {
      val tNode = NodeFinder.findByText(root, "搜索", true)
      if (tNode != null) {
        val inList = nodeInsideListLikeContainer(tNode)
        val inTop = isSearchTextLikelyInTopBar(service, tNode)
        if (inList || !inTop) {
          Log.w(
            TAG,
            "nav searchEntry step=$step skip_unsafe_text_搜索_ancestor inList=$inList topBar=$inTop"
          )
          tNode.recycle()
          return false to "none"
        }
        val ok = clickSelfOrAncestor(tNode, maxUp = 8)
        Log.i(TAG, "nav searchEntry step=$step type=text_搜索_ancestor clickOk=$ok")
        return ok to "text_搜索_ancestor"
      }
    }

    return false to "none"
  }

  private suspend fun scrollHomeSessionListUp(service: AccessibilityService) {
    if (Build.VERSION.SDK_INT < 24) {
      Log.i(TAG, "list_scroll skip api=${Build.VERSION.SDK_INT}")
      return
    }
    val dm = service.resources.displayMetrics
    val h = dm.heightPixels
    val w = dm.widthPixels
    val x = w / 2f
    val yStart = (h * 0.72f).coerceIn(220f, (h - 100).toFloat())
    val yEnd = (h * 0.38f).coerceIn(140f, yStart - 100f)
    val path = Path().apply {
      moveTo(x, yStart)
      lineTo(x, yEnd)
    }
    val stroke = GestureDescription.StrokeDescription(path, 0, 320)
    val gesture = GestureDescription.Builder().addStroke(stroke).build()
    suspendCancellableCoroutine { cont ->
      val dispatched =
        service.dispatchGesture(
          gesture,
          object : AccessibilityService.GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription?) {
              cont.resume(Unit)
            }

            override fun onCancelled(gestureDescription: GestureDescription?) {
              cont.resume(Unit)
            }
          },
          null
        )
      if (!dispatched) {
        Log.w(TAG, "list_scroll dispatchGesture=false")
        cont.resume(Unit)
      }
    }
    delay(180)
    Log.i(TAG, "list_scroll swipe y=$yStart->$yEnd")
  }

  private fun clickSelfOrAncestor(start: AccessibilityNodeInfo, maxUp: Int): Boolean {
    var n: AccessibilityNodeInfo? = start
    var depth = 0
    while (n != null && !n.isClickable && depth < maxUp) {
      val p = n.parent
      if (n !== start) n.recycle()
      n = p
      depth++
    }
    return when {
      n != null && n.isClickable -> {
        val ok = n.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        if (n !== start) n.recycle()
        start.recycle()
        ok
      }
      else -> {
        val ok = start.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        start.recycle()
        ok
      }
    }
  }

  private fun logVisibleNodesSummary(root: AccessibilityNodeInfo, reason: String) {
    val lines = mutableListOf<String>()
    collectInterestingNodes(root, lines, maxLines = 40, depth = 0, maxDepth = 14)
    val joined = lines.joinToString(" \n ")
    Log.w(TAG, "nav visibleNodes reason=$reason count=${lines.size}\n$joined")
    RuntimeStatsStore.recordDiag("visibleNodes $reason (${lines.size}) ${joined.take(500)}")
  }

  private fun collectInterestingNodes(
    node: AccessibilityNodeInfo,
    out: MutableList<String>,
    maxLines: Int,
    depth: Int,
    maxDepth: Int
  ) {
    if (out.size >= maxLines || depth > maxDepth) return
    val text = node.text?.toString()?.trim().orEmpty()
    val desc = node.contentDescription?.toString()?.trim().orEmpty()
    val id = node.viewIdResourceName.orEmpty()
    val cls = node.className?.toString()?.substringAfterLast('.') ?: ""
    if (text.isNotEmpty() || desc.isNotEmpty() || id.isNotEmpty()) {
      val clip = 48
      val sb = StringBuilder()
      sb.append("[").append(cls)
      if (text.isNotEmpty()) sb.append(" text=").append(text.take(clip))
      if (desc.isNotEmpty()) sb.append(" desc=").append(desc.take(clip))
      if (id.isNotEmpty()) sb.append(" id=").append(id.take(clip))
      sb.append(" click=").append(node.isClickable)
      sb.append("]")
      out.add(sb.toString())
    }
    for (i in 0 until node.childCount) {
      if (out.size >= maxLines) return
      val c = node.getChild(i) ?: continue
      collectInterestingNodes(c, out, maxLines, depth + 1, maxDepth)
      c.recycle()
    }
  }

  private fun treeContains(node: AccessibilityNodeInfo, needle: String, depth: Int = 0): Boolean {
    if (depth > 40) return false
    val t = node.text?.toString().orEmpty()
    val d = node.contentDescription?.toString().orEmpty()
    if (t.contains(needle, ignoreCase = true) || d.contains(needle, ignoreCase = true)) return true
    for (i in 0 until node.childCount) {
      val c = node.getChild(i) ?: continue
      val ok = treeContains(c, needle, depth + 1)
      c.recycle()
      if (ok) return true
    }
    return false
  }

  private fun bringWeworkForeground(service: AccessibilityService) {
    try {
      val intent = service.packageManager.getLaunchIntentForPackage("com.tencent.wework")
      intent?.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
      if (intent != null) service.startActivity(intent)
    } catch (e: Exception) {
      Log.w(TAG, "launch wework", e)
    }
  }

  /**
   * 发消息任务结束后回到「消息」列表，便于继续监听其它未读群。
   */
  suspend fun returnToMessageList(service: AccessibilityService) {
    repeat(6) {
      val root = service.rootInActiveWindow ?: run {
        delay(400)
        return@repeat
      }
      try {
        if (root.packageName?.toString() != WEWORK_PKG) return
        when (val page = ChatPageDetector.detect(root)) {
          WeworkPage.HOME, WeworkPage.SESSION_LIST -> {
            goHomeTabMessages(service)
            return
          }
          WeworkPage.CHAT, WeworkPage.CHAT_PENDING -> {
            service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
            delay(450)
          }
          WeworkPage.SEARCH, WeworkPage.PROFILE_PAGE -> {
            service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
            delay(450)
          }
          WeworkPage.UNKNOWN -> {
            if (ChatPageDetector.hasChatPageStructure(root)) {
              service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
              delay(450)
            } else {
              goHomeTabMessages(service)
              return
            }
          }
        }
      } finally {
        root.recycle()
      }
    }
    goHomeTabMessages(service)
  }

  /**
   * 在消息 Tab 会话列表上，点第一个「标题含群 + 有未读角标/条数」的行并校验进入聊天。
   * @return 规范化后的群标题；未找到或失败返回 null
   */
  suspend fun openFirstUnreadGroupConversation(service: AccessibilityService): String? {
    val root = service.rootInActiveWindow ?: return null
    try {
      if (root.packageName?.toString() != WEWORK_PKG) return null
      val page = ChatPageDetector.detect(root)
      if (page != WeworkPage.HOME && page != WeworkPage.SESSION_LIST) return null
      if (ChatPageDetector.isSearchUi(root)) return null

      val listHost = findBestHomeSessionListHost(root) ?: run {
        Log.i(TAG, "message_list_watch no_list_host")
        return null
      }
      try {
        val screenW = service.resources.displayMetrics.widthPixels
        data class WatchRowCand(
          val model: HomeRowModel,
          val fingerprint: String,
          val index: Int,
          val hadExternal: Boolean,
        )

        val cands = mutableListOf<WatchRowCand>()
        for (i in 0 until listHost.childCount) {
          val row = listHost.getChild(i) ?: continue
          try {
            val model = extractHomeRowModel(row)
            if (!homeRowTitleQualifiesForGroupWatch(model.titleText, row)) continue
            if (isWatchRowInCooldown(model.fingerprint)) continue
            if (!homeRowLooksUnread(row, screenW, model)) continue
            val hadEx = rowHasExternalBadge(row)
            cands.add(WatchRowCand(model, model.fingerprint, i, hadEx))
          } finally {
            row.recycle()
          }
        }
        if (cands.isEmpty()) {
          Log.i(TAG, "message_list_watch no_unread_group_row")
          return null
        }
        val pick = cands.maxByOrNull { timeFreshnessRank(it.model.timeText) }!!
        val now = SystemClock.uptimeMillis()
        val prev = watchLastRowOpen.get()
        if (prev != null && prev.first == pick.fingerprint && now - prev.second < 10_000L) {
          Log.i(TAG, "message_list_watch skip_dedup fp=${pick.fingerprint}")
          return null
        }

        val rowNode = listHost.getChild(pick.index) ?: return null
        try {
          val clickOk =
            if (rowNode.isClickable) {
              rowNode.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            } else {
              val titleNode = findConversationTitleNodeInRow(rowNode, pick.model.titleText)
              if (titleNode != null) {
                try {
                  val ascended = ascendToConstrainedRowClickable(service, titleNode, maxUp = 16)
                  if (ascended != null) {
                    val (clickTarget, _) = ascended
                    val ok = clickTarget.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                    clickTarget.recycle()
                    ok
                  } else {
                    false
                  }
                } finally {
                  titleNode.recycle()
                }
              } else {
                false
              }
            }
          if (!clickOk) {
            Log.w(TAG, "message_list_watch row_click_failed fp=${pick.fingerprint}")
            return null
          }
        } finally {
          rowNode.recycle()
        }

        delay(550)
        val r2 = service.rootInActiveWindow ?: return null
        try {
          if (!ChatPageDetector.isChatSurfaceForInbound(r2)) {
            Log.w(TAG, "message_list_watch verify_not_chat_surface")
            return null
          }
          val bar = ChatPageDetector.guessChatBarTitle(r2)
          val groupLikeChat =
            bar.contains("群") ||
              (pick.hadExternal && (bar.contains("外部") || treeContains(r2, "外部群")))
          if (!groupLikeChat) {
            Log.w(
              TAG,
              "message_list_watch verify_not_group_like bar=\"$bar\" hadExternal=${pick.hadExternal}"
            )
            markWatchRowVerifyFailed(pick.fingerprint)
            service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
            delay(400)
            goHomeTabMessages(service)
            return null
          }
          watchLastRowOpen.set(pick.fingerprint to SystemClock.uptimeMillis())
          val normalized = ChatPageDetector.normalizeGroupTitleForServer(bar)
          Log.i(TAG, "message_list_watch opened normalizedTitle=$normalized")
          return normalized
        } finally {
          r2.recycle()
        }
      } finally {
        listHost.recycle()
      }
    } finally {
      root.recycle()
    }
  }

  private fun findBestHomeSessionListHost(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
    val holders = mutableListOf<AccessibilityNodeInfo>()
    fun walk(n: AccessibilityNodeInfo, d: Int) {
      if (d > 38) return
      val cn = n.className?.toString().orEmpty()
      val isListLike = cn.contains("RecyclerView", ignoreCase = true) || cn.contains("ListView", ignoreCase = true)
      if (isListLike && n.childCount >= 2) {
        holders.add(AccessibilityNodeInfo.obtain(n))
      }
      for (i in 0 until n.childCount) {
        val c = n.getChild(i) ?: continue
        walk(c, d + 1)
        c.recycle()
      }
    }
    walk(root, 0)
    if (holders.isEmpty()) return null

    fun groupLikeRowCount(host: AccessibilityNodeInfo): Int {
      var cnt = 0
      for (i in 0 until host.childCount) {
        val row = host.getChild(i) ?: continue
        try {
          val m = extractHomeRowModel(row)
          if (homeRowTitleQualifiesForGroupWatch(m.titleText, row)) cnt++
        } finally {
          row.recycle()
        }
      }
      return cnt
    }

    val best = holders.maxByOrNull { groupLikeRowCount(it) }!!
    holders.forEach { h ->
      if (h != best) h.recycle()
    }
    return best
  }

  private fun homeRowLooksUnread(row: AccessibilityNodeInfo, screenW: Int, model: HomeRowModel): Boolean {
    val timeT = model.timeText.trim()
    val preview = model.previewText
    val title = model.titleText
    if (Regex("""\[\d+条\]""").containsMatchIn(preview) || Regex("""\[\d+条\]""").containsMatchIn(title)) {
      return true
    }
    var foundLeftDigitBadge = false
    fun walk(n: AccessibilityNodeInfo, d: Int) {
      if (d > 14 || foundLeftDigitBadge) return
      val t = n.text?.toString()?.trim().orEmpty()
      if (Regex("""^[1-9]\d?$""").matches(t) && t != timeT) {
        val r = Rect()
        n.getBoundsInScreen(r)
        if (r.centerX() < screenW * 0.45f && r.width() < screenW / 5) {
          foundLeftDigitBadge = true
          return
        }
      }
      if (Regex("""^\[\d+条\]$""").matches(t)) {
        foundLeftDigitBadge = true
        return
      }
      for (i in 0 until n.childCount) {
        val c = n.getChild(i) ?: continue
        walk(c, d + 1)
        c.recycle()
      }
    }
    walk(row, 0)
    return foundLeftDigitBadge
  }

  private fun timeFreshnessRank(timeText: String): Int {
    val t = timeText.trim()
    if (t == "刚刚") return 1000
    Regex("""^(\d+)\s*分钟前$""").find(t)?.groupValues?.getOrNull(1)?.toIntOrNull()?.let { m ->
      return (900 - m.coerceIn(0, 899))
    }
    if (t == "昨天" || t == "前天") return 100
    if (t.contains("月", ignoreCase = true) && t.contains("日", ignoreCase = true)) return 50
    if (Regex("""^\d{1,2}:\d{2}$""").matches(t)) return 200
    return 10
  }

  private fun findConversationTitleNodeInRow(row: AccessibilityNodeInfo, title: String): AccessibilityNodeInfo? {
    var best: AccessibilityNodeInfo? = null
    fun walk(n: AccessibilityNodeInfo, d: Int) {
      if (d > 14) return
      val tx = n.text?.toString()?.trim().orEmpty()
      if (tx.isNotEmpty() &&
        !isHomeChromeLabel(tx) &&
        !isLikelyTimeLine(tx) &&
        classifyCandidateKindText(tx) == "conversation" &&
        (tx == title || tx.contains(title) || title.contains(tx))
      ) {
        best?.recycle()
        best = AccessibilityNodeInfo.obtain(n)
      }
      for (i in 0 until n.childCount) {
        val c = n.getChild(i) ?: continue
        walk(c, d + 1)
        c.recycle()
      }
    }
    walk(row, 0)
    return best
  }
}
