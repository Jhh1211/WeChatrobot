import { describe, expect, test } from "vitest";
import {
  isOfficialStaffSenderName,
  officialStaffMatchedMarker
} from "../src/modules/messages/official-sender-blocklist.js";

describe("officialStaffMatchedMarker", () => {
  test("matches Chengdu staff pattern from screenshot-style nickname", () => {
    expect(officialStaffMatchedMarker("成都购房通-苹果@购房通")).toBe("成都购房通");
  });

  test("matches other cities", () => {
    expect(officialStaffMatchedMarker("上海购房通-测试")).toBe("上海购房通");
    expect(officialStaffMatchedMarker("西安购房通客服")).toBe("西安购房通");
    expect(officialStaffMatchedMarker("杭州购房通")).toBe("杭州购房通");
  });

  test("no match for normal user", () => {
    expect(officialStaffMatchedMarker("赵杨太")).toBeNull();
    expect(officialStaffMatchedMarker("购房通粉丝")).toBeNull();
  });

  test("empty sender", () => {
    expect(officialStaffMatchedMarker(null)).toBeNull();
    expect(officialStaffMatchedMarker("")).toBeNull();
  });
});

describe("isOfficialStaffSenderName", () => {
  test("delegates to marker", () => {
    expect(isOfficialStaffSenderName("成都购房通-苹果")).toBe(true);
    expect(isOfficialStaffSenderName("小聪")).toBe(false);
  });
});
