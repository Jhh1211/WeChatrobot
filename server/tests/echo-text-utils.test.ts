import { describe, expect, test } from "vitest";
import {
  bigramDiceCoefficient,
  normalizeText,
  normalizeTextForEchoCompare,
  stripLeadingAtMentionsForEcho
} from "../src/common/utils/text.js";
import { inboundMatchesOutboundEcho } from "../src/modules/messages/inbound-echo-suppress.service.js";

describe("stripLeadingAtMentionsForEcho", () => {
  test("去掉单个与多个文首 @", () => {
    expect(stripLeadingAtMentionsForEcho("@小聪 两江国际在成都")).toBe("两江国际在成都");
    expect(stripLeadingAtMentionsForEcho("@张三 @李四 你好")).toBe("你好");
    expect(stripLeadingAtMentionsForEcho("＠微信 正文")).toBe("正文");
  });
});

describe("inboundMatchesOutboundEcho", () => {
  const outbound =
    "两江国际在成都高新大源板块，均价27081元/㎡，有不少300万以上房源。它优势是区位生态好，近公园、商圈和医院，交通也方便。不过小区较冷门，缺地铁，适合在大源上班的地缘性客户。买不买还得结合自身需求和预算考虑。";

  test("persist 同款 normalizeText 入参：@昵称 + 全文与出站一致判回声", () => {
    const raw = `@小聪  ${outbound}`;
    expect(
      inboundMatchesOutboundEcho({
        normalizedInboundText: normalizeText(raw),
        outboundContent: outbound
      })
    ).toBe(true);
  });

  test("个别数字不同但整体高度相似仍判回声", () => {
    const variant = outbound.replace("27081", "27142").replace("300万", "300万左右");
    expect(
      inboundMatchesOutboundEcho({
        normalizedInboundText: normalizeText(variant),
        outboundContent: outbound
      })
    ).toBe(true);
  });

  test("无关短句不误判", () => {
    expect(
      inboundMatchesOutboundEcho({
        normalizedInboundText: normalizeText("嗯嗯好的"),
        outboundContent: outbound
      })
    ).toBe(false);
  });
});

describe("normalizeTextForEchoCompare", () => {
  test("去 @ 后再规范化", () => {
    const s = normalizeTextForEchoCompare(normalizeText("@小聪  你好世界"));
    expect(s).toBe("你好世界");
  });
});

describe("bigramDiceCoefficient", () => {
  test("完全相同为 1", () => {
    expect(bigramDiceCoefficient("abcd", "abcd")).toBe(1);
  });
});
