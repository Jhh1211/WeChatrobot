import { describe, expect, test } from "vitest";
import { deriveMentionFields } from "../src/integrations/executor/mention-fields.js";

describe("deriveMentionFields", () => {
  test("购房通-鱼丸@购房通 → 搜索鱼丸", () => {
    const m = deriveMentionFields("购房通-鱼丸@购房通");
    expect(m).not.toBeNull();
    expect(m!.mentionSearchQuery).toBe("鱼丸");
    expect(m!.mentionMatchLabel).toBe("购房通-鱼丸@购房通");
  });

  test("小聪@微信 → 搜索全串", () => {
    const m = deriveMentionFields("小聪@微信");
    expect(m).not.toBeNull();
    expect(m!.mentionSearchQuery).toBe("小聪@微信");
    expect(m!.mentionMatchLabel).toBe("小聪@微信");
  });

  test("空/null", () => {
    expect(deriveMentionFields(null)).toBeNull();
    expect(deriveMentionFields("  ")).toBeNull();
  });
});
