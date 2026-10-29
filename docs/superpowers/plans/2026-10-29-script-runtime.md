# Script runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 内置 JS/Python 运行能力并接入搜索、详情、播放。
**Architecture:** Rust 管理校验与调用；QuickJS 执行 JS；CPython worker 执行 Python。来源状态隔离，媒体经回环代理。
**Tech Stack:** Tauri/Rust、rquickjs、CPython、React/TypeScript。
**Spec:** ../specs/2026-10-29-script-runtime-design.md

## Global Constraints
- 用户已授权执行及内置运行时；不替换安装应用，不发布，不改其他网盘与 CSP。
- 保留用户已有修改、存储键、CMS 与夸克契约。
- 未信任脚本不执行；不回退系统 Python；原生和前端生产函数附中文说明。

## Review Focus
- 脚本下载返回 HTML、超大响应与变更摘要必须拒绝。
- JS 无限循环和 Python 无限输出/挂起必须终止。
- 非 HTTP 选集 ID 不得丢弃，历史恢复重新解析。
- 运行时缺失/依赖缺失必须可见，不能计为支持。
- 播放请求头、HLS 相对路径和 Range 需代理验证。

### Task 1: JS 宿主
- [x] 创建 scripts/javascript.rs，提供 execute(bundle, action, args, storage) JSON 接口；宿主请求、模块和状态隔离。
- [x] 在 src-tauri/src/tests/scripts 添加受控 drpy 测试，覆盖异常/时限/模块/网络结果。

### Task 2: Python 宿主与内置分发
- [x] 创建 runtime/python/worker.py、base/spider.py，JSON 协议与真实样本依赖。
- [x] 创建固定版本/摘要校验的运行时准备工具及打包配置，运行受控 Spider 测试。

### Task 3: 原生调度与代理
- [x] scripts/mod.rs 提供 script_status/inspect/trust/search/detail/play，按内容摘要授权，超时和响应限额。
- [x] scripts/media.rs 实现受限随机回环媒体代理、HLS/Range/header 校验。
- [x] 注册原生命令；检查构建缺失资源失败。

### Task 4: 前端
- [x] api/scripts.ts 与 services/scripts.ts 组合请求，资源设置提供状态和明确脚本授权。
- [x] 只允许就绪可信脚本参加搜索；详情保留 ID，选集调用 player；历史保存原始身份。
- [x] 补 frontend/tests 下协议、播放/历史相关测试。

### Task 5: 验证与收尾
- [x] npx vitest run / npm run build / cargo test --lib / cargo check。
- [x] 受控与真实插件验证分开，实际桌面及平台边界单独报告。
- [x] 完成代码审阅并修复有证据的问题，更新开发文档。

执行方式：用户已明确要求开始，按授权直接执行；不提交、不发布。

## 执行记录

- 用户确认内置运行时，并明确授权开始执行；直接在原 checkout 工作，保护全未跟踪的已有项目，不提交、不发布。
- Ruling: 当前采用按调用重新初始化引擎/worker，显式来源存储保持跨调用数据 — 减少进程泄漏与跨来源状态污染 — 依赖实例内存而不使用宿主缓存的插件需要进一步适配。
- Ruling: 用户要求统一改完再测试；停止增量运行/自动重编译，所有剩余修正与静态审阅完成后只做集中验证。
- 已完成原生调度、检查/信任摘要、前端搜索详情与原始选集解析、QuickJS、内置Python准备与worker。代理、取消、历史恢复及夸克分享交接的审阅修正已完成。
- 当前机器Mac锁屏，CUA不能操作窗口；开发进程曾启动，不能据此称实际播放已通过。
- 先前真实Acfun样本执行：search=30，detail=1，player返回parse=0和HTTPS地址；无账号或网盘写操作。真实视频起播尚未验证。

## 集中验证结果（2026-10-29）

全部功能修改完成后集中执行：
- Vitest：17 个文件，113 项通过。
- 前端生产构建：通过，仅有大于 500 kB 的产物提示。
- 内置 Python worker：10 项通过。
- Rust 库测试：32 项通过、9 项默认忽略（含同期 adapter 测试）。
- Cargo check：通过。
- 已审查的真实 drpy2 引擎 + 无网络受控规则：search/detail/play 通过。
- 真实 Acfun Python 样本：搜索 30 项、详情 1 项，player 返回 parse=0 的 HTTPS 地址；未验证实际起播。
- 真实 NyaFun JS 规则：联网搜索失败或超时（15 秒宿主请求上限）；不计为线路可用，也不能仅凭此判定站点失效。

Mac 锁屏导致无法操作 GUI；桌面实际播放、安装包、签名与 Windows 运行仍未验证。未覆盖全部 JS/Python 插件兼容性，未替换已安装应用、未提交或发布。同期其他会话的 adapter 修改予以保留，未作为本任务新增功能归属。
