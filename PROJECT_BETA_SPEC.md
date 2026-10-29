# Claude Projects (Beta) for DSH — 核心架构与功能规范

> **实现状态与差距**：本文是**目标规范**，不是实现清单。逐项实现状态、未完成部分、已知缺陷与有意为之的边界，全部登记在 [`docs/GAPS.md`](docs/GAPS.md)，按批次推进。改动本文件前先读那份登记簿——那里的条目都带代码证据与验收标准。
>
> **功能语义以官方文档为准**：本文写于官方文档细化之前，与 <https://code.claude.com/docs/en/claude-projects> 冲突时以官方为准。具体做法见 `docs/GAPS.md` 的「依据来源」。
>
> 原文逐节对照见 `docs/REVIEW-REQUEST.md` 开头的对照表。

## 0. 复刻边界（先读这一段）

| | 内容 |
| --- | --- |
| **复刻对象** | **Claude Code 新版 Projects (Beta) 这个功能本身** —— 它的概念、行为、状态语义与交互契约。 |
| **规格来源** | <https://code.claude.com/docs/en/claude-projects>（[`.md` 版](https://code.claude.com/docs/en/claude-projects.md)，唯一）。`support.claude.com` 的 RAG 专文讲的是**另一个产品**（claude.ai chat 的旧版 Projects，无 threads 无 coordinator），**不构成本项目规格**。 |
| **交付形态** | **DSH 本地插件**。跑在用户真机、真仓库，构建在 DSH 宿主的 `subagents` / `worktrees` / `tools` / `commands` 之上。 |
| **不是** | 不是重建 Anthropic 的云产品 —— 不做云端沙箱、GitHub App、账号 connectors、cloud environment、跨设备续跑。 |
| **载体替换** | 云端 sandbox → 本地 git worktree；云端持久化会话 → DSH 子会话 + 事件溯源 Session Log；GitHub App → `gh` CLI。这些差异记在 `docs/GAPS.md` 的 `ARCH` 段，**不是缺陷、不排期**。 |

判断一项「缺不缺」时看的是**功能语义有没有**（用户能不能做到这件事），不是**云端的实现载体有没有**。凡是「官方用 A 载体实现 X，我们用 B 载体实现了 X」的，不算差距。

## 1. 核心目标

在 DeepSeek Harness (Cordis 架构) 中复刻 Claude Code 新版 **Projects (Beta)**，将交互模式从“与 AI 对话”升级为“向 AI 交代工作”的动态协调代理。

## 2. 五大核心模块规范

### 模块 A：Coordinator 协调者引擎（目标拆解与调度）

- **职责**：用户在单一对话框中描述高层目标后，Coordinator 自动分析仓库现状，将复杂工程任务拆解为多个互不阻塞的子任务，并调度并行的工作线程（Threads）执行。
- **拆解质量优先于确定性**：官方明写「Claude acts as coordinator. It takes what you send, **decides** what becomes a thread」，且「Sometimes Claude **proposes** threads instead of starting them」。因此拆解**应以委派模型为主路径**，确定性文本分析降级为**可见的** fallback（不可用时必须告知用户「我按 bullet 切了几项」）。静默降级的拆解与静默过期的知识是同一类错误。
  - *实现注记（2026-10-29）*：主路径**不是**在工具内部再调一次模型。DSH 里协调者本身就是那个模型（根会话在调用 `project_coordinate`），工具内嵌套委派会多花一次 token、多一层失败点，且看不到用户在对话里刚说的话。落法是计划**从参数进来**（`tasks: [{title, objective, scopeHint?}]`），工具只做校验与截断；拿不到才降级为正则兜底，并在结果里带 `planOrigin: 'fallback'` 与 `planNote`。
