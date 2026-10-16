import { describe, expect, it } from "vite-plus/test";
import { evidenceSignature, isEvidencePage } from "./work-page-evidence";

describe("真实工作页证据边界", () => {
  it("只接受HTTPS官方站点，不读取其他日常页或相似域名", () => {
    expect(isEvidencePage("https://xyq.cbg.163.com/equip?s=1&eid=abc")).toBe(true);
    for (const url of [
      "about:blank",
      "https://example.com",
      "http://xyq.cbg.163.com",
      "https://xyq.cbg.163.com.example.com",
    ])
      expect(isEvidencePage(url)).toBe(false);
  });
  it("相同状态去重，查询、主商品或可见结果变化必须产生新签名", () => {
    const state = {
      url: "https://xyq.cbg.163.com/equip?s=1&eid=a",
      submittedArgs: { kindid: "11" },
      product: { eid: "a" },
      visibleText: "loading",
    };
    expect(evidenceSignature(state)).toBe(evidenceSignature(structuredClone(state)));
    for (const changed of [
      { ...state, submittedArgs: { kindid: "12" } },
      { ...state, product: { eid: "b" } },
      { ...state, visibleText: "loaded" },
    ])
      expect(evidenceSignature(changed)).not.toBe(evidenceSignature(state));
  });
});
