# 实现差距登记簿

这份文档记录 `dsh-newprojects` 相对**官方 Claude Code Projects** 与**本项目内部规格**的未实现部分、已知缺陷与有意为之的边界，用于分轮次逐步补齐。

它不是愿望清单：每一条都带**代码证据（文件:行号）**、**依据来源**和**验收标准**。开工前先读条目，完工后按验收标准关闭，不要凭记忆改动。

## 怎么用

- **证据行号会漂移**。改动相关代码后，回来更新行号；行号失效时按符号名（函数/常量名）搜索，符号名是稳定的契约。
- **优先级按「会不会安静地出错」排**，不按工作量排。会静默产出错误答案的排最前，只影响观感或磁盘占用的排最后。
- **不要一次做完整份清单**。按 `## 分批计划` 的批次推进，每批独立提交、独立验证（`npm run verify` + 实机探针），完成后回来勾掉。
- 架构性差异（`GAP-A*`）是**定位不同而非缺陷**，只在明确改变产品定位时才做，不要顺手实现。

## 依据来源

两个来源，冲突时以官方文档为准（本项目规格写于官方文档细化之前）。

| 代号 | 来源 | 说明 |
| --- | --- | --- |
| `SPEC` | `PROJECT_BETA_SPEC.md` | 本项目内部规格，五模块定义 |
| `OFFICIAL` | https://code.claude.com/docs/en/claude-projects | 官方 Claude Code Projects 文档（2026-10 拉取），比 `support.claude.com` 那篇「什么是项目」详细得多 |

`support.claude.com` 那篇只覆盖旧版项目知识库 + RAG，正文明确写着「本文的其余部分介绍项目的当前版本」，新版细节全部指向 `code.claude.com`。

## 优先级总览

| 优先级 | 含义 | 条目 |
| --- | --- | --- |
| **P0** | 违背规格或官方原文 | `GAP-01` |
| **P1** | 会静默产出错误结果 | `GAP-02` |
| **P2** | 官方有、我们无，且多个其他能力依赖它 | `GAP-03` `GAP-04` `GAP-05` |
| **P3** | 官方有、我们无，独立功能 | `GAP-06` ~ `GAP-13` |
| **P4** | 项目管理类，缺了不能「管起来」 | `GAP-14` ~ `GAP-18` |
| **P5** | 磁盘与性能，不出错 | `GAP-19` `GAP-20` |
| **ARCH** | 架构性差异，记录不排期 | `GAP-A1` ~ `GAP-A4` |
| **BOUND** | 有意为之的边界，非缺陷 | `BOUND-1` ~ `BOUND-4` |

---

## P0 — 违背原文（1 项）

### GAP-01 线程配额是项目级，不是用户全局级

- **依据**：`SPEC` 模块 A 原文「默认限制单个用户每天**在所有项目中**最多新建 200 个线程」；`OFFICIAL`「The enforced limit is 200 new threads per day **across your projects**」。两处都说跨项目。
- **现状**：计数器落在每份 manifest 里 —— `dailyThreadsCreated`（`src/types.ts:141`）与 `quotaDay`（`src/types.ts:148`），每个项目各记各的。三个项目各开 200 个，当天就是 600 个。
- **为什么难**：manifest 是每项目一份，谁都不知道别的项目在哪，读文件汇总不可行。
- **做法**：新增用户级账本，例如 `~/.dsh/dsh-newprojects/quota.json`，字段 `{ day, created, byProject: Record<projectId, number> }`。`reserveQuota` 先查账本再记项目自身计数（项目计数保留，用于 overview 展示）。账本读写要有和 `ManifestStore` 同级的串行队列 + 原子写 + CAS，否则并发拉起线程时会丢计数。
- **要小心的**：账本路径必须能通过配置改（测试与多 profile 场景需要隔离），不要在模块内硬编码 `homedir()`。
- **验收标准**：
  1. 两个不同 rootDir 的项目，各自 `coordinate` 到总和超 200 时，后一个被拒且**不消耗**任何配额；
  2. 账本跨进程可见（起两个 engine 实例读写同一账本，不丢计数）；
  3. `quotaDay` 翻页时账本与项目计数一起重置；
  4. 单测覆盖「超限不改账」与「翻页重置」。