- **先提议后启动**：新增线程默认可以只产出 `Suggested threads` 列表供人确认，而不是直接拉起。这是拆解质量的保险——把「拆错」的代价从「开错 5 个 worktree + 5 个分支」降到「删掉列表里 3 行」。
  - *实现注记（2026-10-29）*：默认值 = 「模型给的计划直接起（那是决定）、猜出来的计划先提议（那是猜测）」。计划存 `manifest.plan`，一份，24 小时过期；`/project start [序号...]` 启动、`/project drop` 丢弃；启动失败的任务留在计划里可重试，同时退还两处配额预约。
- **配额护栏**：默认限制单个用户每天**在所有项目中**最多新建 **200 个线程**。
  - *实现注记（2026-10）*：**当前为每项目独立计数，未做到"跨项目"**。见 `docs/GAPS.md` 的 `GAP-01`。
- **并发度**：官方原文「There's no fixed number; Claude starts as many as the work calls for, and a limit you ask for is a **preference rather than a cap**」——并发数**本来就不是硬上限**，不设硬闸是符合规格的。但官方的「偏好」会被**持久化进记忆并由模型遵守**，所以我们应让并发偏好「可表达、可持久化、可被协调者读到」，见 `GAP-28`。
  - *实现注记（2026-10-30，`GAP-28` 关闭）*：偏好存在 manifest 字段 `maxConcurrentThreads`（不是记忆键——它要参与「这一轮起几个」的算术），由 `/project concurrent <n>` 写。**每轮至少起一个**：偏好已满时起 0 个就等于把它变成硬闸，而官方明说这不是 cap。`coordinate` 的 `limit` 只能收窄不能放宽偏好；`active` 从线程状态现算而不维护计数器。面板在配额行之后显示 `concurrency: up to N at a time (preference, not a cap)`。

### 模块 B：Parallel Threads（基于 Git 隔离与持久化子会话）

- **独立工作区**：每个 Thread 启动时创建**独立的 `git worktree` + 独立分支**，确保多个并行线程修改代码互不污染。
  - *实现注记（2026-10）*：**只建分支不算隔离**。线程仍在父检出里跑，并发时会互相看见未提交改动，交付时的提交会落到父会话当前分支。已改为默认建 worktree（`prepareIsolation` 传 `worktreePath`），worktree 路径为 `.dsh-project/worktrees/<threadId>`。
  - 官方对同一件事的背书：官方支持本地线程，且 `claude remote-control --spawn worktree` 就是「每线程一个 worktree」的官方开关。
- **后台持久化运行**：基于 DSH 的 `ctx.subagents` 与事件溯源会话（Session Log）机制，每个 Thread 作为独立的后台子会话持久化运行；即使前端断开或挂起，线程状态与执行日志依然在后台持续推进并支持随时恢复。
  - 边界：宿主进程不在就不推进（`docs/GAPS.md` 的 `BOUND-1`）。这不是缺陷，是本地架构的固有属性。

### 模块 C：Shared Memory（跨线程共享记忆库）

- **全局决策同步**：维护项目级持久化共享记忆存储（含 CAS 版本号 `revision`）。当用户向 Coordinator 交代全局决策、规则或背景信息（例如“发布日改到周五”或架构约束变更）时，写入共享记忆库。
- **零重复交代**：未来新建的线程通过**启动前缀装配**获取最新共享记忆；正在运行的 `busy` 线程通过 steer 感知增量。
  - *实现注记（2026-10-29，`GAP-06` / `GAP-09` / `GAP-29`）*：共享前缀里有三样东西，按顺序渲染——**项目 goal**（一行，来自 Project settings 的等价物 `/project goal`）、**仓库约定**（仓库根的 `CLAUDE.md`、`.claude/CLAUDE.md`、`.claude/rules/*.md`，只读根，官方明确 `.claude/settings.json` 的权限规则不生效）、以及记忆快照。三者都是 standing text，都会进入**同一个稳定前缀**，所以任一处变化都必须同时推进 `prefixVersion`。
  - *为什么近期消息不进前缀*：协调者的「最近几轮说了什么」属于 `GAP-29` 的三件套，只给协调者视角（`/project goal`、`project_overview`），因为消息每轮都变；放进共享前缀等于每轮把 provider 的缓存全部作废。
  - *实现注记（2026-10）*：官方**不给运行中的线程任何更新**（「Changes to instructions, repositories, plugins, and environment in Project settings reach new threads, **not threads already running**」）。所以给运行中线程广播属于**超额实现**，不是缺口；只推 `busy`、不推 `idle`（省 token）的取舍不变。见 `docs/GAPS.md` 的 `BOUND-2`。
