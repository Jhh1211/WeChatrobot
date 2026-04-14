export interface LlmGenerateReplyInput {
  systemPrompt: string;
  userPrompt: string;
}

export interface LlmReplyOutput {
  should_reply: boolean;
  reply_text: string;
  intent: string;
  confidence: number;
  risk_level: "low" | "medium" | "high" | "blocked";
  style: "faq_assistant" | "proactive_operator" | "warm_companion" | "group_assistant";
}
