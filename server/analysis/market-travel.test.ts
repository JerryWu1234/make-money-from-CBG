import { describe, expect, it } from "vite-plus/test";
import { parseTravelHeatRanks } from "./market-travel";

const fetchedAt = "2026-10-24T03:00:00Z";
const header = "<tr><th>排名</th><th>服务器</th><th>金价（排名）</th><th>热度值（排名）</th></tr>";
const row = "<tr><th>#1</th><td>浙江2区-忆江南</td><td>208.01(136)</td><td>26.7(152)</td></tr>";
const page = (date = "2026年10月20日", table = header + row) =>
  `<h4>梦幻西游-${date}-三年外服务器-烟花列表</h4><table>${table}</table>`;

describe("烟花表的明确热度排名补缺", () => {
  it("只读热度值列的括号排名，忽略行序和金价排名", () => {
    const result = parseTravelHeatRanks(page(), fetchedAt)!;
    expect(result.date).toBe("2026-10-20");
    expect(result.ranks.get("浙江2区-忆江南")).toBe(152);
  });
  it.each(["2026年10月16日", "2026年10月25日", "2026年2月30日"])(
    "拒绝过时、未来或无效日期：%s",
    (date) => {
      expect(parseTravelHeatRanks(page(date), fetchedAt)).toBeNull();
    },
  );
  it("允许恰好七天前，但不从日期菜单的历史链接推断当前表日期", () => {
    expect(parseTravelHeatRanks(page("2026年10月17日"), fetchedAt)).not.toBeNull();
    expect(
      parseTravelHeatRanks(
        '<a href="?dt=20261020">2026-10-20</a><table>' + header + row + "</table>",
        fetchedAt,
      ),
    ).toBeNull();
  });
  it.each([
    page().replace("热度值（排名）", "金价（排名）"),
    page().replace("26.7(152)", "26.7"),
    page().replace("26.7(152)", "26.7(未知)"),
  ])("没有明确热度括号排名不取金价或序号补值", (html) => {
    expect(parseTravelHeatRanks(html, fetchedAt)?.ranks.size || 0).toBe(0);
  });
  it("重复区服、重复表头或日期标识均不补值", () => {
    expect(parseTravelHeatRanks(page(undefined, header + row + row), fetchedAt)).toBeNull();
    expect(parseTravelHeatRanks(page(undefined, header + row + header), fetchedAt)).toBeNull();
    expect(parseTravelHeatRanks(page() + page(), fetchedAt)).toBeNull();
  });
});
