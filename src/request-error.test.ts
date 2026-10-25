import { expect, it } from "vite-plus/test";
import { pollingError } from "./request-error";

it("本地状态请求超时与商品详情错误分开显示", () => {
  expect(
    pollingError(new DOMException("signal timed out", "TimeoutError"), "读取采集进度"),
  ).toContain("读取采集进度超时：本地服务未及时响应");
  const detail = new Error("商品详情：page.goto: Timeout 45000ms exceeded");
  expect(pollingError(detail, "读取采集进度")).toBe(detail.message);
  expect(pollingError(new Error("连接中断"), "读取分析进度")).toBe("连接中断");
});