---

## P1 — 会静默出错（1 项）

### GAP-02 项目知识没有变更检测

- **依据**：无明文要求，但这是**唯一会让系统安静给出过期答案**的缺陷。官方对知识库的承诺是「Claude 将使用这些内容来更好地理解上下文」，用陈旧内容回答等于违背承诺。
- **现状**：`buildKnowledge`（`src/core/engine.ts:897`）只在三处被调用：`/project knowledge rebuild`（`src/host/commands.ts:94`）、`project_knowledge` 工具的 `rebuild` 动作（`src/host/tools.ts:410`）、以及 `setKnowledgePaths` 内部。绑定的文件改了，索引不知道，prompt 里仍是旧正文，**没有任何提示**。
- **已有的基础**：`IndexedDocument.sha`（`src/core/knowledge.ts:83`）已经存了每份文档内容的指纹，`knowledgeSource.ts` 里已有 `stat` 调用（`:119`、`:181`）。做陈旧检测不需要新概念。
- **做法（按成本从低到高，建议先做 A）**：
  - **A. 惰性校验**：`knowledgeState()` 在有缓存时比对绑定路径的 `mtime`+`size` 摘要（目录则取其下所有已索引文件的摘要）。不一致就在返回的 `KnowledgeState.warnings` 里加一条 `knowledge changed on disk; run /project knowledge rebuild`，并在 `describeKnowledge` 与 overview 里显示。**不自动重建**——重建是写盘动作，不该发生在只读查询里。
  - **B. 自动重建**：`coordinate` 启动前与 `healSweep` 每轮开头做一次 mtime 校验，变了就重建。成本是不能在只读路径里做，得接受一次额外 IO。
  - **C. 文件监听**：`fs.watch`。不推荐 —— DSH 插件生命周期里难以保证句柄回收，且网络盘上不可靠。
- **验收标准**：
  1. 改一个已索引文件后，`overviewJson().knowledge.warnings` 出现陈旧提示；
  2. 未改动时不出现提示（不产生假阳性 —— 每次查询都警告等于没有警告）；
  3. 新增/删除文件同样能检出；
  4. 单测覆盖「改了→警告」「没改→不警告」「rebuild 后警告消失」。

---

## P2 — 官方有且被多项依赖（3 项）

### GAP-03 没有会话投影（sessionProjections）

- **依据**：`SPEC` 模块 E「基于 DSH 的 `ctx.projection` 与 `/project` 命令平面」；`OFFICIAL` 的 **Overview** 面板与线程卡片都要求随会话实时更新。
- **现状**：`sessionProjections.register` **一行都没写**（`grep -rn projection src/index.ts src/host/*.ts` 返回空）。目前只有 `project_overview` 工具（`src/host/tools.ts:276`）与 `/project` 命令（`src/host/commands.ts:169`）这两种**主动拉取**的表面。
- **连带影响**：`GAP-04`、`GAP-05`、`GAP-11`、`GAP-12` 都需要它，所以它排在这一批的第一位。
- **要修的文档**：`README.md:29` 现在写着「Host-only 会话投影保持面板随会话事件更新」，**这句是虚的**，随本项一起改或先改成事实陈述。
- **做法**：`sessionProjections.register` 的 `ProjectionDefinition` 需要一个 `key`、`stateSchema`（Zod）、`init(header, inheritedEventCount)`、`apply(state, event)`、`stateVersion`。关键约束：
  - `apply` 必须是**纯函数**（不得读文件、不得发命令），因为它对每个会话事件同步执行。所以投影里只能放「已算好的摘要」，不能在里面查 manifest。
  - 线程状态变化的来源是 `agent` 层的 turn 结束与 `healSweep` 的写入，这些要主动 `append` 一个事件到会话，投影才能看见。**目前这些状态只写进 manifest 文件，没有写进会话事件流** —— 这是本项真正的工作量，不是写个 reducer 就完。
