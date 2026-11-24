# 第 6 步：真实安装的只读 Native Messaging 验收

`scripts/native-installed-integration.mjs` 使用真实 Chrome、实际加载的 MAIN/ISOLATED/MV3 service worker、实际 Native Messaging stdio、当前 host 与正常编译的 Input.m。模拟页面在真实官网 origin 下由 Playwright route 提供，页面其余外部请求被阻止。脚本不注入 chrome.runtime 替身，也不通过 addScriptTag 代替扩展安装。

2026-11-18 更新：当前脚本不再触发工具栏 action，要求打开模拟官网页后自动绑定。样本包含 15 行、超过 90 万字符的原始列表描述，断言每一行的身份与创建/上架/到期时间完整传回，列表帧只省略无消费者的详情描述；详情完整资产仍由详情流程采集。同时发送一次只读 focus，经真实宿主返回 posted=false，未发送 resume/activity/execute。最终记录见[自动连接复核](./reviews/cbg-native-auto-binding-review-2026-11-18.md)。下方 2026-11-15 的手动 action 记录是历史范围。

先准备，不启动 Chrome：

```sh
vp exec node scripts/native-installed-integration.mjs --prepare-only
```

命令构建正常 helper 并运行 34 项无输入自检，生成 `/private/tmp/cbg-installed-*/` 下的临时扩展、host、mode-0600 配置、隔离 profile、注册清单和 plan/result JSON。没有调用正式安装器，没有改变 HOME，没有写入默认 Chrome 或已有 CBGAccess 目录。临时文件保留供检查。

协调浏览器测试空档后执行：

```sh
vp exec node scripts/native-installed-integration.mjs --run
```

**在 Codex 中，这条命令会启动 Chrome，必须以 exec_command 的 require_escalated 审批运行，并与正在运行的 Chrome 回归协调。** 此脚本限定只读，不会授予或模拟权限，也不增加 OS 业务输入。用户没有第二屏；用户随后启用 Input Monitoring，且明确本轮不锁屏。

真实安装依靠 Chrome 内置 `Extensions.loadUnpacked`，连接使用 Playwright 的 debugging pipe 与 `--enable-unsafe-extension-debugging`，不依赖 `--load-extension`。安装后由扩展自己的生命周期事件自动绑定，不调用 `Extensions.triggerAction`。若本机协议拒绝安装，记录 blocked 并停止，不改全局设置。[官方协议](https://chromedevtools.github.io/devtools-protocol/tot/Extensions/)。

当前官方 Native Messaging 文档规定，用户级注册读取所用 user profile 目录下的 `NativeMessagingHosts/`；本脚本只写此次 `--user-data-dir` 中的清单。2026-11-15 已在 Chrome 157.0.8103.79 实装确认此临时路径可用；若其它环境报 host not found，结果包含真实 API 错误和临时注册路径，不回退到默认用户或系统目录。[Chrome Native Messaging 文档](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)。

临时测试副本只允许两个明确差异：manifest 加固定公共 key，得到固定扩展 ID；host 的 configPath 指向临时 host.json。全部扩展脚本和两个 authority 模块原样复制；helper 从实际 Input.m 正常编译，没有测试宏。result.json 保存 host 原始/副本哈希及唯一替换内容。

可执行的验收范围：

- 实际扩展清单注册、实际 MV3 worker，以及 Chrome 自动加载的 MAIN 与 ISOLATED。
- 无工具栏点击的自动绑定和观察快照，以及 15 行大列表身份/时间投影。若 helper 的真实权限拒绝过快导致捕获未保留，明确记为 blocked；不补造快照。
- 临时 profile 的真实 Native Messaging host 启动、Unix socket hello 与 helper 的实际拒绝/权限状态。
- 同一实际扩展再次调用真实 connectNative 后，检查出现新的宿主 PID；这仅证明只读端口终止后的真实重新启动。

本地 socket 测试服务只发 ACK/status，不发 resume、activity 或 execute，不取得任何 OS 输入授权。真实 helper 的 input-monitor-startup-failed 是监控初始化拒绝证据；普通 helper 退出、不可用或超时只记为未确认，不自动归因于 TCC。若环境意外已具备权限，只记录真实 status，仍不输入，也不把它写成“拒绝测试通过”。

仍待独立实机验收：真实 AX 目标与输入、活动输入授权的生命周期、锁屏、显示器不可用、第二屏、用户抢占以及活动输入期间 host restart。`result.json.notRun` 保留这些边界；本脚本的只读安装/连接结果不等于完整第 6 步通过。

结果分别记录 prepared-not-run、passed-read-only-scope、blocked-read-only-scope 或 failed。实装范围内有 blocked 时命令退出码为 2，不能将部分受阻的运行按全通过汇总。

## 已执行的只读实装记录

2026-11-15 的 Chrome 157.0.8103.79 运行结果为 passed-read-only-scope、exit 0：7 项 passed，1 项真实监控初始化拒绝，1 项 OS 业务输入 not-run，没有 blocked。实际临时扩展 ID 为 `fkbbhnajbmfgonkpeibdblgmmnaipolj`。

实际扩展安装、MV3 worker、Chrome 自动加载 MAIN/ISOLATED、真实工具栏 action、临时 profile Native Messaging 注册及只读端口终止后的新宿主进程均已观察。最终原始消息还保留了带实际 fixture 条件、authenticated=true 和 listingCommitted=true 的快照，完整经过 MAIN、ISOLATED、SW、Native Messaging host 与 Unix socket；断连前的首次断言采样来自真实 SW outbox。

宿主实际启动 PID 依次为 27241、27244、27248；第二次只读 probe 在第一次端口终止后新增 PID 27248。三个实例均通过真实 Chrome Native Messaging 启动，并产生 Unix socket host-hello；这项证据仅覆盖只读重新启动。

正常生产 helper 三次返回 input-monitor-startup-failed。此结果说明真实监控初始化被拒绝，没有取得进一步执行输入的条件；没有返回权限对象，也没有执行输入。锁屏、显示器、AX、用户抢占与活动输入期间 host restart 仍在 notRun 中。

上述记录保留当次结果。用户随后启用监控，沙箱外重新运行正常helper的只读status，实际返回input-ready，Accessibility、InputMonitoring、inputMonitorActive、ScreenRecording和显示器均可用、未锁屏；空闲awake=0、assertionId=0且lease为空。预检没有发送activity或execute。相同helper在受限沙箱内仍报启动失败，因此不能再用沙箱内结果推断当前TCC拒绝。该预检仍不证明AX目标、实际输入或活动期间防休眠通过。

后续在实际Chrome→NativeMessaging→host→helper链进行预检时，输入监控已可用，但Accessibility仍false；TCC归属为实际负责的managed Node26.13.1，与Codex直接启动helper的权限结果不同。用户授权后新进程仍未通过，未继续发送输入。四轮尝试与未验范围见[真实OS验收记录](./native-os-integration.md)，不能将本页历史只读范围当作真实输入已通过。

该次运行保留了真实 Chrome 扩展管理页和明确标注“隔离模拟页”的实际截图。临时 Chrome 上下文关闭已成功完成。首次脚本运行曾因传入 page target 而被 Extensions.triggerAction 拒绝；改用显式发现的 tab target 后重跑通过，首次失败目录保留供审计。

## 当前防休眠范围

2026-11-16用户明确取消自动防休眠，由用户保持电脑唤醒。当前实现不创建 IOPM 断言，活动状态以 `active` 表示输入授权；本页旧 `awake/assertionId` 预检保留为历史实测，不是当前要求。锁屏、显示器、权限、活动过期和用户抢占仍独立检查。