- **KV Cache 优化（我们的取舍，不是官方基线）**：把共享记忆固定挂在 System Prompt 的槽位里，以复用 provider 端的 prefix cache。**前缀必须字节稳定**——不含时间戳、线程 id、计数器，按 key 排序。
  - *措辞校正（2026-10-29）*：最初把这一条写成「对上官方」，属于取证错误。`OFFICIAL` L22「**Set context once**: every new thread starts with the project's **instructions**」讲的是 instructions，不是 memory；官方的记忆是 paths-first（L291：存成文件，线程启动时读 `MEMORY.md` 索引，需要时再打开其余文件）。我们选择整段留在槽位，是因为记忆是**决策**而不是**文档**——每条都短、每条都该被读到，lazy 读取反而会让线程漏掉约束，且 16,000 字符预算对它绰绰有余。这是取舍，记为 `BOUND-5`。

### 模块 D：Auto-Execution & Self-Healing（自主执行、PR 与 CI 自动修复）

- **全流程自主闭环**：每个工作线程具备在各自分支上自主运行测试、提交 Commit 以及通过 GitHub CLI (`gh`) / API 创建拉取请求（PR）的能力。
- **CI 与 Code Review 自愈监控**：注册状态轮询与事件触发钩子——当检测到分支测试/CI 失败，或收到 GitHub PR 代码审查意见（Review Comments）时，自动唤醒对应 Thread 拉取报错日志或审查意见，执行代码修复并推送更新；仅在遇到需人类拍板的重大分歧时将线程状态标记为 `needs_feedback`。
- **自愈护栏**：
  - **不得为了让检查通过而弱化测试**（禁止删断言、跳过、加 `continue-on-error`）；
  - **不得 `force-push`**（重写他人可能已拉取的历史，不属于「分支上 push 完全可逆」那一类）；
  - **不得修改 CI 配置来让检查通过**——这是自愈线程最省力也最有害的「修法」，必须停下来问人。官方项目指令示范原文：「Don't merge, **force-push**, or **change CI configuration** without asking me in the thread.」见 `GAP-25`。
  - **修复计数的轴是「连续失败」而不是「生命周期总数」**：一个 PR 被多轮评审带来多轮不同意见属正常节奏，不该在第四轮被当成「修不好」。有进展（失败集合变化 / 处理了新评论）即清零。见 `GAP-23`。
  - **实现注记（2026-10-29 落地）**：`failureSignature(checks)` 取失败项名字排序后拼接作签名，签名变化或出现新评论即复位；`consecutiveFails >= 3` 才升级，`healAttempts` 降级为只读展示；升级文案写明「同一组检查连续 N 轮仍在失败（共 M 轮）」并列出检查名。
- **卡片动作的执行者分两类**（官方原文明说）：`Resolve conflicts` / `Fix CI` / `Address comments` / `Merge it` 把指令**作为「你发的消息」送给线程**；`Create PR` 则由宿主**直接按分支建 PR**、不给线程发指令。照此实现即可，照 `deliver` 的样子写 `merge` 会做错。
  - **实现注记（2026-10-29 落地）**：`merge` 只发 `renderMergeRequest` 消息（宿主绝不跑 `gh pr merge`），并把状态置 `landing`；`conflicts` 先读 PR 的 base 分支、再算两侧相对 merge-base 改过文件的交集作为**候选**冲突点交给线程（交集为空时只省略清单、保留指令）；`review` 返回 PR URL 且**不唤醒**线程。三者都在没有 PR 时以 `INVALID_INPUT` 拒绝。见 `GAP-12`。
