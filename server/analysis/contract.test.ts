import { describe, expect, it } from "vite-plus/test";
import { analysisRecord, analysisResponse } from "../../tests/fixtures/analysis";
import { buildProductDocument } from "./product-document";
import { analysisPrompt, validateAnalysis } from "./contract";

const record = analysisRecord();
const document = buildProductDocument(record);
describe("商品分析结果与原文核对", () => {
  it("一次请求包含完整商品，依据核验后在服务端计算加权总分", () => {
    const prompt = analysisPrompt(document);
    expect(prompt.split(document.text)).toHaveLength(2);
    expect(prompt).toContain("宝宝8");
    const response = analysisResponse(record);
    response.dimensions.foundation.score = 90;
    response.dimensions.equipment.score = 70;
    response.dimensions.pets.score = 60;
    const result = validateAnalysis(JSON.stringify(response), document, record);
    expect(result.score).toBe(76);
    expect(result.inputHash).toBe(document.contentHash);
  });
  it("资料不足仍保存说明，总分不补算", () => {
    const response = analysisResponse(record);
    response.dimensions.pets = { score: null, reason: "缺少必需属性", evidence: [] };
    response.missingData = ["召唤兽必要属性"];
    expect(validateAnalysis(JSON.stringify(response), document, record).score).toBeNull();
  });
  it.each(["productKey", "inputHash"])("拒绝与输入不匹配的 %s", (key) => {
    expect(() =>
      validateAnalysis(
        JSON.stringify({ ...analysisResponse(record), [key]: "wrong" }),
        document,
        record,
      ),
    ).toThrow("不匹配");
  });
  it("拒绝不存在的字段、编造的字段值和没有依据的评分", () => {
    const response = analysisResponse(record);
    response.dimensions.pets.evidence[0].path = "/detail/tabs/3/pets/8/name";
    expect(() => validateAnalysis(JSON.stringify(response), document, record)).toThrow("不存在");
    response.dimensions.pets.evidence[0].path = "/detail/tabs/3/pets/0/name";
    response.dimensions.pets.evidence[0].value = "编造的宝宝";
    expect(() => validateAnalysis(JSON.stringify(response), document, record)).toThrow("不一致");
    response.dimensions.pets.evidence = [];
    expect(() => validateAnalysis(JSON.stringify(response), document, record)).toThrow(
      "缺少字段依据",
    );
  });
  it("拒绝截断 JSON 与超范围评分", () => {
    expect(() => validateAnalysis('{"summary":', document, record)).toThrow("完整 JSON");
    const response = analysisResponse(record);
    response.dimensions.foundation.score = 101;
    expect(() => validateAnalysis(JSON.stringify(response), document, record)).toThrow("超出范围");
  });
});