- **验收标准**：
  1. 注册后 `/project init` + `coordinate` 能在会话快照里看到线程摘要，且不需要用户敲命令；
  2. 线程 turn 结束后快照里的状态随之改变；
  3. 插件 dispose 后该 projection key 消失（无残留）；
  4. 单测覆盖 `apply` 的纯函数性质（同事件序列产出同状态）。

### GAP-04 Overview 只有五桶，官方是六组

- **依据**：`OFFICIAL` 的 Threads 标签页分组 —— **Ready for review / Waiting on you / Working / Landing / Idle / Resolved**；`SPEC` 模块 E 只列了四类（已完成 / 待审 PR / 等反馈 / 运行中+自愈中）。
- **现状**：`OverviewBucket`（`src/types.ts:23`）是 `completed | awaiting_review | waiting_for_feedback | running | failed`，`bucketOf`（`src/core/overview.ts:41`）把 `queued|running|ci_fixing` 归 `running`、`completed` 归 `completed`、`failed` 归 `failed`。
- **缺的三个语义**：
  - **Landing**：PR 已批准（`reviewDecision === 'APPROVED'`）或已入队合并。数据其实已经读进来了（`ProjectReviewSnapshot` 有 `state`，`readReviewVerdicts` 在 `src/core/engine.ts:806` 已接入），只是没有对应状态。
  - **Idle**：完成且不等待任何事。现在 `completed` 混着「已完成且有 PR」与「收尾没报 PR」两种情况。
  - **Resolved**：人工或超时标记完成、**可重开**、**不再被唤醒**。现在没有任何状态表达「这个线程结束了，别再管它」，而 `healSweep` 的候选状态（`src/core/engine.ts:755` 附近的 `awaiting_review | ci_fixing | running`）恰恰依赖这个区分才能正确停止唤醒。
- **做法顺序**：先扩 `ThreadStatus` 与 `OverviewBucket`（扩枚举是破坏性改动，要同时改 `bucketOf`、`renderOverviewMarkdown`、`describeThread`、所有测试断言），再补 Landing/Resolved 的判定来源。
- **验收标准**：
  1. 六个分组与官方命名一一对应（中文文案自行决定，键名对应）；
  2. `Resolved` 的线程不再进入 `healSweep` 候选，且可被重新打开；
  3. 一周无活动自动转 `Resolved`（若实现 `GAP-05`）；
  4. 旧的五项断言全部更新，不允许留着双重语义。

### GAP-05 没有归档与自动收尾

- **依据**：`OFFICIAL`「Resolved: …or automatically after a week with no activity. You can reopen one from the same menu」。
- **现状**：`manifest.threads` **只增不减**，`grep "delete draft.threads"` 返回空。线程描述符永远不会被清理或归档。
- **后果**：跑满几百个线程后 `manifest.json` 变大、每次 `overview` 都要遍历全部线程、overview 里堆满早就没用的条目。
- **做法**：不删数据（删除会让历史 PR 关联丢失），而是加 `archivedAt?: number` 字段，`overview` 默认只列未归档的，加一个 `/project threads --all` 开关。自动归档用 `updatedAt` 距今天数判断，阈值可配。
- **验收标准**：
  1. 超过阈值的线程自动获得 `archivedAt`；
  2. 默认 overview 不显示已归档线程，但数据仍在 manifest 里；
  3. 归档的线程不被 `healSweep` 唤醒；
  4. 可手动取消归档（对应官方「reopen」）。

---

## P3 — 官方有、我们无（独立功能，8 项）

### GAP-06 项目没有持久化的 goal