- **三条禁令要写在每个会动手的 prompt 里**，不只自愈轮：首轮 `renderThreadTask`、`renderMergeRequest`、`renderConflictRequest` 都带「不得 force-push / 不得改 CI 配置让检查通过 / 不得自己合 PR」。见 `GAP-25`。
- **退订是一等动作**：官方止损手段是「ask in the thread for it to stop watching the pull request」。合并后、转终态后、项目归档后都应**显式退订**，不能只靠「状态不在候选集就不扫」这种隐式行为。见 `GAP-24`。
  - **实现注记（2026-10-29 落地）**：`gh` 失败先经 `classifyGhFailure` 分三档 —— `benign`（没配 CI）/ `retryable`（网络、限流、认证 → 记 error，不退订、不改状态）/ `terminal`（PR 或分支已不存在 → 不记 error，先按编号重读 PR 终态：`merged` 转 `completed`、`closed` 转 `failed`，两者都自动退订；读不出来则升 `needs_feedback` 并附原始消息）；未识别的消息**默认 `retryable`**，因为悄悄退订会永久失去监视。`unwatchAt` 是 descriptor 上的显式字段，`/project thread <id> unwatch|watch` 可手动开关。

### 模块 E：Overview Panel（集中总览面板）

- **集中状态视图**：基于 DSH 的 `sessionProjections` 与 `/project` 命令平面，提供全局监控面板。
- **官方是六个分组**（「The pane's **Threads** tab **groups threads by state**」）：

  | 分组 | 官方定义 | 我方对应 |
  | --- | --- | --- |
  | **Ready for review** | "pull request is open and awaiting review" | `awaiting_review` |
  | **Waiting on you** | "need your reply or approval, **or that failed**" | `needs_feedback` + `failed` |
  | **Working** | "still running" | `queued` / `running` / `ci_fixing` |
  | **Landing** | "approved or **queued to merge**" | `landing` |
  | **Idle** | "finished and **aren't waiting on anything**" | `completed` |
  | **Resolved** | "marked done… or **automatically after a week with no activity**"，**可 reopen** | `resolved` |

  **分组是 state 的投影，不是两层模型。** `bucketOf(status)` 就是那个派生函数；加 `landing` / `idle` / `resolved` 只改它的 case，不需要重构状态枚举，也不需要升 `stateVersion`。**2026-10-29 已按此落地**（六组齐全，`bucketOf` 带优先级）。
- **`failed` 不单独成组**：官方把它并入 `Waiting on you`（"or that failed"）。分开列会让用户在两个地方找同一件事。
- **配额展示**：当日配额消耗（X / 200），注意口径是**跨项目**（`GAP-01`）。

> *实现注记（2026-10）*：
> - `sessionProjections` **已接入**（2026-10-29，`GAP-03` 关闭）：线程状态每次变更都 append `project-beta/state` 事件，面板读的是事件折叠出来的快照，不是轮询。
>   - **它不再被状态模型阻塞**：投影暴露的是**桶**不是枚举，`bucketOf` 已解耦，两者可同批实现（原判断的串行约束不成立）。**2026-10-29 已实现**：`project-beta/state` 事件 + `projectBeta` 投影键，写入后自动发布。
> - Overview 另有三个标签页官方有而我们无：**Library**（`GAP-10`）、**Pull requests**（`GAP-11`）、**Scheduled tasks**（未列为差距，见下方第 4 节）。
>   - **2026-10-29 已补齐前两个**。`Library` 的实现要点：本地没有云端「沙箱消失」的约束，文件本来就在盘上，所以它是**清单 + 按需读取**而**不是存储层** —— `deliverThread` 记 `git diff --name-status --no-renames <base>..<branch>` 进 descriptor（关掉重命名检测，好让旧路径留在清单里），worktree 回收后清单仍在，`read` 现读现取、文件不在就报不可读；`Pull requests` 从各线程最后一次观察快照分组，带 checks 计数与未消费评论数，**面板不自己查 GitHub**（那是自愈巡检的活，面板查会白烧 API 配额）。两者都**没有内容时整个字段不出现**。
>   - `Scheduled tasks` 明确不做：DSH 已有 `automation_create`，重复实现只会多一套调度器。

