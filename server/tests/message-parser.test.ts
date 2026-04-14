import { describe, expect, test } from "vitest";
import { parseInboundMessage } from "../src/modules/messages/message-parser.js";

describe("message parser", () => {
  test("should parse callback payload to normalized message", () => {
    const message = parseInboundMessage(
      {
        msg_id: "m1",
        robot_id: "robot-1",
        group_id: "group-1",
        group_name: "群A",
        sender_id: "user-1",
        sender_name: "Tom",
        chat_type: "group",
        msg_type: "text",
        text: "  你好   请问活动什么时候结束？  ",
        timestamp: 1711111111111
      },
      "fallback-robot"
    );

    expect(message.robotExternalId).toBe("robot-1");
    expect(message.chatType).toBe("group");
    expect(message.messageType).toBe("text");
    expect(message.messageTextNormalized).toContain("活动什么时候结束");
    expect(message.externalMessageId).toBe("m1");
  });
});