- **依据**：`OFFICIAL`「**Goal** (optional): one line of what you're trying to get done… Without a goal, Claude works from the tasks you send, and you can add a goal later in **Project settings > General**」。
- **现状**：`goal` 只是 `coordinate` 的入参字符串（`src/core/engine.ts:402`），**不落盘**。`grep -c goal src/types.ts` = **0**，`ProjectManifest` 里没有这个字段。
- **后果**：新会话进来不知道这个项目要干什么，`charter` 里也没有目标，线程启动时缺少「我们在朝什么努力」。
- **做法**：`ProjectManifest` 加 `goal?: string`；`init` 接受 goal；`charter` 渲染它；`/project goal <text>` 修改；`project_overview` 返回它。
- **验收标准**：
  1. `init` 带 goal 后落盘、跨进程读回；
  2. charter 文本包含 goal，且 goal 不变时 charter 字节不变（不能破坏 prefix cache）；
  3. 无 goal 时 charter 不渲染空段落。

### GAP-07 项目与协调会话之间没有绑定

- **依据**：`OFFICIAL`「A project is one ongoing conversation where Claude coordinates a stream of related work for you.」
- **现状**：模型在**任意会话**里调 `project_coordinate`；项目是「无状态工具集」，不是一个持续对话。
- **后果**：无法「把 bug 报告随手丢进去」；后续消息没有「建新线程还是转给已有线程」的路由逻辑；用户每次都要重新交代背景。
- **为什么排在 P3 而不是 P2**：它是**产品定位改动**，不是补齐功能。真要做，得先回答「一个 DSH 会话可能同时开多个工作区，项目绑定哪个会话」这个设计问题，而且要改 `project_coordinate` 的语义（从「一次性拆解」变成「消息路由」）。
- **验收标准**（若做）：
  1. 项目记录 `coordinatorSessionId`；
  2. 同一会话的后续消息能路由到已有线程（按标题/目标匹配）或新建线程，且路由决策可见；
  3. 换会话打开同一项目时有明确提示，不是静默失效。

### GAP-08 没有 Suggested threads（先提议后启动）

- **依据**：`OFFICIAL`「Sometimes Claude proposes threads instead of starting them, in a **Suggested threads** list. Click the arrow on a suggestion to start that thread. … a button under the list starts all of them.」
- **现状**：`coordinate` 直接启动（`src/core/engine.ts:400`）。`CoordinateResult` 里有 `planned` 字段但只用于回显。
- **做法**：`coordinate` 加 `planOnly: true` 选项，返回计划不启动；计划存进 manifest（带 `suggestedAt`）；新增 `project_thread_manage` 的 `start` 动作或 `/project threads start <id>`。
- **验收标准**：
  1. `planOnly` 时零线程启动、零配额消耗；
  2. 建议可单独启动，也可一次全起；
  3. 建议过期（例如超 24h）自动丢弃。

### GAP-09 不读仓库里的 CLAUDE.md / .claude/rules/

- **依据**：`OFFICIAL`「`CLAUDE.md`, `.claude/CLAUDE.md`, and `.claude/rules/` at the repository root — Loaded from every repository when the thread starts」。
- **现状**：charter 只读自己的 `.dsh-project/PROJECT_INSTRUCTIONS.md`（默认路径在 `src/core/engine.ts:218`，读取在 `:362`）。
- **后果**：用户仓库里已有的 `AGENTS.md` / `CLAUDE.md` 约定不会传给线程 —— 这对一个跑在用户仓库里的插件来说是真实的落差。
- **做法**：`renderProjectCharter` 的输入加一层「仓库约定」来源，按 `CLAUDE.md` → `.claude/CLAUDE.md` → `AGENTS.md` → `.claude/rules/*.md` 顺序收集（存在才读）。**必须保持前缀稳定**：内容按固定顺序拼接，不含时间戳。
- **注意**：本仓库自己的 `AGENTS.md` 就会被读到 —— 这是正确行为，但要确认里面的「提交前先跑 verify」之类指令对线程也是合理的。
- **验收标准**：
  1. 仓库有 `CLAUDE.md` 时 charter 包含它；
  2. 多个来源按固定顺序合并，同内容多次渲染字节相同；
  3. 文件不存在时静默跳过，不产生空段落也不报错。

