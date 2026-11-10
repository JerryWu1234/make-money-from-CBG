import type { Page, Response } from "playwright-core";
import { expect, it } from "vite-plus/test";
import { responseAccessFailure } from "./access-guard";

const main = {};
const page = { mainFrame: () => main } as unknown as Page;
function response(
  status: number,
  url = "https://xyq.cbg.163.com/cgi-bin/equipquery.py",
  type = "xhr",
  frame = main,
) {
  return {
    status: () => status,
    url: () => url,
    request: () => ({ frame: () => frame, resourceType: () => type }),
  } as unknown as Response;
}
it.each([403, 429])("官网业务请求 HTTP %s 识别为整轮暂停原因", (status) => {
  expect(responseAccessFailure(response(status), page)).toMatchObject({
    status,
    kind: status === 429 ? "busy" : "verification",
    code: "CBG_HTTP_ACCESS_BLOCKED",
  });
});
it("主文档被拒绝也暂停，普通错误和无关资源不误报访问受限", () => {
  expect(
    responseAccessFailure(response(403, "https://xyq.cbg.163.com/equip", "document"), page),
  ).toBeDefined();
  for (const value of [
    response(200),
    response(500),
    response(403, "https://sigma-other-cbg.proxima.nie.netease.com/1.gif", "image"),
    response(429, "https://cbg-xyq.res.netease.com/file.js", "script"),
    response(403, "https://xyq.cbg.163.com/icon.gif", "image"),
    response(429, undefined, "fetch", {}),
  ])
    expect(responseAccessFailure(value, page)).toBeUndefined();
});
