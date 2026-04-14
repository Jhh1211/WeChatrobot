import { describe, expect, test } from "vitest";
import { classifyIntent } from "../src/modules/intent/intent.service.js";

describe("risk intercept", () => {
  test("should classify complaint intent", () => {
    const intent = classifyIntent("这服务太差了我要投诉");
    expect(intent).toBe("complaint");
  });
});
