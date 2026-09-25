import { describe, expect, it } from "vite-plus/test";
import { detailFields } from "./detail-view";
describe("readable detail fields", () => {
  it("keeps zero values and mount type without assigning the next field to an empty label", () => {
    expect(
      detailFields({
        name: "坐骑",
        text: "帮派：\t帮贡：0\n类型：\t云魅仙鹿\t成长：\t1.3020",
        fields: [
          { name: "服务器", value: "页头信息" },
          { name: "帮贡", value: "0" },
        ],
        tables: [],
        elements: [],
        tooltips: [],
      }),
    ).toEqual([
      { name: "帮贡", value: "0" },
      { name: "类型", value: "云魅仙鹿" },
      { name: "成长", value: "1.3020" },
    ]);
  });
});
