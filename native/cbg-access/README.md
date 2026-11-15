# CBG 扩展与 macOS 输入宿主

这条实验通路由限域 MV3 扩展、Chrome Native Messaging、当前服务的 Unix socket 和原生 AX/Quartz 输入组成。读取、等待、目标定位和证据均不连接 CDP；业务资料仍走项目原有身份、完整性及数据库事务门槛。

## 安装

1. 在准备使用的固定 Chrome 配置中打开 `chrome://extensions`，启用开发者模式，加载仓库的 `extension/cbg-access/`。记录 Chrome 显示的扩展 ID。
2. 在仓库中执行：

   ```sh
   node native/cbg-access/install.mjs 扩展ID "$PWD/data/cbg-access.sock"
   ```

   安装器使用系统 clang 构建 Objective-C 宿主，将程序放入当前用户的 `~/Library/Application Support/CBGAccess/`，并注册固定扩展 ID 的 Native Messaging 允许名单。不会修改浏览器配置或访问官网。

3. 在 macOS 系统设置中为安装后的 `cbg-input` 授予辅助功能及输入监控权限。宿主只检查授权，不循环弹窗。读取 AX/DOM 证据不需要屏幕录制；状态接口另行报告屏幕录制权限。
4. 服务中选择“扩展与 macOS 输入”。在官网完成登录和角色查询后，点击扩展按钮绑定当前标签页。再次点击立即停止输入。

原生输入只在已绑定标签页、Chrome 前台窗口、解锁会话和有效访问许可下执行。用户鼠标/键盘输入、切窗或锁屏会停止输入；切回或解锁不会自动重放结果未知的动作。网站限制仍需通过项目的人工继续流程恢复，换模式不清除限制。

## 卸载

```sh
node native/cbg-access/install.mjs --uninstall
```

只移除本宿主的注册和可执行文件。Chrome 配置、登录数据、采集证据、数据库及风险状态均保留；扩展可在 Chrome 扩展管理页移除。

## 验证与限制

```sh
clang -fobjc-arc -fblocks native/cbg-access/Input.m -o /private/tmp/cbg-input-check \
  -framework Cocoa -framework ApplicationServices -framework IOKit
/private/tmp/cbg-input-check --self-test
```

自检不投递输入。模拟页面测试、协议故障测试与原生编译记录在代码测试中；真实权限授予、AX 在不同 Chrome/macOS 版本的可用性和实际 OS 输入仍须在隔离环境验证。缺少可独立核验的 AX 目标、原生入口、范围、坐标或动作结果时明确返回不支持/未知，并保留进度。

扩展只接受本地有限语义计划，不提供任意脚本、系统命令、下单或支付。MAIN 的旁路数据不能指定最终点击坐标；ISOLATED 重新解析目标，原生端再核验内容区、AX 语义和屏幕坐标。网页 DOM 本身仍受网页控制，这不构成对被完全篡改网站的防御保证。
