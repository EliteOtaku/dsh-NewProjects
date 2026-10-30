# dsh-newprojects

复刻 Claude Code **Projects** 功能的动态协作中枢，作为 DeepSeek Harness 插件运行。

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

## 六块能力

| 能力 | 实现 |
| --- | --- |
| **Coordinator + 并行 Threads** | 协调者（就是调用工具的那个模型）自己给出拆解，经 `project_coordinate` 的 `tasks` 参数传入后直接启动；没给就降级为正则兜底，而**猜出来的拆解一律先提议不启动**（`Suggested threads`，`/project start` 才起，24 小时过期自动丢弃）。每个任务一个 `subagents` 子会话 + 独立 `git branch` + 私有 worktree。每日配额 200，**按用户跨项目合计**（账本在 `~/.dsh/dsh-newprojects/quota.json`，路径可配），全有或全无地预留，启动失败自动退还；项目自己的 `dailyThreadQuotaMax` 是偏好而非硬限。 |
| **跨线程共享记忆** | `project_memory_sync` 写入决策后广播到所有**正在运行**的线程；新线程启动前缀自动带上全量记忆。记忆渲染成字节稳定的 system prompt 段，命中 provider 端 prefix cache。 |
| **项目知识（挂载式）** | 绑定文件或目录后，charter 渲染**索引**（每份文档一行：路径 + 字符数）并给出 **`Project root`**，线程按需从项目根读盘，正文永不进 prompt（对照官方的 `/mnt/project-files` 挂载 + 开局读 `MEMORY.md` 索引）。路径锚定项目根而非线程自己的 worktree，因为 worktree 只含分支切点前已提交的文件。BM25 检索是便利工具。**不是 RAG 模式切换**——那是 chat Projects 的机制，Code Projects 没有。 |
| **自动执行与 CI/PR 自愈** | 线程自己跑测试、commit、push、开 PR。`/project heal` 与后台巡检读 `gh pr checks` / review comments，判定 `heal` / `wait` / `escalate` / `transition`。修复预算按**同一组检查连续失败**计（3 次后升级，出现进展即归零）；`gh` 失败分「终局」与「可重试」——终局（PR/分支已不存在）不记 error，改为重读 PR 终态并自动退订，可重试（网络/限流/认证）记 error 且不退订；`/project thread <id> unwatch\|watch` 可手动退订与恢复。 |
| **Overview 面板** | 官方六分组（`Ready for review` / `Waiting on you` / `Working` / `Landing` / `Idle` / `Resolved`）+ 当日配额 + 知识状态；写入后自动把快照 append 进协调者会话，面板是**事件折叠**而非轮询。`project_overview` 工具与 `/project` 命令提供同样的数据。 |
| **Usage 统计** | 花费取会话日志里 provider 原文的 `usage`（`assistant/message` 事件），按线程与 `provider/model` 拆分；`tokenMeter` 只用于「当前上下文占用」一列，**与花费分列，绝不相加**。拿不到数据时如实报「不可用」并把原因前置，因为一屏 0 加一条脚注会被读成「免费」。`/project usage` 直出，`project_overview` 的 `usage: true` 给结构化数据（默认关：要为每个线程读一遍会话日志）。 |
| **Library 与 Pull requests** | `Library` 是**清单 + 按需读取**，不是存储层：`deliverThread` 记下 `git diff --name-status <base>..<branch>`（`--no-renames`，重命名显示为删除 + 新增），worktree 回收后清单仍在，`read` 现读现取；文件不在了就如实报不可读，绝不返回空内容。`Pull requests` 从各线程最后一次观察快照按状态分组（open / draft / merged / closed / unknown）并统计 checks 与未消费评论数——面板自己不查 GitHub，那是自愈巡检的活。两者都没有内容时**整个字段不出现**，不返回空数组。 |

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
/project goal                 # 项目目标 + 最近几条协调者消息
/project goal ship the beta   # 设置目标（进共享前缀，新线程开局就知道）
/project goal clear           # 清除目标
/project memory               # 列出共享决策
/project memory stack = TypeScript on Node   # 写一条决策并广播
/project memory rm stack      # 删一条
/project threads              # 所有线程及其状态
/project thread <id> steer|respond|retry|interrupt|close|reopen|deliver [text]
/project thread <id> merge|conflicts|review   # 卡片动作：让线程自己合、解冲突、给 PR 链接
/project heal                 # 手动跑一次 CI/PR 巡检
/project coordinate <goal>    # 提议拆解（命令路径没有模型，必然是兜底拆解，故只提议不启动）
/project start [1 3]          # 启动全部或指定序号的建议线程
/project drop                 # 丢弃建议列表
/project concurrent 3         # 并发偏好：一轮最多起 3 个线程（偏好不是硬闸，仍会至少起 1 个）
/project concurrent off       # 清除偏好
/project pause <原因>          # 停下一切：不起新线程、不巡检、不交付，活跃线程被中断
/project resume               # 撤销暂停，被中断的线程仍可继续
/project thread <id> approve push [pr ...]   # 放行被 requireApprovalFor 门住的动作（可一次列多个）
/project knowledge            # 知识层状态：文档数、字符数、绑定路径（只读，不重建索引）
/project knowledge add <path> [path...]   # 绑定文件或目录
/project knowledge rm <path>  # 解绑
/project knowledge rebuild    # 强制全量重建（搜索本来就会按需重建，这条只用于手工兜底）
/project usage                # token 花费：按线程、按模型（拿不到就报不可用，不报 0）
/project library              # 线程产出的文件清单
/project library read <path>  # 读其中一个（按需，从产出它的 worktree）
```

仓库根的 `CLAUDE.md`、`.claude/CLAUDE.md`、`.claude/rules/*.md` 会在每次渲染时读入共享前缀（按官方范围只读根，**不读**子目录与 `.claude/settings.json` 的权限规则）。

模型侧对应七个工具：`project_coordinate`、`project_memory_sync`、
`project_thread_manage`、`project_overview`、`project_knowledge_search`、
`project_knowledge`、`project_library`。

### 项目知识：挂载式，不是 RAG

官方 Code Projects 的知识机制是**把项目文件挂载成文件夹**（`/mnt/project-files`），线程用普通文件工具自己读。
`code.claude.com` 全文里 `RAG`／`retrieval`／`project knowledge` **各出现 0 次**——那套「全文 vs 检索」的二分属于 **claude.ai chat 的旧版 Projects**（无 threads、无 coordinator）。

官方给线程的另一半是**一份开局就读的索引**：「Every cloud thread reads the index file `MEMORY.md` when it starts and **opens the other files when it needs them**」。
引导在**读取协议**里（索引 eager / 正文 lazy），不是 prompt 里一句「回答前先查知识」。

因此本实现采用 **paths-first**。**已实现**：

- **charter 渲染索引**：每份已索引文档一行「路径 — 字符数」，加一句「文件为准」。**正文永不进 prompt**。字符数是让模型能*选*的那个信息——读 2 KB 的决策记录和读 400 KB 的转录是两个不同的决定。
- **没有上下文预算**。正文不进前缀，所以什么都不随模型窗口变。唯一有明文的常驻文本预算是 **16 000 字符**（project instructions）；共享记忆是同一类常驻前缀文本，所以用**同一把尺子**量，不另设一个解释不清的常量。两者都只**报警不截断**：超出量进 `warnings`，在面板与 `project_overview` 里看得到——静默截断决策记录会让线程漏掉必须遵守的规则。
- **没有模式**。没有 `context`/`rag` 二分，就没有阈值抖动，也没有会被遗留的 flag。
- **能自己找路**：`project_knowledge` 的 `tree` 列目录树（默认 2 层 / 200 条，上限 4 层 / 500 条，跳过 `node_modules` 之类与二进制文件），`read` 按行窗读任意一个文件（默认 200 行，上限 2 000）。两处截断都会在结果里**指名是哪个上限**——没说被截断的半棵树会被当成全貌。两者都只读项目根，`../` 之类越界直接报 `INVALID_INPUT`。
- **索引自己保持新鲜**：每次 `project_knowledge_search` 先比对绑定路径的指纹（`路径:大小:mtime`），变了就重建再检索，所以改完文件不需要手工 rebuild。只读入口（`knowledgeState` / `/project knowledge` / 面板 overview）永不写盘；两个并发搜索共用一次重建。
- **收集上限与官方同形，是条目数而不是字符数**：最多 100 份文档（官方 folders 是「first 100 files」），单文件 2 MB（比官方的 30 MB 严，因为我们要把正文切块存进一个 JSON 索引），索引总量 2 000 万字符。触到任一上限就停下并记 warning，说明是**哪一个**上限。
- **BM25 检索是便利工具**，不是一种「模式」，也不是唯一入口：检索没命中时用 `tree` / `read` 走文件系统。

**尚未实现**（见 `docs/GAPS.md`）：

- `inlineKnowledgeMaxChars`（`GAP-22` 第 7 条）：注入路径整个删掉了，效果等于默认关闭，但没有这个旋钮。

> 原本的实现（阈值常量 + 全文/检索二分 + 陈旧检测）建立在错误的产品前提上，已在 `docs/GAPS.md` 的 `GAP-22` 中撤销。两轮复核的证据见 `docs/REVIEW-RESPONSE.md` 与 `docs/REVIEW-RESPONSE-2.md`。

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
| `landing` | 已批准或排队合并（`/project thread <id> merge` 之后） | 巡检读到 merged 后转 `resolved` |
| `completed` | 已完成且不在等任何事（官方的 Idle） | 线程收尾 / `reopen` 回到这里 |
| `resolved` | 已结案（人工 `close` / 合并完成 / 一周无活动） | `/project thread <id> reopen` |
| `failed` | 出错 | 同上，归入 `Waiting on you` |

> 官方六分组 `Ready for review` / `Waiting on you` / `Working` / `Landing` / `Idle` / `Resolved` 与上表一一对应，`bucketOf()` 是那个派生函数——加状态只改它，不需要重构枚举。
> 两个裁定记在 [`docs/GAPS.md`](docs/GAPS.md) 的 `GAP-04` / `GAP-05`：`failed` 不单独成组（官方把它归入 `Waiting on you`）；**人阻塞优先于 PR 生命周期**（卡在审批的线程若归进 `Ready for review`，官方的「有点就表示在等你」那盏灯就不亮，而项目对话里说「继续」到不了它，线程会永久卡死）。
> `resolved` 默认从 Overview 隐藏，`/project threads --all` 可看全部。

## 目录布局

```
src/core/          纯逻辑：manifest / quota（项目偏好）/ quotaLedger（用户级跨项目硬限）/
                   memory / planner / healing / overview / vcs /
                   knowledge（切分·BM25·索引渲染）/ knowledgeSource（唯一碰文件） / engine
src/host/          Host 适配：subprocess 命令行、subagents 线程、tools、commands、类型声明
test/unit/         纯逻辑单测（内存 fake）
test/engine.test.ts 全链路：真实临时目录 + fake git / fake 线程
test/knowledge.test.ts 知识层接入：真实文件、真实索引文件、charter 只含索引不含正文
test/integration/  真实 git 集成：真仓库、真 worktree、真 push（无 git 时自动 skip）
test/commands|tools|index.test.ts  适配层与插件入口
docs/              GAPS.md（差距登记簿）· REVIEW-REQUEST.md ·
                   REVIEW-RESPONSE.md / REVIEW-RESPONSE-2.md（外部复核，两轮）
```

共 **492 项测试**（`node:test`）。除集成测试外全部跑在内存 fake 上，不需要 git 或真实子会话。

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
- **交付即回收 checkout，分支是真相**：PR 开出来、分支推上去之后，工作区里的那份 checkout 就是冗余的，删掉它让磁盘占用与**在飞的线程数**成正比而不是与**跑过的线程数**成正比。删之前必须确认已推送（无分支的 scope 线程一律不删）；删除失败只记 warning，不判交付失败；唤醒已回收的线程前先用 `git worktree add` 把它重建回来，因为子会话的 cwd 就是那个路径。
- **一律走 `CommandRunner` 而非 `node:child_process`**：命令必须落在 Host 所在的机器上，SSH / 容器部署时后者会在错误的主机上执行。
- **一轮结束 ≠ 已交付**：线程收尾消息里没有 PR 链接时进入 `needs_feedback`，而不是给一个声称产物存在的 `completed` 徽章。
- **广播只推正在跑的线程**：给 idle 子会话发消息会新起一轮，把所有已完成线程都唤醒会白烧 token。官方**根本不给运行中线程更新**，所以这条属于超额实现，不是缺口。
- **未知 CI 状态算 `pending`，不算通过**：假绿是自愈器绝不能产生的输出。
- **修复预算按连续失败计，不按生命周期累计**：PR 开两周、被评审四轮、每轮都是新意见时，累计计数会在第四轮误报「修不好」，而那四轮里一次都没重复。签名变化或新评论到达即归零。
- **「读不到 PR」不等于「PR 没问题」**：`gh` 失败必须分类。把一次 401 当成「没有检查也没有评论」，线程会永远安静地留在 `awaiting_review`。
- **不可逆动作与它的防护同批**：删 worktree、归档项目这类动作不该排在最后——在它之前每一次操作都在那个风险上。
- **检索工具始终注册，不随状态增删**：项目随时可能变，工具列表来回变会让 provider 的 prompt 缓存失效，且没有任何收益。
- **索引是派生状态**：`.dsh-project/KNOWLEDGE_INDEX.json` 已 gitignore，随时可从绑定的文件重建；坏索引被当作「没有索引」而不是致命错误。
- **`subprocess` 是唯一硬依赖**：其余能力（tools / commands / systemPrompt / timer + subagents）全部走 `ctx.inject` 延迟注册。`ctx.get` 只在激活那一刻采样注册表，晚挂载的服务会永久错过。

## 已知未实现部分

相对官方 Claude Code Projects，六批实现计划已全部完成：全局配额、知识挂载、模型优先拆解、六分组投影、Library 与 PR 聚合、卡片动作、审批门、Pause/Archive、线程超时、worktree 回收、Usage 统计均已落地。剩下的只有**有意为之的边界**（重启后后台自愈停摆、记忆仍整段进 charter、云端 sandbox 与 GitHub App 的载体差异、Team 协作持平）；唯一的按需项 `GAP-28` 并发偏好也已于 2026-10-30 完成。见 `docs/GAPS.md` 的 `ARCH` / `BOUND` 小节。

完整清单、代码证据、依据来源与验收标准见 **[docs/GAPS.md](./docs/GAPS.md)**，按批次推进。那份文档是判断「某个能力到底有没有」的唯一依据——不要凭本文件的段落推断。

外部复核的记录见 **[docs/REVIEW-REQUEST.md](./docs/REVIEW-REQUEST.md)**（我方判断与疑问）与 **[docs/REVIEW-RESPONSE.md](./docs/REVIEW-RESPONSE.md)**（Claude 的回执）。

## 许可证

[MIT](./LICENSE)
