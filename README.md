# dsh-project-beta

Claude Code **Projects (Beta)** 式的动态协作中枢，作为 DeepSeek Harness 插件运行。

把一个高层目标拆成互不阻塞的子任务，每个子任务交给一个**独立 git 分支上的后台线程**去干；
线程跨轮次持续运行、跨线程共享同一份项目决策记忆、CI 失败或 PR 收到审查意见时自动唤醒修复。

```
                 ┌──────────── 共享记忆（.dsh-project/manifest.json）────────────┐
                 │  跨线程决策 · CAS 写入 · 稳定前缀注入 system prompt              │
                 └───────┬─────────────────────┬─────────────────────┬──────────┘
  /project coordinate ──▶│ coordinator         │                     │
                         ▼                     ▼                     ▼
                   thread A (branch 1)   thread B (branch 2)   thread C (branch 3)
                         │                     │                     │
                    push + PR            push + PR              push + PR
                         ▼                     ▼                     ▼
                    ┌────────── /project heal：CI 失败 / Review 评论 → 唤醒对应线程 ──────┐
```

## 四块能力

| 能力 | 实现 |
| --- | --- |
| **Coordinator + 并行 Threads** | `project_coordinate` 工具把目标按 bullet 确定性拆解（不调模型），每个任务一个 `subagents` 子会话 + 独立 `git branch`。每日配额默认 200，全有或全无地预留，启动失败自动退还。 |
| **跨线程共享记忆** | `project_memory_sync` 写入决策后广播到所有**正在运行**的线程；新线程启动前缀自动带上全量记忆。记忆渲染成字节稳定的 system prompt 段，命中 provider 端 prefix cache。 |
| **自动执行与 CI/PR 自愈** | 线程自己跑测试、commit、push、开 PR。`/project heal` 与后台巡检读 `gh pr checks` / review comments，判定 `heal` / `wait` / `escalate` / `transition`，最多自动修 3 轮。 |
| **Overview 面板** | `project_overview` 工具与 `/project` 命令输出四类状态桶（完成 / 待审 PR / 等反馈 / 运行中）+ 当日配额；Host-only 会话投影保持面板随会话事件更新。 |

## 安装

本插件是 Host-only bundle，`lib/` 已随仓库提交，因此从 git 安装时无需构建步骤：

```bash
# 在 DeepSeek Harness 里（<本仓库绝对路径> 即包目录）
plugin_manager install_bundle <本仓库绝对路径>
```

装完重载 profile，`/project` 命令与四个 `project_*` 工具即可用。

开发时也可以用目录联接把 checkout 直接挂进 profile（改完 `npm run build` 即生效）：

```powershell
cmd /c mklink /J "$env:USERPROFILE\.dsh\profiles\<profile>\node_modules\dsh-project-beta" "D:\AI\dsh-NewProjects"
```

## 使用

```
/project                      # 总览：四类状态 + 当日配额
/project init [name]          # 为当前工作区建项目记录
/project memory               # 列出共享决策
/project memory stack = TypeScript on Node   # 写一条决策并广播
/project memory rm stack      # 删一条
/project threads              # 所有线程及其状态
/project thread <id> steer|respond|retry|interrupt|close|deliver [text]
/project heal                 # 手动跑一次 CI/PR 巡检
/project coordinate <goal>    # 拆解并启动线程（确定性；批量场景优先用工具）
```

模型侧对应四个工具：`project_coordinate`、`project_memory_sync`、
`project_thread_manage`、`project_overview`。

### 线程的六种状态

| 状态 | 含义 | 谁会推进 |
| --- | --- | --- |
| `queued` | 已排队或中断待恢复 | `/project thread <id> retry` |
| `running` | 正在跑 | 线程自身 |
| `ci_fixing` | 收到 CI 失败或被要求改，正在修 | 线程自身（+ 巡检） |
| `awaiting_review` | 已开 PR，等人工评审 | 评审人 / `heal` 的 merged 检测 |
| `needs_feedback` | 需要人拍板（含"跑完了但没交付"） | `/project thread <id> respond <text>` |
| `completed` / `failed` | 收尾 | — |

## 目录布局

```
src/core/          纯逻辑：manifest / quota / memory / planner / healing / overview / vcs / engine
src/host/          Host 适配：subprocess 命令行、subagents 线程、tools、commands、类型声明
test/unit/         纯逻辑单测（内存 fake）
test/engine.test.ts 全链路：真实临时目录 + fake git / fake 线程
test/integration/  真实 git 集成：真仓库、真 worktree、真 push（无 git 时自动 skip）
test/commands|tools|index.test.ts  适配层与插件入口
```

共 **198 项测试**（`node:test`）。除集成测试外全部跑在内存 fake 上，不需要 git 或真实子会话。

`src/core/` **不 import 任何 `@deepseek-ai/dsh-*`**：外部插件解析不到 Host 内部包。
Git 与 `gh` 一律经 `CommandRunner` 端口调用，因此 SSH / 容器部署时命令在正确机器上执行。

## 开发

```bash
npm install
npm run verify     # typecheck + build + test
npm test           # 只跑测试
```

## 设计取舍

- **拆解不调模型**：`planTasks` 是确定性文本分析。协调必须在委派模型不可用时仍能工作，必须可单测，且不得凭空发明用户没要求的工作。
- **默认只建分支、不建 worktree**：`worktrees.create` 会把父会话当前目录切走，属副作用。私有 checkout 只在明确需要时创建。
- **一轮结束 ≠ 已交付**：线程收尾消息里没有 PR 链接时进入 `needs_feedback`，而不是给一个声称产物存在的 `completed` 徽章。
- **广播只推正在跑的线程**：给 idle 子会话发消息会新起一轮，把所有已完成线程都唤醒会白烧 token。
- **未知 CI 状态算 `pending`，不算通过**：假绿是自愈器绝不能产生的输出。

## 许可证

[MIT](./LICENSE)
