import { describe, expect, it } from "vitest";
import { parseLlmReplyFromModelContent } from "../src/integrations/llm/llm-reply-parse.js";

describe("llm-reply-parse", () => {
  it("coerces Chinese enums and should_reply number", () => {
    const raw = {
      should_reply: 1,
      reply_text: "你好",
      intent: "faq_question",
      confidence: "0.9",
      risk_level: "低",
      style: "简洁友好"
    };
    const out = parseLlmReplyFromModelContent(JSON.stringify(raw));
    expect(out.should_reply).toBe(true);
    expect(out.risk_level).toBe("low");
    expect(out.style).toBe("warm_companion");
    expect(out.confidence).toBe(0.9);
  });

  it("maps casual/normal to warm_companion", () => {
    const raw = {
      should_reply: true,
      reply_text: "ok",
      intent: "x",
      confidence: 0.5,
      risk_level: "low",
      style: "casual"
    };
    const out = parseLlmReplyFromModelContent(JSON.stringify(raw));
    expect(out.style).toBe("warm_companion");
  });

  it("parses fenced json block", () => {
    const content = '```json\n{"should_reply":true,"reply_text":"hi","intent":"u","confidence":1,"risk_level":"medium","style":"group_assistant"}\n```';
    const out = parseLlmReplyFromModelContent(content);
    expect(out.reply_text).toBe("hi");
    expect(out.risk_level).toBe("medium");
  });
});
