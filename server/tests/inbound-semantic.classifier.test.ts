import { describe, expect, test } from "vitest";
import { classifyInboundSemantic } from "../src/modules/messages/inbound-semantic.classifier.js";

describe("classifyInboundSemantic", () => {
  test("群聊且发言人名为空时按己方处理", () => {
    const r = classifyInboundSemantic({
      text: "hello",
      isFromRobot: false,
      senderName: null,
      inGroup: true
    });
    expect(r.kind).toBe("self_text");
    expect(r.skipAutoReplyReason).toContain("发言人名为空");
  });

  test("群聊仅空白发言人名同上", () => {
    const r = classifyInboundSemantic({
      text: "hello",
      isFromRobot: false,
      senderName: "   ",
      inGroup: true
    });
    expect(r.kind).toBe("self_text");
  });

  test("群聊有发言人名仍为 user_text（普通文本）", () => {
    const r = classifyInboundSemantic({
      text: "hello",
      isFromRobot: false,
      senderName: "张三",
      inGroup: true
    });
    expect(r.kind).toBe("user_text");
    expect(r.skipAutoReplyReason).toBeNull();
  });

  test("单聊发言人空不因 inGroup 误判", () => {
    const r = classifyInboundSemantic({
      text: "hello",
      isFromRobot: false,
      senderName: "",
      inGroup: false
    });
    expect(r.kind).toBe("user_text");
  });

  test("isFromRobot 优先于空发言人", () => {
    const r = classifyInboundSemantic({
      text: "x",
      isFromRobot: true,
      senderName: "",
      inGroup: true
    });
    expect(r.kind).toBe("self_text");
    expect(r.skipAutoReplyReason).toBe("自己发出去的消息");
  });

  test("正文含「撤回」即为 system_notice（含重新编辑整句）", () => {
    const r = classifyInboundSemantic({
      text: "你撤回了一条消息 重新编辑",
      isFromRobot: false,
      senderName: "张三",
      inGroup: true
    });
    expect(r.kind).toBe("system_notice");
    expect(r.skipAutoReplyReason).toContain("撤回");
  });

  test("含撤回的口语也一律不回复（与产品约定一致）", () => {
    const r = classifyInboundSemantic({
      text: "要是你撤回了一条消息就好了",
      isFromRobot: false,
      senderName: "张三",
      inGroup: true
    });
    expect(r.kind).toBe("system_notice");
  });

  test("不含撤回仍为 user_text", () => {
    const r = classifyInboundSemantic({
      text: "重新编辑一下这段话",
      isFromRobot: false,
      senderName: "张三",
      inGroup: true
    });
    expect(r.kind).toBe("user_text");
  });
});