### GAP-10 没有 Library（线程产出文件的收集）

- **依据**：`OFFICIAL`「**Library**: the files and folders you added and the files threads produced」。
- **现状**：只收集用户绑定为知识的路径（`knowledgePaths`）。**线程产出的文件完全不收集** —— 它们只留在 `.dsh-project/worktrees/<threadId>` 里，等 worktree 被回收（`GAP-19`）就一起没了。
- **做法**：交付时（`deliverThread`，`src/core/engine.ts:1071`）记录 `git diff --name-status <base>..<branch>` 的文件清单进 descriptor；`project_overview` 汇总去重后返回。不需要复制文件。
- **验收标准**：
  1. `deliverThread` 后 descriptor 里有产出文件清单；
  2. overview 的 `library` 字段汇总所有线程产出，去重；
  3. worktree 删除后清单仍在（清单是元数据，不依赖 worktree 存活）。

### GAP-11 没有 Pull requests 聚合视图

- **依据**：`OFFICIAL`「**Pull requests**: shown once threads have opened any」。
- **现状**：每线程一个 `prOrDeliverableRef` 字符串字段，没有聚合。
- **做法**：`overviewJson()` 加 `pullRequests` 数组，从所有 descriptor 的 `review` 快照里提取；带 `state` / `checks` 摘要 / `url`。
- **验收标准**：有 PR 的线程出现在聚合里，按状态分组；无 PR 时不返回该字段（不要返回空数组假装有）。

### GAP-12 线程卡片动作缺 Merge it / Resolve conflicts / Review PR

- **依据**：`OFFICIAL` 线程卡片按钮 —— **Resolve conflicts**、**Fix CI**、**Address comments**、**Merge it**、**Review PR**、**Create PR**。
- **现状对照**：`ThreadAction`（`src/core/engine.ts:125`）是 `inspect | steer | respond | interrupt | retry | close`；工具侧 enum（`src/host/tools.ts:233`）多了 `deliver | heal`。
  - **Fix CI / Address comments** → 由 `heal` 覆盖（自动判定修哪一类）
  - **Create PR** → 由 `deliver` 覆盖
  - **Merge it** → **缺**。需要 `gh pr merge <n> --squash`（或按 `mergeable` / review 状态选策略），并处理「不可合并时报原因」。
  - **Resolve conflicts** → **缺**。本质是「把目标分支合进线程分支 + 解冲突 + push」，可用现有 `resume` 实现，但需要一个新 prompt 模板（和 `buildHealPrompt` 并列，不能复用）。
  - **Review PR** → **缺**。要求把 PR URL 传回会话让前端可点。投影做好（`GAP-03`）后这件事才有真正落点。
- **验收标准**：
  1. `merge` 动作在 PR 可合并时成功并记 `completed`；不可合并时返回具体原因（不静默失败）；
  2. `conflicts` 动作能唤醒线程并把冲突文件清单交给它；
  3. 两者都有单测覆盖成功与失败路径。

### GAP-13 没有 Usage（token 用量）

- **依据**：`OFFICIAL`「Open **Usage** in **Project settings** to see token use by thread and by model, and how much went to the project conversation.」
- **现状**：完全没有。Host 有 `tokenMeter` 服务但未接入（`grep -rn tokenMeter src/` 返回空）。
- **做法**：读 Host `tokenMeter` 按线程归集；`overviewJson()` 加 `usage` 字段。**注意**：如果 `tokenMeter` 只能给全局数字，就明确标注「本项目无法按线程拆分」，不要造一个假的分布。
- **验收标准**：能看到按线程的用量；拿不到精确数据时如实显示「不可用」而不是显示 0。

---

## P4 — 项目管理类（5 项）

### GAP-14 没有 Pause

