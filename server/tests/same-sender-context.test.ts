import { describe, expect, test } from "vitest";
import { normalizeSenderKey } from "../src/modules/conversations/same-sender-context.service.js";

describe("normalizeSenderKey", () => {
  test("trims and collapses spaces", () => {
    expect(normalizeSenderKey("  赵 杨太  ")).toBe("赵 杨太");
  });

  test("empty for null", () => {
    expect(normalizeSenderKey(null)).toBe("");
  });
});
