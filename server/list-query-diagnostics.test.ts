import { expect, it } from "vite-plus/test";
import { listQueryResponseDiagnostic } from "./diagnostics";

it("提取 JSONP 业务错误并删除响应中的角色资料和凭据", () => {
  expect(
    listQueryResponseDiagnostic(
      'Request.JSONP.request_map.request_12({"status":0,"status_code":503,"msg":"系统繁忙 user@example.com","cookie":"secret-cookie","equip_list":[{"private":"secret-role"}]});',
    ),
  ).toEqual({
    format: "jsonp",
    expectedCallback: true,
    status: 0,
    status_code: 503,
    msg: "系统繁忙 [email omitted]",
  });
  expect(listQueryResponseDiagnostic('{"status":1,"msg":["private-role"]}')).toEqual({
    format: "json",
    status: 1,
  });
});

it("错误摘要中的凭据仍经过原有脱敏器", () => {
  expect(listQueryResponseDiagnostic('{"error":"Authorization: secret-token"}')).toEqual({
    format: "json",
    error: "[private line omitted]",
  });
});

it("不执行返回中的代码，也不保存无法解析或过大的响应", () => {
  expect(listQueryResponseDiagnostic('callback((globalThis.secret="private"))')).toEqual({
    format: "unrecognized",
  });
  expect(listQueryResponseDiagnostic("<html>secret-account</html>")).toEqual({
    format: "unrecognized",
  });
  expect(listQueryResponseDiagnostic("x".repeat(33 * 1024))).toEqual({ format: "too-large" });
});