- **依据**：`OFFICIAL`「**Pause**: stops everything at once. Every running thread and the conversation are interrupted, no new threads start, scheduled tasks don't run, and the project doesn't accept messages until you resume it.」
- **现状**：无。只能逐个 `interrupt`。
- **做法**：`ProjectManifest` 加 `pausedAt?: number`；`coordinate` / `healSweep` / `deliverThread` 开头检查并拒绝；`/project pause` 与 `/project resume`。
- **验收标准**：暂停后 `coordinate` 与 `healSweep` 都不动作且给出明确原因；恢复后可继续；暂停状态跨进程持久。

### GAP-15 没有 Archive

- **依据**：`OFFICIAL`「**Archive**: hides the project from the sidebar and archives its threads, which stops any thread that was running or watching a pull request.」
- **现状**：无归档概念。（`GAP-05` 是**线程级**归档，本条是**项目级**，两者不同，不要合并实现。）
- **做法**：`active: false` 或 `archivedAt`；归档时对所有活跃线程置停并清理 `live` 映射；`/project archive` 与 `/project unarchive`。
- **验收标准**：归档后无任何后台动作（watcher 不再碰它）；取消归档后线程可继续。

### GAP-16 知识索引的自动重建时机尚未决定

- **现状**：`buildKnowledge` 只从两个显式入口进入 —— `/project knowledge rebuild`（`src/host/commands.ts:94`）与 `project_knowledge` 工具的 `rebuild` 动作（`src/host/tools.ts:410`）。
- **本项要决的不是「能不能重建」，而是「什么时候允许自动重建」**。新增自动重建会把写盘动作引入原本只读的路径，所以位置有限制：
  - ❌ 不能在 `knowledgeState()` / `overview()` 里做 —— 这两个是查询，副作用会让读者意外。
  - ✅ 只能在 `coordinate()` 与 `healSweep()` 开头做 —— 这两个本来就是写路径。
- **与 `GAP-02` 的关系**：`GAP-02` 的 A 方案（惰性校验 + 警告）落地后，用户至少能看到「知识已过期」。本条决定的是**要不要替用户自动修**。
- **做完后**：把结论写回 `GAP-02` 的做法段，本条即可关闭。

### GAP-17 无线程运行时长上限

- **现状**：卡死的线程会一直占 `running`，只能人工 `interrupt`。`grep -rn "maxDuration\|deadline" src/core/engine.ts` 返回空。
- **做法**：descriptor 加 `deadlineAt`；`healSweep` 检查超时并 `interrupt` + 置 `needs_feedback`（不是 `failed` —— 超时是「没跑完」，不是「跑失败」）。
- **验收标准**：超时线程被中断且状态可解释；不误杀长任务（阈值要可配，默认足够宽）。

### GAP-18 未接入 approval 服务

- **现状**：线程自己 push、自己开 PR，不请求审批（`grep "ctx.get('approval')"` 返回空）。
- **判断**：在 `danger-full-access` 下这是**合理的设计选择**，但在受限环境里会成为阻碍。不是缺陷，是**缺一个开关**。
- **做法**：加配置项 `requireApprovalFor: ('push'|'pr'|'merge')[]`，默认空数组（保持当前行为）。只有用户显式开启才走 `approval` 服务。
- **验收标准**：默认行为不变；开启后 push 前出现审批请求；拒绝时状态可解释（不是卡在 running）。

---

## P5 — 磁盘与性能（2 项）

### GAP-19 worktree 永不回收

- **现状**：`worktreeRoot` 是 `.dsh-project/worktrees`（`src/core/manifest.ts:47`），每个线程一个目录，**从不删除**（`grep "worktree remove\|prune" src/` 返回空，engine 里没有任何 `rm`）。
- **后果**：跑 100 个线程 = 100 份完整 checkout。
- **做法**：`deliverThread` 成功后（PR 已开、分支已推）删除 worktree（`git worktree remove --force` + 目录兜底），**保留分支**。删除前确认：分支已推送（否则未推送的提交会丢）。放在 `GAP-10` 之后做 —— 先有产出清单，再删目录，顺序不能反。
- **验收标准**：
  1. 交付成功且已推送后 worktree 被删，分支与远端都在；
  2. 未推送时不删（防止丢提交）；
  3. 删除失败不阻塞交付（记 warning）。