## 3. 暴露接口要求

1. **模型工具（`ctx.tools`）**：
   - `project_coordinate`：拆解目标并（按需）拉起绑定独立 Git 分支/worktree 的并行 Threads；支持只产出建议。
   - `project_memory_sync`：读写跨线程共享记忆库。
   - `project_thread_manage`：查询、干预（Steer）、唤醒指定线程处理 CI 失败或 PR 审查意见。
   - `project_overview`：获取当前项目所有线程、PR 状态与待反馈事项的结构化总览。
   - `project_knowledge_search` / `project_knowledge`：项目知识的检索与按需读取（详见第 4 节的知识模型）。
2. **用户命令与热加载**：
   - 注册 `/project` 系列命令以查看 Overview、追加全局记忆、管理线程与知识。
   - 所有副作用通过 Cordis 的可逆机制注册，确保在 Creator Mode 中支持无残留热重载。
   - 唯一硬依赖是 `subprocess`（没有 git/gh 就没有诚实的隔离）；其余服务一律 `ctx.inject` **延迟注册**——`ctx.get` 只采样一次，晚挂载的服务会永久错过。

## 4. 项目知识模型：挂载式，不是 RAG

**这是 2026-10-28 第一轮外部复核后修正的一节，之前写错了。**

Code Projects 的知识机制是**挂载文件夹**：项目文件挂在 `/mnt/project-files` 下，线程用普通文件工具 `ls` / `cat` 自己读。`OFFICIAL` 全文 `RAG`、`retrieval`、`project knowledge` **各出现 0 次**。

因此本项目的知识层采用 **paths-first（挂载式）**：

1. **主路径**：charter 只渲染知识文件/目录**清单**，不注入正文；线程按需读取。
2. **路径必须锚定项目根**：线程 cwd 是 `.dsh-project/worktrees/<threadId>`，那里只有 baseCommit 里**已提交**的文件。charter 必须给出能定位回项目根的形式，并说明「知识是项目级的，读项目根，不是读你的 worktree」。
3. **导航能力优先于检索**：提供目录树（`tree`）与精确读取（`read`）两个动作。模型在「结构化导航 + 精确读取」上比在「一次检索命中」上强得多——这是挂载模型的核心。
4. **检索是便利工具，不是模式**：BM25 保留，索引在**查询时按需重建**；只读入口永不写盘。
5. **全文注入是可选优化，默认关闭**：配置项 `inlineKnowledgeMaxChars`，开启后仅在低于该值时注入正文（目的是命中 prefix cache）。它是优化，不是机制。

**撤销的设计**：`DEFAULT_CONTEXT_BUDGET_CHARS`、`knowledgeMode`、`RAG_CAPACITY_MULTIPLIER`、`context`/`rag` 二分、知识陈旧检测——连同它们带来的问题一起消失。详见 `GAP-22`。

## 5. 暂不实现（有意为之）

| 项 | 原因 |
| --- | --- |
| **Scheduled tasks**（定时任务） | 官方 Overview 的第三个标签页。DSH 已有独立的 `automation_create` 能力，本项目内再实现一套会重复造轮子且语义冲突。 |
| **Team 协作** | 官方 beta 期间**同样不支持**共享（「A project belongs to one user」）。持平，不是差距。 |
| **Continue in project** | DSH 里会话与工作区的关系已足够松，收益不明。 |
| **云端 sandbox / GitHub App / connectors / cloud environment** | 载体差异，见第 0 节。 |
