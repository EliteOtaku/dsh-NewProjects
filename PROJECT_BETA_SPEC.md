# Claude Projects (Beta) for DSH — 核心架构与功能规范

> **实现状态与差距**：本文是**目标规范**，不是实现清单。逐项实现状态、未完成部分、已知缺陷与有意为之的边界，全部登记在 [`docs/GAPS.md`](docs/GAPS.md)，按批次推进。改动本文件前先读那份登记簿——那里的条目都带代码证据与验收标准。

## 1. 核心目标

在 DeepSeek Harness (Cordis 架构) 中复刻 Claude Code 全新版 **Projects (Beta)**，将交互模式从“与 AI 对话”升级为“向 AI 交代工作”的动态协调代理。

## 2. 五大核心模块规范

### 模块 A：Coordinator 协调者引擎（目标拆解与调度）

- **职责**：用户在单一对话框中描述高层目标后，Coordinator 自动分析仓库现状，将复杂工程任务拆解为多个互不阻塞的子任务，并调度并行的工作线程（Threads）执行。
- **配额护栏**：内置项目级线程计数器，默认限制单个用户每天在所有项目中最多新建 **200 个线程**，支持配额预警与并发度控制。
  - *实现注记（2026-10）*：**当前为每项目独立计数，未做到"跨项目"**。见 `docs/GAPS.md` 的 `GAP-01`。
  - *关于并发度控制*：`OFFICIAL` 原文说明并发数只是「偏好而非硬上限」，真正强制的只有每天 200 个（跨项目）。因此并发度控制不是规格偏离，见 `docs/GAPS.md` 的「已修正的错误判断」。

### 模块 B：Parallel Threads（基于 Git 分支隔离与持久化子会话）

- **独立分支工作**：依托当前工作区已关联的 GitHub 仓库，每个 Thread 启动时通过 Git 分支或 `git worktree` 创建独立工作分支，确保多个并行线程修改代码互不污染。
- **后台持久化运行**：基于 DSH 的 `ctx.subagents` 与事件溯源会话（Session Log）机制，每个 Thread 作为独立的后台子会话持久化运行；即使前端断开或挂起，线程状态与执行日志依然在后台持续推进并支持随时恢复。

### 模块 C：Shared Memory（跨线程共享记忆库）

- **全局决策同步**：维护项目级持久化共享记忆存储（含 CAS 版本号 `revision`）。当用户向 Coordinator 交代全局决策、规则或背景信息（例如“发布日改到周五”或架构约束变更）时，写入共享记忆库。
- **零重复交代**：所有当前正在运行的并行线程（通过 Turn 边界上下文注入）以及未来新建的线程（通过启动前缀装配），均自动获取最新共享记忆，无需人工逐个线程重复同步。
- **KV Cache 优化**：固定共享记忆在 System Prompt 中的挂载槽位，利用 DeepSeek-V4.1-Flash 的高压缩 KV Cache 实现跨轮次前缀高命中率。

### 模块 D：Auto-Execution & Self-Healing（自主执行、PR 与 CI 自动修复）

- **全流程自主闭环**：每个工作线程具备在各自分支上自主运行测试、提交 Commit 以及通过 GitHub CLI (`gh`) / API 创建拉取请求（PR）的能力。
- **CI 与 Code Review 自愈监控**：注册状态轮询与事件触发钩子——当检测到分支测试/CI 失败，或收到 GitHub PR 代码审查意见（Review Comments）时，自动唤醒对应 Thread 拉取报错日志或审查意见，执行代码修复并推送更新；仅在遇到需人类拍板的重大分歧时将线程状态标记为 `needs_feedback`。

### 模块 E：Overview Panel（集中总览面板）

- **集中状态视图**：基于 DSH 的 `ctx.projection` 与 `/project` 命令平面，提供一目了然的全局监控面板，实时聚合展示：
  1. ✅ **已完成任务（Completed）**：已通过测试并完成合并或交付的线程。
  2. 🔍 **待审核 PR（Awaiting Review）**：已创建 PR、CI 绿灯、等待人类审核的线程及 PR 链接。
  3. 💬 **等待反馈（Waiting for Feedback）**：遇到阻塞或架构抉择、正在等待用户反馈的具体线程与问题摘要。
  4. ⚡ **运行中/自愈中（Running / CI Fixing）**：正在后台并行编码或自动修复 CI 的活跃线程及当日配额消耗（X / 200）。

> *实现注记（2026-10）*：
> - `ctx.projection` **尚未接入**，目前只有 `project_overview` 工具与 `/project` 命令两种主动拉取表面。见 `GAP-03`。
> - 官方的 Overview 有**六个分组**（Ready for review / Waiting on you / Working / **Landing** / **Idle** / **Resolved**），本文档只列了四类。缺的三个语义见 `GAP-04`，一周无活动自动归档见 `GAP-05`。

## 3. 暴露接口要求

1. **模型工具（`ctx.tools`）**：
   - `project_coordinate`：拆解目标并批量拉起绑定独立 Git 分支的并行 Threads。
   - `project_memory_sync`：读写跨线程共享记忆库（实时广播至所有活跃与未来线程）。
   - `project_thread_manage`：查询、干预（Steer）、唤醒指定线程处理 CI 失败或 PR 审查意见。
   - `project_overview`：获取当前项目所有线程、PR 状态与待反馈事项的结构化总览。
2. **用户命令与热加载**：
   - 注册 `/project` 系列命令以查看 Overview 面板、追加全局记忆及管理线程。
   - 所有副作用通过 Cordis 的可逆机制注册，确保在 Creator Mode 中支持无残留热重载。