### GAP-20 `deinit` 只删 manifest，其余全留磁盘

- **现状**：`ManifestStore.destroy()`（`src/core/manifest.ts:192`）只做两次 `rm`：`manifest.json` 与 `.tmp`。`.dsh-project/` 目录、所有 worktree、`KNOWLEDGE_INDEX.json`、`SHARED_MEMORY.md` 全部留在磁盘上。它们都被 `.gitignore` 忽略，所以不脏仓库，但占空间且让「已 deinit」的项目残留。
- **做法**：`destroy` 增加可选参数 `{ purge: boolean }`。默认 `false`（保守，不删用户可能想要的数据），`/project deinit --purge` 显式清理整个 `.dsh-project/`。**先确认 `.dsh-project` 下没有任何用户手写文件**（`PROJECT_INSTRUCTIONS.md` 是**用户写的**，不能默认删）。
- **验收标准**：
  1. 默认 `deinit` 行为不变；
  2. `--purge` 删除 `.dsh-project/` 但保留仓库其他内容；
  3. `--purge` 时对 `PROJECT_INSTRUCTIONS.md` 给出明确警告或先备份。

---

## ARCH — 架构性差异（记录，不排期）

这些**不是缺陷**，是定位不同。只有明确要改变产品定位时才做；顺手实现会破坏现有取舍的完整性。

### GAP-A1 云端 sandbox vs 本地 worktree

- **官方**：每个云线程在自己的云端 sandbox 里 clone 仓库，关掉笔记本也继续跑，sandbox 在轮次之间暂停。
- **我们**：本地 worktree，宿主进程在跑才能推进。
- **换来的**：能用本地工具链、本地文件、本地网络环境、本地凭据。
- **代价**：宿主不在就停。已在 `BOUND-1` 记录。

### GAP-A2 没有 GitHub App / connectors / cloud environment

- **官方**：需要装 Claude GitHub App；线程从账号 connectors 拿 MCP 工具；环境决定网络白名单、环境变量、网络密钥、setup 脚本。
- **我们**：走 `gh` CLI 的已有鉴权，不装 App；MCP 用 DSH 自己的配置。
- **换来的**：不需要装 App、不需要云端环境配置。
- **代价**：没有 setup 脚本与网络密钥管理。若将来需要，应作为独立能力设计，不要塞进本项目。

### GAP-A3 没有 Team 协作

- **官方**：beta 期间**同样不支持**共享（「A project belongs to one user. You can't share a project or its threads with another user」）。`support.claude.com` 那篇讲的 Team 共享是**旧版**项目。
- **结论**：**持平**，不是差距。不要因为看到旧文档里的共享权限表就去做。

### GAP-A4 没有 Continue in project

- **官方**：从一个已有云会话「Continue in project」，把它的工作带进项目。
- **我们**：无。
- **判断**：DSH 里会话与工作区的概念已经足够松，做这个的收益不明。记录，不排期。

---

## BOUND — 有意为之的边界（非缺陷）

这些是已写进代码注释的**已知限制**，不打算改或改不动。列在这里是为了避免下一轮把它们当新缺陷重新分析一遍。

### BOUND-1 重启后后台自愈停摆

- `SubagentThreadRuntime.parents` 是**进程内存**（`src/host/subagents.ts`）。宿主重启后 `firstKnownParent`（`src/index.ts:299`）返回 `undefined`，watcher（`src/index.ts:265`，注册于 `:230`）跳过该引擎，无法唤醒任何线程。
- **根因**：Host 按 **live sender** 授权唤醒（`subagents.sendMessage` 要有真实 `Agent`），凭空造一个 parent 会被拒。这不是我们的疏漏，是安全模型。
- **缓解**：重启后用户主动敲 `/project heal`（命令行里有 `agent`，是可用的 parent）或直接 `thread <id> retry`。
- **要不要改**：不改，除非 Host 提供持久化的授权主体。

