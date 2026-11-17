# 原生活动工作流与输入授权

活动授权归属于工作流，绑定、静态观察和空闲状态不申请；表单操作、输入后页面等待和受控恢复的页面核验期间保留授权租约。用户已取消任务执行和等待期间的自动防休眠，当前实现不创建 IOPM 断言，也不使用电源状态确认输入授权。

每项活动携带 activityId、单调递增的授权代次、stopEpoch、浏览器会话及有效期。输入前必须收到输入 helper 对当前活动返回的成功 ACK，严格核对 `active:true` 和同一 activityId；只有宿主收到请求仍不算成功。`status.activity.active` 表示活动授权仍有效，结束 ACK 为 `active:false`，结束后的租约为空。每次输入还要在 host 与 helper 检查当前活动身份及授权。

活动租约有效期为 15 秒，服务每 3 秒续期。另有 3 分钟无已验证业务进展截止时间；单纯心跳不能延长，只能用本活动中新完成的动作确认一次进展。该边界允许正常共享预算排队和页面等待，同时限制事件循环仍工作、但任务 Promise 卡死的情况。服务事件循环卡死则因 15 秒续期中断失效。

host 每 100 毫秒独立检查租约；helper 用包含系统睡眠时间的单调时钟，每 100 毫秒检查活动有效期、锁屏、输入监控、权限、前台、用户抢占及目标显示器可用性。失效会停止输入并撤销授权。取消、暂停、结束、宿主/服务断连同样撤销；活动结束失败或任一续期失败停止输入，旧活动的迟到清理/失效通知不能结束新活动。

所有续期共用串行队列，防止旧心跳在业务进展确认后倒写授权。输出 JSON 行由整体 stdout 互斥锁保护，避免 helper 看门狗与主线程输出交错。宿主安装清单同时包含新的活动授权模块。

## 历史版本与验证边界

第 1 步提交以 PR #77 的 `cae2249` 为基线，当时曾要求活动持有防休眠断言。该要求现已取消；旧 IOPM/power 收证及旧版 `awake` 字段仅作为历史记录保留，不代表当前规范或新版本通过结果。

- 纯 Node/SQLite、真实 runtime 与受控 host IO 核对活动申请失败不输入、页面等待续约、进展边界、结束/取消/断连/过期撤销、旧授权/旧 ACK 拒绝和迟到事件隔离。
- 系统 clang 编译与 `--self-test` 在 OS 输入和权限监听启动前退出；实际检查数量以当前自检输出为准，旧提交记录的 26 项不作为当前计数。
- 实际扩展安装、Native Messaging、TCC/AX、锁屏、抢占、宿主重启及显示器行为分别按实机结果记录；纯测试和编译不代表实机通过。锁屏本轮由用户延期，第二屏没有硬件，详见[故障场景](./native-os-fault-scenarios.md)与[OS 复现说明](./native-os-integration.md)。

```sh
vp test server/adapters/native-activity.test.ts server/adapters/native-host-activity.test.ts server/adapters/native-workflow.test.ts server/adapters/extension-native.test.ts server/adapters/native-navigation-health.test.ts server/adapters/native-query-correlation.test.ts server/adapters/native-install.test.ts --run
clang -fobjc-arc -fblocks native/cbg-access/Input.m -o /private/tmp/cbg-six-input-check -framework Cocoa -framework ApplicationServices
/private/tmp/cbg-six-input-check --self-test
```
