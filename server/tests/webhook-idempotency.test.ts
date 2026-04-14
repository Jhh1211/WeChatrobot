import { describe, expect, test } from "vitest";
import { webhookHelper } from "../src/modules/webhook/webhook.service.js";

describe("webhook idempotency", () => {
  test("should use payload unique message id directly", () => {
    const uid = webhookHelper.toEventUid({
      messageId: "msg-abc-123",
      content: "hello"
    });
    expect(uid).toBe("msg-abc-123");
  });

  test("should generate stable hash when message id missing", () => {
    const payload = {
      robotId: "r1",
      senderId: "u1",
      content: "hello",
      timestamp: 1711111111111
    };
    const uid1 = webhookHelper.toEventUid(payload);
    const uid2 = webhookHelper.toEventUid(payload);
    expect(uid1).toBe(uid2);
    expect(uid1.length).toBe(64);
  });
});
