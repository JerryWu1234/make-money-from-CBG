# CBG 扩展与 macOS 输入宿主

这条实验通路由限域 MV3 扩展、Chrome Native Messaging、当前服务的 Unix socket 和原生 AX/Quartz 输入组成。读取、等待、目标定位和证据均不连接 CDP；业务资料仍走项目原有身份、完整性及数据库事务门槛。

## 安装

1. 在准备使用的固定 Chrome 配置中打开 `chrome://extensions`，启用开发者模式，点击“加载未打包的扩展程序”（部分版本称“加载已解压的扩展”），选择仓库的 `extension/cbg-access/` 文件夹。记录扩展卡片上的 32 位 ID；“打包扩展程序”生成的 `.pem` 文件不是 ID，无需打包。
2. 在仓库中执行：

   ```sh
   node native/cbg-access/install.mjs 扩展ID "$PWD/data/cbg-access.sock"
   ```

   安装器使用系统 clang 构建 Objective-C 宿主，将程序放入当前用户的 `~/Library/Application Support/CBGAccess/`，并注册固定扩展 ID 的 Native Messaging 允许名单。不会修改浏览器配置或访问官网。

3. 在 macOS 系统设置中为实际宿主启动链的 TCC 责任程序授予辅助功能及输入监控权限。责任程序取决于启动方式，不能用终端直接运行 `cbg-input` 的权限代替 Chrome 扩展链的检查；本轮实机记录的责任身份是安装入口使用的 Node 可执行文件。可先核对安装目录 `launch-host` 固定的 Node 路径，再以真实宿主 `status` 和 TCC 归属为准。宿主只检查授权，不循环弹窗。读取 AX/DOM 证据不需要屏幕录制；状态接口另行报告屏幕录制权限。
4. 服务中选择“扩展与 macOS 输入”。安装扩展后，在官网角色页面用浏览器的整页刷新（macOS 为 `⌘R`）加载内容脚本，列表内部的数据刷新不能替代这一步。在官网完成登录和角色查询，确认当前页显示商品列表后，单击一次“CBG 本地只读采集桥”绑定当前标签页。首页、角色搜索表单和本地助手页不能充当已查询的商品列表。再次点击扩展会立即停止输入。

原生输入只在已绑定标签页、Chrome 前台窗口、解锁会话和有效访问许可下执行。用户鼠标/键盘输入、切窗或锁屏会停止输入；切回或解锁不会自动重放结果未知的动作。处理当前页面的登录或验证后，通过助手的普通重试入口核验恢复；换模式不清除访问限制和冷却。

## 卸载

```sh
node native/cbg-access/install.mjs --uninstall
```

只移除本宿主的注册和可执行文件。Chrome 配置、登录数据、采集证据、数据库及风险状态均保留；扩展可在 Chrome 扩展管理页移除。

## 验证与限制

```sh
clang -fobjc-arc -fblocks native/cbg-access/Input.m -o /private/tmp/cbg-input-check \
  -framework Cocoa -framework ApplicationServices
/private/tmp/cbg-input-check --self-test
```

自检不投递输入。模拟页面测试、协议故障测试与原生编译记录在代码测试中；真实权限授予、AX 在不同 Chrome/macOS 版本的可用性和实际 OS 输入仍须在隔离环境验证。缺少可独立核验的 AX 目标、原生入口、范围、坐标或动作结果时明确返回不支持/未知，并保留进度。

实机记录及可复现的隔离脚本见[交付记录](../../docs/cbg-pr77-six-step-delivery.md)与[原生故障场景](../../docs/native-os-fault-scenarios.md)。正常helper已按当前display mode的物理/逻辑维度校验Retina倍率，非0屏幕旋转明确拒绝；读取Chrome应用级AXRole完成标准只读握手，再严格核对唯一页面URL和实际命中。用户已取消任务执行及等待期间的自动防休眠，不再申请系统防休眠断言；活动状态与ACK使用`active`表示有效输入授权。用户抢占、权限/显示器变化、活动过期、停止、取消或断连仍会撤销授权。历史IOPM/pmset实机记录保留为旧需求证据，不能作为当前验收要求。原始抢占元数据仅作诊断，不据来源PID、零位移或时间早晚豁免事件。

默认输入路径在原proof的1500ms有效期内，为AX应用角色、原focused window及完整URL树扫描设置最多700ms的结果接受预算；只有完整扫描的目标URL零命中允许只读重采样。多匹配、读取失败或树预算截断立即拒绝；每次读取前后检查原活动、授权代次、停止/抢占、目标PID、前台和原窗口，每个实际读取的AX对象均设置不超过剩余预算的消息超时。成功后使用该次新树继续原坐标、命中及语义检查，不写AX属性、不重取proof、不重派动作或延长TTL。700ms不是硬实时中断保证：系统调用或调度可能滞后，超时返回的读取结果仍拒绝。纯回归覆盖这条生产读取状态机；本轮已以全新进程、无`--ax-preflight`和无外部AX诊断通过默认AX路径的basic原断言，范围限已授权和明确前台start gate；不能断言实机实际发生零到一重采样、无需等待的无人值守启动或异步延迟就是根因。当前basic、独立helper过期及等待期断连/重启的证据见[补充验收](../../docs/native-followup-acceptance-2026-11-17.md)。

活动watchdog已判定租约过期时，先通过原lease身份保护撤销授权，再结束该轮检查；未过期才查询桌面/显示器条件。纯回归验证该顺序及旧检查不能撤销新lease。这是代码顺序风险修复，不证明此前RV6KYg确实阻塞于WindowServer，也不将其独立helper过期验收改记为通过。

扩展只接受本地有限语义计划，不提供任意脚本、系统命令、下单或支付。MAIN 的旁路数据不能指定最终点击坐标；ISOLATED 重新解析目标，原生端再核验内容区、AX 语义和屏幕坐标。网页 DOM 本身仍受网页控制，这不构成对被完全篡改网站的防御保证。
