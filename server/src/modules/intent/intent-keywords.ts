import type { MessageIntent } from "./intent.service.js";

// TODO: move intent dictionaries to database-configurable rules.
export const defaultIntentKeywords: Record<MessageIntent, string[]> = {
  faq_question: ["怎么", "如何", "吗", "?", "？", "请问"],
  activity_question: ["活动", "优惠", "报名", "截止"],
  recommendation_request: ["推荐", "哪个好", "预算", "买房", "户型"],
  small_talk: ["哈哈", "在吗", "聊聊", "今天"],
  complaint: ["投诉", "太差", "骗人", "不满意"],
  emotional: ["生气", "愤怒", "崩溃", "烦死"],
  off_topic: ["游戏", "股票", "八卦", "娱乐圈"],
  lead_signal: ["预算", "首付", "看房", "签约", "周末去看"],
  greeting: ["你好", "hi", "hello", "早上好"],
  silence_breaker_candidate: ["有人吗", "都不说话", "冷清", "活跃下"],
  unknown: []
};
