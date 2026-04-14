export type MessageIntent =
  | "faq_question"
  | "activity_question"
  | "recommendation_request"
  | "small_talk"
  | "complaint"
  | "emotional"
  | "off_topic"
  | "lead_signal"
  | "greeting"
  | "silence_breaker_candidate"
  | "unknown";

import { defaultIntentKeywords as intentKeywords } from "./intent-keywords.js";

export function classifyIntent(text: string): MessageIntent {
  const normalized = text.toLowerCase();
  for (const [intent, words] of Object.entries(intentKeywords) as Array<[MessageIntent, string[]]>) {
    if (words.some((word) => normalized.includes(word.toLowerCase()))) {
      return intent;
    }
  }
  return "unknown";
}