### BOUND-2 线程描述符永不清理

见 `GAP-05`（会做归档解决）。

### BOUND-3 `quotaWarning()` 是死代码

- `src/index.ts` 的 `overview()` 内联写了 80% 判断，而这个导出的 `quotaWarning()` 无人调用（只有 `test/unit/quota.test.ts` 用到）。
- **判断**：`GAP-01` 重写配额时会一并处理 —— 要么让 overview 改用它，要么删掉。**不要**为了「消除未使用导出」而单独改，会与配额改造冲突。

### BOUND-4 单进程内一个 root 恰好一个 turn-end 订阅

- `createRuntime` 用 `detaches: Map<string, () => void>` 保证每个 root 只 `attach()` 一次。这是**正确设计**，不要为了「多实例」去动它。

---

## 已修正的错误判断

记录曾经判断错、后来纠正的结论，避免下一轮重复踩。

| 时间 | 曾经的判断 | 实际 | 出处 |
| --- | --- | --- | --- |
| 2026-10 | 「缺并发度控制」列为规格缺口 | **判断错误**。`OFFICIAL` 原文：「There's no fixed number; Claude starts as many as the work calls for, and a limit you ask for is a **preference rather than a cap**. The enforced limit is 200 new threads per day across your projects.」并发数**本来就不是硬上限**。真正的偏离在配额口径（→ `GAP-01`）。 | 讨论 m01720 前后 |
| 2026-10 | 「review verdicts 没接入」 | **判断错误**，已接入。`readReviewVerdicts`（`src/core/engine.ts:806`）把 `CHANGES_REQUESTED` 的 review 正文转成 `review-<id>` 的待消费评论参与自愈。 | 代码核对 |
| 2026-10 | README 称「Host-only 会话投影保持面板随会话事件更新」 | **文档虚述**，投影未实现。修 `GAP-03` 时一并改。 | `README.md:29` |
| 2026-10 | 「项目知识 RAG 未实现」 | 后来已补齐（`src/core/knowledge.ts` + `knowledgeSource.ts`，261 项测试）。**不是缺口**，此条仅作历史记录。 | commit `71cac2e` |

---

## 分批计划

每批独立提交、独立验证。批内条目彼此有依赖，不要拆开做。

| 批次 | 条目 | 依赖 | 预计量 |
| --- | --- | --- | --- |
| **第一批** | `GAP-01` 全局配额 + `GAP-02` 知识陈旧检测 | 无 | 小（~300 行 + 测试） |
| **第二批** | `GAP-03` 会话投影 → `GAP-04` 六分组 → `GAP-05` 归档 | 04/05 必须等 03（状态要能进事件流） | 中偏大 |
| **第三批** | `GAP-06` goal + `GAP-07` 会话绑定 + `GAP-10` Library + `GAP-11` PR 聚合 | 07 需先定「项目绑哪个会话」的设计 | 中 |
| **第四批** | `GAP-08` 建议线程 + `GAP-09` 仓库约定 + `GAP-12` 卡片动作 | 08 依赖 07 的消息路由思路 | 中 |
| **第五批** | `GAP-14` Pause + `GAP-15` Archive + `GAP-17` 超时 + `GAP-19` worktree 回收（需 10 先完成） | 19 依赖 10 | 小 |
| **按需** | `GAP-13` Usage、`GAP-18` approval 开关、`GAP-20` purge、`GAP-16` 自动重建决策 | — | 小 |

**验证方式（每批都要走）**：

1. `npm run verify`（typecheck + build + 全部测试）
2. 实机探针：junction 挂载 + `dsh --profile web --patch ./probe-patch.yml --no-open --port 1949x`，检查 `PROBE-OK tools:` 与零 `did not activate`
3. **日志不得截断**（`| head` 会吞掉真实错误 —— 这是踩过的坑，见 `AGENTS.md`）
4. 更新本文件的勾选状态，以及 `README.md` 中因此变化的事实陈述
