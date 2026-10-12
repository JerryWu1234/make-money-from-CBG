# 项目执行约定

## macOS 浏览器测试

本项目部分测试会用 Playwright 启动本地 Google Chrome，使用临时浏览器配置和模拟页面。Chrome 在 Codex 的受限 macOS 沙箱中无法访问应用注册及窗口服务，可能在启动阶段触发 `SIGABRT`，并弹出系统崩溃报告。

在 Codex 中执行会启动 Chrome 的命令前，必须通过命令工具的审批流程申请在沙箱外运行；使用 `exec_command` 时设置 `sandbox_permissions: "require_escalated"`，说明测试需要启动隔离的本地 Chrome。不要先在沙箱内试运行这类命令。

适用命令包括：

- 完整的 `vp test`。
- 包含 `server/crawler/detail.test.ts` 或 `server/analysis/browser-role-form.test.ts` 的测试命令。
- `vp run test:e2e`、`playwright test`。
- `node scripts/*-regression.mjs` 等调用 `chromium.launch` 或 `chromium.launchPersistentContext` 的浏览器回归脚本。
- 经由其他包管理器或包装脚本执行上述测试的等效命令。

`headless: true` 和 Chrome 的 `--no-sandbox` 参数不能解除 Codex 施加的 macOS 沙箱限制。审批未通过时，报告受阻原因，停止启动浏览器，不在相同权限下反复重试。

不启动浏览器的测试子集、`vp check`（格式、lint、类型检查）和构建继续使用默认沙箱权限。真实采集沿用连接已打开的日常 Chrome 的方式；浏览器测试继续使用临时隔离配置。
