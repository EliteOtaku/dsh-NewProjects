# dsh-newprojects

Claude Code **Projects (Beta)** 式的动态协作中枢，作为 DeepSeek Harness 插件运行。

把一个高层目标拆成互不阻塞的子任务，每个子任务交给一个**独立 git worktree 上的后台线程**去干；
线程跨轮次持续运行、跨线程共享同一份项目决策记忆、CI 失败或 PR 收到审查意见时自动唤醒修复。

> **复刻的是什么**：**Code Projects 这个功能本身**（概念、行为、状态语义、交互契约），规格来源是 [code.claude.com/docs/en/claude-projects](https://code.claude.com/docs/en/claude-projects)（[`.md` 版](https://code.claude.com/docs/en/claude-projects.md)）。
> **不是**重建云产品：不做云端沙箱、GitHub App、账号 connectors、cloud environment、跨设备续跑。
> 云端 sandbox 换成本地 git worktree、云端持久化会话换成 DSH 子会话、GitHub App 换成 `gh` CLI —— 这些差异是**载体差异，不是功能缺口**。
> 判断「缺不缺」看的是**用户能不能做到这件事**，不是云端用哪个载体做的。详见 [`docs/GAPS.md`](docs/GAPS.md) 的「复刻的是什么，不是什么」。
>
> 宿主能力以 **DSH 源码**为准：[github.com/deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。

```
                 ┌──────────── 共享记忆（.dsh-project/manifest.json）────────────┐
                 │  跨线程决策 · CAS 写入 · 稳定前缀注入 system prompt              │
                 └───────┬─────────────────────┬─────────────────────┬──────────┘
  /project coordinate ──▶│ coordinator         │                     │
                         ▼                     ▼                     ▼
                   thread A (worktree 1) thread B (worktree 2) thread C (worktree 3)
                         │                     │                     │
                    push + PR            push + PR              push + PR
                         ▼                     ▼                     ▼
                    ┌────────── /project heal：CI 失败 / Review 评论 → 唤醒对应线程 ──────┐
```

## 五块能力

| 能力 | 实现 |
| --- | --- |
| **Coordinator + 并行 Threads** | `project_coordinate` 工具拆解目标，每个任务一个 `subagents` 子会话 + 独立 `git branch` + 私有 worktree。每日配额默认 200，全有或全无地预留，启动失败自动退还。（**配额目前按项目独立计数，未做到跨项目合计**——见 [`docs/GAPS.md`](docs/GAPS.md) 的 `GAP-01`。**拆解目前是确定性 bullet 分析，未用模型**——见 `GAP-26`。） |
| **跨线程共享记忆** | `project_memory_sync` 写入决策后广播到所有**正在运行**的线程；新线程启动前缀自动带上全量记忆。记忆渲染成字节稳定的 system prompt 段，命中 provider 端 prefix cache。 |
| **项目知识（挂载式）** | 绑定文件或目录后，charter 渲染**清单**让线程自己读（对照官方的 `/mnt/project-files` 挂载模型）；另提供 BM25 检索与目录树/精确读取作为便利工具。**不是 RAG 模式切换**——那是 chat Projects 的机制，Code Projects 没有。 |
| **自动执行与 CI/PR 自愈** | 线程自己跑测试、commit、push、开 PR。`/project heal` 与后台巡检读 `gh pr checks` / review comments，判定 `heal` / `wait` / `escalate` / `transition`。 |
| **Overview 面板** | `project_overview` 工具与 `/project` 命令输出状态桶 + 当日配额 + 知识状态。**尚未接入会话投影**，面板不会随会话事件自动刷新——见 [`docs/GAPS.md`](docs/GAPS.md) 的 `GAP-03`。**桶目前是五类，官方是六组**——见 `GAP-04`。 |

## 安装

本插件是 Host-only bundle，`lib/` 已随仓库提交，因此从 git 安装时无需构建步骤：

```bash
# 在 DeepSeek Harness 里（<本仓库绝对路径> 即包目录）
plugin_manager install_bundle <本仓库绝对路径>
```

装完重载 profile，`/project` 命令与六个 `project_*` 工具即可用。

开发时也可以用目录联接把 checkout 直接挂进 profile（改完 `npm run build` 即生效）：

```powershell
cmd /c mklink /J "$env:USERPROFILE\.dsh\profiles\<profile>\node_modules\dsh-newprojects" "D:\AI\dsh-NewProjects"
```

## 使用

```
/project                      # 总览：状态桶 + 当日配额
/project init [name]          # 为当前工作区建项目记录
/project memory               # 列出共享决策
/project memory stack = TypeScript on Node   # 写一条决策并广播
/project memory rm stack      # 删一条
/project threads              # 所有线程及其状态
/project thread <id> steer|respond|retry|interrupt|close|deliver [text]
/project heal                 # 手动跑一次 CI/PR 巡检
/project coordinate <goal>    # 拆解并启动线程（确定性；批量场景优先用工具）
/project knowledge            # 知识层状态：文档数、字符数、绑定路径
/project knowledge add <path> [path...]   # 绑定文件或目录
/project knowledge rm <path>  # 解绑
/project knowledge rebuild    # 重新扫描（改了被绑定的文件之后）
```

模型侧对应六个工具：`project_coordinate`、`project_memory_sync`、
`project_thread_manage`、`project_overview`、`project_knowledge_search`、
`project_knowledge`。

### 项目知识：挂载式，不是 RAG

官方 Code Projects 的知识机制是**把项目文件挂载成文件夹**（`/mnt/project-files`），线程用普通文件工具自己读。
`code.claude.com` 全文里 `RAG`／`retrieval`／`project knowledge` **各出现 0 次**——那套「全文 vs 检索」的二分属于 **claude.ai chat 的旧版 Projects**（无 threads、无 coordinator）。

因此本实现采用 **paths-first**：

- **charter 渲染清单**，线程按需读取；路径锚定项目根，因为线程 cwd 在自己的 worktree 里，那里只有 baseCommit 已提交的文件；
- **导航优先**：`project_knowledge` 的 `tree` / `read` 动作比「一次检索命中」更贴近挂载模型；
- **BM25 检索是便利工具**，索引在查询时按需重建，不是一种「模式」；
- **全文注入是可选优化**，配置 `inlineKnowledgeMaxChars`（默认关闭），低于该值时才注入正文以命中 prefix cache。它是优化，不是机制。

> 原本的实现（阈值常量 + 全文/检索二分 + 陈旧检测）建立在错误的产品前提上，已在 `docs/GAPS.md` 的 `GAP-22` 中撤销。那一轮复核的证据见 `docs/REVIEW-RESPONSE.md`。

检索中文按重叠 bigram 切词（`项目知识` → `项目` / `目知` / `知识`），所以中文查询不需要分词器也能命中。
结果按 `path:起止行` 引用，排序稳定（同分按路径与行号），两次相同查询结果完全一致——否则 prompt 前缀缓存会失效。

### 线程的状态

| 状态 | 含义 | 谁会推进 |
| --- | --- | --- |
| `queued` | 已排队或中断待恢复 | `/project thread <id> retry` |
| `running` | 正在跑 | 线程自身 |
| `ci_fixing` | 收到 CI 失败或被要求改，正在修 | 线程自身（+ 巡检） |
| `awaiting_review` | 已开 PR，等人工评审 | 评审人 / `heal` 的 merged 检测 |
| `needs_feedback` | 需要人拍板（含"跑完了但没交付"） | `/project thread <id> respond <text>` |
| `completed` / `failed` | 收尾 | — |

> 官方的六分组是 `Ready for review` / `Waiting on you` / `Working` / `Landing` / `Idle` / `Resolved`。
> 我方状态与它的对应关系、以及缺的三个（`landing` / `idle` / `resolved`）见 [`docs/GAPS.md`](docs/GAPS.md) 的 `GAP-04` 与 `GAP-05`。
> **分组是状态的投影**，`bucketOf()` 就是那个派生函数——加状态只改它，不需要重构枚举。

## 目录布局

```
src/core/          纯逻辑：manifest / quota / memory / planner / healing / overview / vcs /
                   knowledge（切分·BM25）/ knowledgeSource（唯一碰文件） / engine
src/host/          Host 适配：subprocess 命令行、subagents 线程、tools、commands、类型声明
test/unit/         纯逻辑单测（内存 fake）
test/engine.test.ts 全链路：真实临时目录 + fake git / fake 线程
test/knowledge.test.ts 知识层接入：真实文件、真实索引文件
test/integration/  真实 git 集成：真仓库、真 worktree、真 push（无 git 时自动 skip）
test/commands|tools|index.test.ts  适配层与插件入口
docs/              GAPS.md（差距登记簿）· REVIEW-REQUEST.md · REVIEW-RESPONSE.md（外部复核）
```

共 **261 项测试**（`node:test`）。除集成测试外全部跑在内存 fake 上，不需要 git 或真实子会话。

`src/core/` **不 import 任何 `@deepseek-ai/dsh-*`**：外部插件解析不到 Host 内部包。
Git 与 `gh` 一律经 `CommandRunner` 端口调用，因此 SSH / 容器部署时命令在正确机器上执行。

## 开发

```bash
npm install
npm run verify     # typecheck + build + test
npm test           # 只跑测试
```

## 设计取舍

- **每个线程一个私有 worktree**：只建分支不算隔离——线程仍在父检出里跑，并发时互相看见对方的改动，提交还会落到父会话当前分支上。worktree 建在 `.dsh-project/worktrees/<threadId>`（已 gitignore），父检出永不移动。建不出来时降级为纯 scope 隔离并在状态里说明，而不是假装隔离了。**官方对同一件事的背书**：`claude remote-control --spawn worktree` 就是「每线程一个 worktree」的官方开关。
- **一律走 `CommandRunner` 而非 `node:child_process`**：命令必须落在 Host 所在的机器上，SSH / 容器部署时后者会在错误的主机上执行。
- **一轮结束 ≠ 已交付**：线程收尾消息里没有 PR 链接时进入 `needs_feedback`，而不是给一个声称产物存在的 `completed` 徽章。
- **广播只推正在跑的线程**：给 idle 子会话发消息会新起一轮，把所有已完成线程都唤醒会白烧 token。官方**根本不给运行中线程更新**，所以这条属于超额实现，不是缺口。
- **未知 CI 状态算 `pending`，不算通过**：假绿是自愈器绝不能产生的输出。
- **不可逆动作与它的防护同批**：删 worktree、归档项目这类动作不该排在最后——在它之前每一次操作都在那个风险上。
- **检索工具始终注册，不随状态增删**：项目随时可能变，工具列表来回变会让 provider 的 prompt 缓存失效，且没有任何收益。
- **索引是派生状态**：`.dsh-project/KNOWLEDGE_INDEX.json` 已 gitignore，随时可从绑定的文件重建；坏索引被当作「没有索引」而不是致命错误。
- **`subprocess` 是唯一硬依赖**：其余能力（tools / commands / systemPrompt / timer + subagents）全部走 `ctx.inject` 延迟注册。`ctx.get` 只在激活那一刻采样注册表，晚挂载的服务会永久错过。

## 已知未实现部分

相对官方 Claude Code Projects 还有若干未实现的能力（会话投影、六分组 Overview、模型拆解与建议线程、goal 持久化、Library、PR 聚合、Pause/Archive、全局配额、审批等）与若干有意为之的边界（重启后后台自愈停摆、云端 sandbox 差异等）。

完整清单、代码证据、依据来源与验收标准见 **[docs/GAPS.md](./docs/GAPS.md)**，按批次推进。那份文档是判断「某个能力到底有没有」的唯一依据——不要凭本文件的段落推断。

外部复核的记录见 **[docs/REVIEW-REQUEST.md](./docs/REVIEW-REQUEST.md)**（我方判断与疑问）与 **[docs/REVIEW-RESPONSE.md](./docs/REVIEW-RESPONSE.md)**（Claude 的回执）。

## 许可证

[MIT](./LICENSE)
