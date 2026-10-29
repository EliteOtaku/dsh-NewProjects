# 实现差距登记簿

这份文档记录 `dsh-newprojects` 相对**官方 Claude Code Projects** 与**本项目内部规格**的未实现部分、已知缺陷与有意为之的边界，用于分轮次逐步补齐。

它不是愿望清单：每一条都带**代码证据（文件:行号）**、**依据来源**和**验收标准**。开工前先读条目，完工后按验收标准关闭，不要凭记忆改动。

## 复刻的是什么，不是什么（评审前必读）

这一节是 2026-10-28 第一轮外部复核后新增的。缺了它，评审会默认我们在重建云端产品，从而把载体差异当成功能缺陷。

| | 内容 |
| --- | --- |
| **复刻对象** | **Code Projects 这个功能本身** —— 它的概念、行为、状态语义、交互契约。规格来源是 `OFFICIAL`（`code.claude.com`），不是云端实现细节。 |
| **交付形态** | **DSH 本地插件**（`dsh-newprojects`）。跑在用户真机、真仓库、DSH 宿主的 `subagents` / `worktrees` / `tools` 之上。 |
| **不是** | 不是重建 Anthropic 的云产品：不做云端沙箱、不做 GitHub App、不做账号 connectors、不做 cloud environment、不做跨设备续跑。 |
| **载体替换规则** | 官方的**云端沙箱**我方替换为**本地 git worktree**；官方的**云端持久化会话**我方替换为**DSH 子会话 + 事件溯源 Session Log**；官方的**GitHub App** 我方替换为 **`gh` CLI**。这三处替换的差异一律记在 `## ARCH`，**不是缺陷、不排期**。 |
| **评判标准** | 判断一项「缺不缺」，看的是**功能语义有没有**（用户能不能做到这件事），不是**云端的实现载体有没有**。凡是「官方用 A 载体实现 X，我们用 B 载体实现了 X」的，不算差距。 |

同理，`support.claude.com` 的 RAG 专文描述的是**另一个产品**（见下节），不构成本项目的规格来源。

> **官方规格原文（动手前先读）**：<https://code.claude.com/docs/en/claude-projects>　·　[`.md` 版](https://code.claude.com/docs/en/claude-projects.md)
>
> **DSH 宿主源码**：<https://github.com/deepseek-ai/deepseek-harness>
>
> 本文件所有「官方说了什么」都是转述。有疑问时以原文为准 —— 第一轮就是因为只读转述、没读原文，把知识层抄成了另一个产品。
>
> 同理，凡是「在 DSH 上做不到 / 代价很高」的判断（`BOUND` 段、`GAP-18` 的审批改译），依据是 **DSH 源码里的服务契约**，不是官方文档。这类条目的「现状」里都写了对应的服务名与文件，按服务名去源码里搜。

## 怎么用

- **证据行号会漂移**。改动相关代码后，回来更新行号；行号失效时按符号名（函数/常量名）搜索，符号名是稳定的契约。
- **优先级按「会不会安静地出错」排**，不按工作量排。会静默产出错误答案的排最前，只影响观感或磁盘占用的排最后。
- **不要一次做完整份清单**。按 `## 分批计划` 的批次推进，每批独立提交、独立验证（`npm run verify` + 实机探针），完成后回来勾掉。
- 架构性差异（`GAP-A*`）是**定位不同而非缺陷**，只在明确改变产品定位时才做，不要顺手实现。

## 依据来源

| 代号 | 来源 | 说明 |
| --- | --- | --- |
| `SPEC` | `PROJECT_BETA_SPEC.md` | 本项目内部规格，五模块定义。**功能语义以 `OFFICIAL` 为准**，本文件写于官方文档细化之前。 |
| `OFFICIAL` | <https://code.claude.com/docs/en/claude-projects>（[`.md` 版](https://code.claude.com/docs/en/claude-projects.md)） | 官方 Code Projects 文档，2026-10 拉取。**这是本项目的唯一功能规格来源。** 判断「官方有没有」时直接读原文，本文件的转述可能错。 |
| `DSH` | <https://github.com/deepseek-ai/deepseek-harness> | **宿主源码**。判断「在 DSH 上能不能做到」时的唯一依据。`BOUND` 段全部、`GAP-18`（子线程问人）、`GAP-A*`（载体差异）都靠它验证。 |
| `RAG` | https://support.claude.com/en/articles/11473015-…-rag-for-projects | ❌ **不是本项目的规格来源，见下。** 仅作历史记录保留。 |

### `RAG` 那篇为什么被除名（2026-10-28 第一轮复核确认）

对 `OFFICIAL` 全文做词频核对，结果：

| 词 | 出现次数 |
| --- | --- |
| `RAG` | **0** |
| `retrieval` | **0** |
| `project knowledge` | **0** |
| `/mnt/project-files` | 1 |

`OFFICIAL` 里唯一相关的一句是把项目文件**挂载成文件夹**供线程用普通文件工具读取：

> Repositories, files, and environment | … the folders and files it can read under `/mnt/project-files`

而 `RAG` 那篇讲的是**另一个产品**，`OFFICIAL` 自己点明了这一层关系：

> **Projects in claude.ai chat and Cowork**: the **earlier Projects experience**, which groups conversations and reference files **without threads or a coordinator**.

它还有一条反证：`RAG` 称 RAG "available on paid plans: Pro, Max, Team, and Enterprise"，而 `OFFICIAL` 明写 "Projects aren't offered on Team or Enterprise plans yet" —— plan 矩阵对不上。

**结论**：我们复刻的是**有 threads 和 coordinator** 的那个 Projects，但知识机制当初抄的是**没有 threads 和 coordinator** 的那个。所有基于 `RAG` 派生的条目（阈值、模式二分、陈旧检测）在 2026-10-28 撤销并由 `GAP-22` 取代。

## 优先级总览

| 优先级 | 含义 | 条目 |
| --- | --- | --- |
| **P0** | 违背规格或官方原文 | ~~`GAP-01`~~ ✅ 已关闭 2026-10-27 |
| **P1** | 会静默产出错误结果 | ~~`GAP-23`~~ ✅ ~~`GAP-24`~~ ✅（`GAP-22` / `GAP-22a` 已关闭）—— **P1 已清空** |
| **P2** | 官方有、我们无，且多个其他能力依赖它 | ~~`GAP-03`~~ ✅ ~~`GAP-04`~~ ✅ ~~`GAP-05`~~ ✅（2026-10-29 关闭） |
| **P3** | 官方有、我们无，独立功能 | `GAP-13`（`GAP-06` / `GAP-09` / `GAP-10` / `GAP-11` / `GAP-12` / `GAP-29` 已于 2026-10-29 关闭） |
| **P4** | 项目管理类，缺了不能「管起来」 | `GAP-15` `GAP-17` `GAP-28`（`GAP-14`/`GAP-18`/`GAP-25` 已于 2026-10-29 关闭） |
| **P5** | 磁盘、性能与健壮性，不出错 | `GAP-20` `GAP-27`（`GAP-19` 已于 2026-10-29 关闭） |
| **ARCH** | 架构性差异，记录不排期 | `GAP-A1` ~ `GAP-A4` |
| **BOUND** | 有意为之的边界，非缺陷 | `BOUND-1` ~ `BOUND-4` |

---

## P0 — 违背原文（1 项）

### GAP-01 线程配额是项目级，不是用户全局级 — ✅ 已关闭（2026-10-27，commit `9c7ef10`）

- **依据**：`SPEC` 模块 A 原文「默认限制单个用户每天**在所有项目中**最多新建 200 个线程」；`OFFICIAL` L414「The enforced limit is 200 new threads per day **across your projects**」（第二轮逐字复核通过）。
- **两层语义已分清**（同一句的后半截是关键）：「a limit you ask for is a **preference rather than a cap**」—— 用户级账本是**硬限**，项目级 `dailyThreadQuotaMax` 是**偏好**。两者都保留，面板分别显示。
- **曾经的现状**：计数器落在每份 manifest 里，每个项目各记各的。三个项目各开 200 个，当天就是 600 个。
- **实现**：`src/core/quotaLedger.ts`，默认落在 `~/.dsh/dsh-newprojects/quota.json`，字段 `{ schema, day, created, byProject }`。
  - 路径可经 `EngineDeps.quotaLedgerPath`、插件配置 `quotaLedgerPath`、环境变量 `DSH_PROJECT_QUOTA_LEDGER` 改写；模块里不把 `homedir()` 固定在调用方拿不到的地方。
  - `coordinate` **先**预留全局、**后**预留项目；项目拒绝时退还全局，启动失败时两本都退。顺序是刻意的：被全局拒绝的批次不能在项目计数上留下凹痕。
  - 写入取排他锁文件并**在锁内重读**，锁超过 10 秒视为进程崩溃遗留并打破。原计划写的是「和 `ManifestStore` 同级的串行队列」——**那不够**：这个文件按定义被机器上所有项目、所有 Host 进程共享，进程内队列只能序列化从来不是问题的那批写者。
  - 坏账本／旧日账本按「今天空账本」读而不抛错：一个被截断的缓存文件不该让用户今天开不出线程。
- **验收标准达成**：
  1. ✅ 两个不同 rootDir 指向同一账本，第二个项目的计数接着第一个走（`test/engine.test.ts`「counts two projects against one user-wide ceiling」）；超限批次被拒且不消耗，逐字节比对文件（「refuses a batch the shared ceiling cannot cover, and spends nothing」）；
  2. ✅ 两个 engine 实例读写同一账本，20 个并发预留不丢计数（`test/unit/quotaLedger.test.ts`）；
  3. ✅ 翻页重置（「resets on the next calendar day」）；
  4. ✅ 单测覆盖「超限不改账」「翻页重置」，另加「项目偏好拒绝时退还全局」与「启动失败退还全局」。
- **面板**：`ProjectQuotaState.global` 新增，两个计数器各自到 80% 告警。只报项目数会让用户看不懂为什么被拒——一个项目停在 3/200 仍可能开不出线程。

---

## P1 — 会静默出错（2 项；`GAP-22` / `GAP-22a` 已于 2026-10-29 关闭）

### GAP-22 知识层应改为 paths-first（撤销 in-context / RAG 二分） — ✅ 已做（2026-10-27 `9c7ef10`，2026-10-29 `GAP-22a` 收尾）

> **本条取代 `GAP-21`（阈值写死）、`GAP-02`（陈旧检测）、`GAP-16`（自动重建时机）三条。** 它是一个减法项：做完之后那三个问题不再存在，而不是被修好。

**已完成**：第 1、5、6、7 条（减法那一半），以及第 2 条（路径锚定项目根，见 `GAP-22a`）。`grep -rn "DEFAULT_CONTEXT_BUDGET_CHARS\|knowledgeMode\|RAG_CAPACITY" src/` 为空。
**仍未完成**：第 3 条（`tree` / `read`）与第 4 条（查询时按需重建）—— 这是能力增强，已降为 P3。

**第二轮复核对第 1 条的修正——渲染的是「索引」而不是「清单」。** `OFFICIAL` L291 逐字：「Notes Claude keeps about the project … **stored as files**. Every cloud thread reads **the index file `MEMORY.md`** when it starts and **opens the other files when it needs them**」。官方开局给的是**索引**，不是路径清单。所以 charter 里每份文档一行「路径 — 字符数」：字符数是让模型能**选**的那个信息——「读那份 2 KB 的决策记录」与「读那份 400 KB 的转录」是两个不同的决定，纯路径清单分不出来。这一句同时回答了 `REVIEW-REQUEST` §7 的第二个问题（paths-first 有没有 prompt 层引导）：**有，但引导被编码在读取协议里**（索引 eager / 正文 lazy），不是 charter 里加一句话——所以「自己加一句」那个偏离不存在。

**另一条第二轮才拿到的硬数字**：`OFFICIAL` L292「Project instructions | Text sent to each new thread … **up to 16,000 characters**」。这是官方对常驻 prompt 文本唯一的明文预算。已实现为 `MAX_INSTRUCTIONS_CHARS` + `instructionsOverBudget()`，**报警不截断**（静默截断用户的 brief 是把一个静默失败换成另一个）。

**收集上限改为与官方同形的条目数**：`OFFICIAL` L339「first **100 files** up to 200 MB, without any files over 30 MB」→ `MAX_KNOWLEDGE_FILES = 100` + `MAX_KNOWLEDGE_INDEX_CHARS`，`collectKnowledge` 新增 `maxFiles`，触到任一上限时 warning **指名是哪一个**。单文件仍 2 MB，比官方的 30 MB 严，注释写明这是我们的收紧（要把正文切块存进 JSON 索引）。

**第 7 条（`inlineKnowledgeMaxChars` 默认 0）的处理**：整个注入路径删掉了，效果等于默认关闭，但**没有加这个配置旋钮**。正文不进 prompt 之后它只剩「小项目的 prefix cache 优化」一个用途；要加随时可加，别把它当成 paths-first 的一部分。

- **依据**：`OFFICIAL` 全文 `RAG` / `retrieval` / `project knowledge` 各 **0 次**，知识是「挂在 `/mnt/project-files` 下的文件夹，线程用普通文件工具自己读」。详见 `## 依据来源`。
- **现状**：
  - `src/core/knowledge.ts:32` 的 `DEFAULT_CONTEXT_BUDGET_CHARS = 96_000` 与 `knowledgeMode(totalChars, budgetChars)`（`:63`）把知识分成 `context`（全文注入 charter）与 `rag`（只给检索工具）两种模式；
  - 模式切换依赖一个与真实上下文窗口脱钩的硬编码常量；
  - 模式只由 `buildKnowledge`（`src/core/engine.ts:897`）重建，绑定的文件改了系统不知道（原 `GAP-02`）；
  - `src/core/knowledge.ts:1-19` 的模块注释把这两个模式当成官方行为**陈述**（实际来自 chat Projects），是下一个读代码的人会跟着再推一遍的错误来源。
- **已经有正确的形状**：`renderProjectCharter` 里存在一条 fallback —— 无索引但有 `knowledgePaths` 时渲染 `## Bound project knowledge` + 路径清单 + "Read these before making design decisions"（`src/core/prompt.ts:83-89`）。**这条 fallback 才是 Code Projects 的形状**，只是现在被索引注入挤成了次要路径。
- **做法**：
  1. **主路径换成路径清单**：charter 只渲染知识文件/目录清单（含一句说明「用文件工具读」），不注入正文。阈值、模式、陈旧检测随之删除。
  2. **清单里的路径必须锚定项目根目录，不能是相对线程 cwd 的相对路径。** 这是本架构特有的陷阱：线程的 cwd 是 `.dsh-project/worktrees/<threadId>`（`src/core/engine.ts:526`），而 worktree 只含 **baseCommit 里已提交的文件** —— 用户根检出里**未提交**的知识文件在 worktree 里读不到。解法：charter 里渲染能定位到项目根的形式（绝对路径，或「项目根 = <绝对路径>」+ 相对路径），并说明「知识是项目级的，读项目根，不是读你的 worktree」。
  3. **补导航能力**（这是 `OFFICIAL` 挂载模型的核心，比语义检索重要）：`project_knowledge` 工具增加 `tree`（列目录树，受深度/条数上限）与 `read`（按路径读某文件的指定行段）两个动作，让模型在检索没命中时有第二条路。
  4. **BM25 降级为便利工具，不再是「模式」**：`project_knowledge_search` 始终可用；索引在**查询时按需重建**（比对绑定路径指纹，变了就重建再检索）。工具调用本来就是写路径，允许写索引；只读入口（`knowledgeState` / `overview`）永不写盘 —— 原 `GAP-16` 的「什么时候允许自动重建」就此有答案。
  5. **删除**：`DEFAULT_CONTEXT_BUDGET_CHARS`、`knowledgeMode`、`knowledgeCapacity`、`RAG_CAPACITY_MULTIPLIER`、`KnowledgeState.mode` 的 `'context' | 'rag'` 语义（改成 `'paths' | 'inline'` 或直接去掉 mode）。
  6. **重写** `src/core/knowledge.ts:1-19` 的模块注释，明确写出：Code Projects 没有 RAG 概念，两模式来自 chat Projects，本实现采用挂载式。
  7. **全文注入作为可选优化保留**：配置项 `inlineKnowledgeMaxChars`，**默认 0（关闭）**。开启后仅在总字符数低于该值时把正文注入 charter（目的是复用 provider 端 prefix cache）。名称必须叫「inline」而不是「context 模式」，且文档写明它只是优化、不是机制。
- **要小心的**：
  - 路径清单必须**顺序稳定、无时间戳**，否则每次 charter 字节都变，prefix cache 全废；
  - 目录展开要么在 charter 里只写目录名（让线程自己 `ls`），要么写完整清单但设上限；写一半又不说上限会让模型以为看全了；
  - 别顺手把知识路径下的所有文件都纳入索引 —— 大仓库的 `node_modules` 类目录已有 `IGNORED_DIRECTORIES`（`src/core/knowledgeSource.ts`），但要确认它对新加的 `tree` 动作同样生效。
- **验收标准**：
  1. 空知识项目：charter 里没有知识段，也没有空段落；
  2. 绑定文件后：charter 出现路径清单，**不含文件正文**；二次渲染字节相同；
  3. 线程能在 worktree 里读到**根检出已提交**的知识文件（用 charter 给出的定位形式）；
  4. 改一个已绑定文件后，`project_knowledge_search` 返回新内容（按需重建生效），`knowledgeState` 不写盘；
  5. `grep -rn "DEFAULT_CONTEXT_BUDGET_CHARS\|knowledgeMode\|RAG_CAPACITY" src/` 为空；
  6. `tree` / `read` 两个动作有单测，含路径越界（`../`）拒绝。

### GAP-22a 知识路径没有锚定项目根，线程在 worktree 里解析不到 — ✅ 已做（P1，从 `GAP-22` 第 2 条拆出）

- **为什么单独拆出来**：`GAP-22` 的其余未完成项（`tree` / `read`、按需重建）是**能力增强**，这一条是**正确性**。混在一条里会让它跟着那两项一起被降级。
- **依据**：`OFFICIAL` L293 把两套路径并列写在同一行——「The **repositories every cloud thread clones**, the **folders and files it can read under `/mnt/project-files`**」。仓库是 clone，项目文件是**挂载**，而且挂载只有**一份共享的**，不是每线程一份副本。
  → 第二轮复核据此裁定：判断 I 的「让线程去读项目根的绝对路径」**更贴近官方**，**不要**往每个 worktree 复制或软链。复制会引入每线程一份副本（磁盘 × 线程数）与同步问题，而官方模型里这两个问题不存在。
- **原来的缺陷（`9c7ef10` 没有改善这一点）**：charter 的索引渲染的是 `IndexedDocument.path`，即相对项目 root 的显示路径；而线程的 cwd 是它自己的 worktree（`.dsh-project/worktrees/<threadId>`），worktree 只含 baseCommit 里**已提交**的文件。于是：
  1. 相对路径在线程里解析不到（它会相对自己的 worktree 去解）；
  2. 根检出里**未提交**的知识文件，线程无论怎么解析都读不到。
- **做法**：charter 里渲染能定位到项目根的形式——绝对路径，或「项目根 = `<绝对路径>`」+ 相对路径——并明确写一句「知识是项目级的，读项目根，不是读你的 worktree」。
- **要小心的**：绝对路径会让 charter 字节随机器变，跨机器的 prefix cache 命中因此失效。两害相权取其轻：读不到文件是**错误**，缓存未命中只是**成本**。若要兼顾，可渲染一次「项目根 = <绝对路径>」再用相对路径列文档，这样变动的只有一行。
- **实际做法（2026-10-29 落地，采用方案 A）**：
  1. `renderKnowledgeIndexSection(index, state, { boundPaths, rootDir })` 新增可选 `rootDir`；绝对路径时渲染 `Project root: \`<abs>\`` 一段，并把「相对路径按项目根解析，**不要**按你自己的 cwd 解析」写清楚，含 worktree 只含分支切点前已提交内容的解释。
  2. 只有**绝对** root 才渲染（`isAbsoluteKnowledgePath`）；相对的 root 会让每个线程解析到不同目录，比不说更糟。
  3. 只有 Windows 绝对路径才把反斜杠换成斜杠（`toDisplayPath`）：POSIX 上反斜杠是文件名的合法字符，改写会把提示指向一个不存在的文件。
  4. `CharterInput` 经 `manifest.rootDir` 传入，`renderProjectCharter` 无条件带上。
  5. `searchProjectKnowledge` 返回值新增 `rootDir`；`project_knowledge_search` 结果带 `root` 字段，hint 说明引用路径的基准是项目根。
  6. `renderThreadTask` 的 checkout 行补一句「从项目根读项目知识是预期行为，写它才不允许」——否则「don't touch the main checkout」会被谨慎的线程读成禁令，于是它干脆不读知识。
- **验收标准（全部已有测试）**：
  1. ✅ 线程在 worktree 里按 charter 给出的定位形式能读到根检出**已提交**的知识文件 —— `test/knowledge.test.ts`「lets a thread in a worktree reach every catalogued document」
  2. ✅ 未提交的知识文件有明确提示（而不是静默读不到）—— 同一条测试构造的正是「root 有、worktree 没有」的未提交状态，charter 文案解释了为什么
  3. ✅ charter 二次渲染字节相同 —— `test/unit/knowledge.test.ts`「stays byte-identical across renders with the same root」
  4. ✅ 单测覆盖「worktree cwd + charter 路径 → 命中项目根文件」—— 同第 1 条
  5. ✅ 检索结果带 root —— 「carries the root on search hits, because a citation is only usable with it」

### GAP-23 自愈计数应统计「连续失败」而不是生命周期总数 ✅ 已做

- **依据**：`OFFICIAL` 把「线程持续监视它的 PR」当成**预期成本**列出：「Threads watching a pull request: an idle thread wakes up and uses your plan again when CI fails or a review comment arrives on its pull request.」
- **原状**：`MAX_HEAL_ATTEMPTS = 3` 是**线程生命周期内的累计次数**，每轮自愈 `+1`，只有用户手动 `retry` 才清零。
- **为什么是 P1**：一个 PR 开两周、被 review 四轮、每轮都带来合理的新意见 —— 第四轮会撞上限升 `needs_feedback`，但那四轮里没有一次是「修不好」，它们是四件不同的事。**把正常的评审节奏误判成失败**，而且用户看到的提示是「修不好，需要你介入」。
- **实际做法（2026-10-29 关闭）**：
  1. `MAX_HEAL_ATTEMPTS = 3` 保留含义但改为**连续**：`src/core/healing.ts:22` 的注释改为「Consecutive rounds against an unchanged failure signature before escalating」，模块头补了为什么不是生命周期的完整理由（四周新意见 vs 三次修不好）。
  2. 新增 `failureSignature(checks)`（`src/core/healing.ts:102`）：只取**失败**项的名字、排序后 `|` 连接。空串 = 没有失败，也用作复位信号。排序让「同一组检查换了个顺序」不算新问题；加入新失败项则算新问题。
  3. `HealInput` 增加必填 `consecutiveFails`，`healAttempts` 降级为**仅展示**（`src/core/healing.ts:113-121`）。`decideHealAction` 的门槛改看 `consecutiveFails >= MAX_HEAL_ATTEMPTS`（`:191`），升级文案改为「N automatic repairs in a row left the same failure in place（M round(s) total）」，并列出仍在失败的检查名。
  4. `ProjectThreadDescriptor` 增加 `consecutiveFails` / `failureSignature`（`src/types.ts:103-113`）。`observeOne` 计算 `continuing = 失败签名非空 && 与上次相同 && 没有新评论`（`src/core/engine.ts:1148-1151`），`continuing` 才累加，否则从 0 起；heal 后写回 `consecutiveFails + 1` 与本次签名（`:1210-1212`）。`retry` 一并清零三项（`:1013-1015`）。
  5. 预算的语义仍是「最多 3 次自动修复」：0→heal(1)、1→heal(2)、2→heal(3)、3→escalate。
- **验收标准（全部已有测试）**：
  1. ✅ 失败集合变化后计数归零 —— `test/engine.test.ts` `healSweep: consecutive-failure budget` → 「resets the counter when the failure set changes」（断言 `consecutiveFails === 1`、`failureSignature === 'lint'`、`healAttempts === 3`）。
  2. ✅ 新评论到达后计数归零 —— 同组「resets the counter when a new review comment arrives」。
  3. ✅ 同一组失败连续 3 次 → `needs_feedback` 且文案含检查名 —— 「heals the same unchanged failure three times, then escalates」（断言 `feedbackPrompt` 匹配 `/same failure/`）。
  4. ✅ 四轮不同意见不会撞上限 —— 「does not escalate on a long review that keeps producing new comments」（五轮全部 heal，`consecutiveFails === 1`、`healAttempts === 5`）。
  5. ✅ 纯函数层 —— `test/unit/healing.test.ts` `failureSignature` 4 项与 `decideHealAction: consecutive-failure budget` 3 项（含「lifetime 9 但连续 0 → 仍 heal」）。

### GAP-24 `healSweep` 分不清「PR 已终局」与「GitHub 挂了」，且没有显式退订 ✅ 已做

- **原状**：
  - `healSweep` 的候选只看 `branch !== undefined && status ∈ {awaiting_review, ci_fixing, running}`，**没有「已终局」的概念**；
  - `readChecks` / `readReviewComments` 把 `gh` 失败当成 `error` 字符串返回，而 `observeOne` **从不看这个字段** —— 于是一次 401、一次限流、一个已被删除的分支，全都变成「这个 PR 没有检查也没有评论」，线程被永远安静地留在 `awaiting_review`；
  - 合并后之所以还能被扫到，是因为状态要等某次成功轮询才知道变 `merged`；而那次轮询本身往往先报错。
- **依据**：`OFFICIAL`「an idle thread wakes up … when CI fails or a review comment arrives on **its** pull request」+ 官方的止损手段是显式退订：「**To stop that, ask in the thread for it to stop watching the pull request.**」
- **实际做法（2026-10-29 关闭）**：
  1. 新增纯函数 `classifyGhFailure(message)`（`src/core/vcs.ts:200-247`），三档：`benign`（没配 CI / 还没跑，「no checks reported」）、`retryable`（401/403/429/5xx、限流、超时、DNS、网络）、`terminal`（PR 不存在、分支/仓库不存在、404、no commits between）。**未识别的消息默认 `retryable`**，理由写进代码：悄悄退订一个从未见过的失败会永久失去监视，重试是可恢复的错误。
  2. `observeOne` 收集 `checks.error` / `inline.error` / `verdicts.error`（`src/core/engine.ts:1120-1145`）：`terminal` → `settleUnreachable`；`retryable` → 抛 `ProjectError('VCS_FAILED', ...)` 进 `result.errors`；只有 `benign` 才继续走判定。
  3. 新增 `settleUnreachable`（`:1070-1100`）：先按编号重读一次 PR 终态 —— `merged` → `completed`、`closed` → `failed`（并记 `lastError`），**都自动退订**；读不出来（`unknown`）则升 `needs_feedback` 并把原始消息写进问题，同时退订，文案提示可用 `watch` 恢复。不猜 `merged`：猜对了省一次询问，猜错了把「仓库挂了」报成「已完成」。
  4. `ProjectThreadDescriptor.unwatchAt`（`src/types.ts:114-120`）；`healSweep` 候选增加 `unwatchAt === undefined`（`src/core/engine.ts:1042`）；`transition`（merged/closed）写入 `unwatchAt`（`:1177-1184`）。
  5. 动作层：`ThreadAction` 增加 `watch` / `unwatch`（`src/core/engine.ts:172`），`manageThread` 实现（`:1025-1045`，`watch` 同时把 `consecutiveFails` 归零）；`project_thread_manage` 的 enum 与描述同步（`src/host/tools.ts:263`）；`/project thread <id> unwatch|watch` 可用，且命令层现在**先校验动词**再派发（`src/host/commands.ts:44-48`、`:236-240`）—— 之前未知动词会穿过 `as` 断言进到没有 `default` 的 switch，调用方随后解引用 `undefined`。
- **验收标准（全部已有测试）**：
  1. ✅ 合并 + 分支删除后不报 error 且转终态 —— `test/engine.test.ts` `healSweep: unreachable pull requests` → 「settles a thread whose branch was deleted after the PR merged」（`errors` 为空、`settled` 1、`status === 'completed'`、`unwatchAt` 已设）。
  2. ✅ 网络/认证失败仍报 error 且不改变状态、不退订 —— 同组「reports an authentication failure instead of reading it as a quiet pull request」。
  3. ✅ 终态读不出来时提问而不猜测 —— 「asks rather than guessing when the pull request is gone and its state is unreadable」。
  4. ✅ 退订后不再访问该 PR —— `healSweep: manual subscription` → 「stops polling after `unwatch` and resumes after `watch`」（`observed === 0`，恢复后 `observed === 1` 且 runner 见到 `gh pr checks`）。
  5. ✅ 退订后 `settled` 线程下一轮不再被扫 —— 见验收 1 的第二段断言（`second.observed === 0`）。
  6. ✅ 分类器本身 —— `test/unit/ghFailures.test.ts`（8 项，覆盖 deleted branch / 404 / 无 token / 限流 / DNS 超时 / 无 CI / 未识别消息）。

---

## P2 — 官方有且被多项依赖（3 项）

### GAP-03 没有会话投影（sessionProjections）✅ 已做

- **依据**：`SPEC` 模块 E「基于 DSH 的 `ctx.projection` 与 `/project` 命令平面」；`OFFICIAL` 的 Overview 面板与线程卡片要求随会话实时更新。
- **现状**：`sessionProjections.register` **一行都没写**（`grep -rn projection src/index.ts src/host/*.ts` 返回空）。目前只有 `project_overview` 工具与 `/project` 命令这两种**主动拉取**的表面。
- **不再被 `GAP-04` 阻塞**（2026-10-28 修正）：原判断「投影的 `stateSchema` 由状态枚举决定，所以必须先定状态模型」**不成立**。`bucketOf`（`src/core/overview.ts:41`）已经是现成的 `state → bucket` 派生函数，投影暴露的是**桶**而不是枚举；后加 `landing`/`idle`/`resolved` 只改 `bucketOf` 的 case，`stateSchema` 不变。**因此 `GAP-03` 与 `GAP-04` 可以同批做，不必串行两批。**
- **要修的文档**：`README.md` 曾写「Host-only 会话投影保持面板随会话事件更新」，**那句是虚的**，已在文档对齐时改成事实陈述。
- **做法**：`ProjectionDefinition` 需要 `key` / `stateSchema`（Zod）/ `init(header, inheritedEventCount)` / `apply(state, event)` / `stateVersion`。关键约束：
  - `apply` 必须是**纯函数**（不得读文件、不得发命令），它对每个会话事件同步执行。所以投影里只能放「已算好的摘要」，不能在里面查 manifest。
  - 线程状态变化的来源是 `agent` 层 turn 结束与 `healSweep` 的写入，这些要主动 `append` 事件到会话，投影才能看见。**目前这些状态只写进 manifest 文件，没有写进会话事件流** —— 这是本项真正的工作量，不是写个 reducer 就完。
- **验收标准**：
  1. 注册后 `/project init` + `coordinate` 能在会话快照里看到线程摘要，且不需要用户敲命令；
  2. 线程 turn 结束后快照里的状态随之改变；
  3. 插件 dispose 后该 projection key 消失（无残留）；
  4. 单测覆盖 `apply` 的纯函数性质（同事件序列产出同状态）。

- **实际做法（2026-10-29 落地）**：
  1. 新事件类型 `PROJECT_STATE_EVENT = 'project-beta/state'`，载荷 `{ snapshot }`；一次写入一条完整快照（不做增量 diff —— 快照小，diff 会让 reducer 承担合并逻辑，而合并逻辑恰恰是要测的那部分）。
  2. `src/core/projectState.ts` 是纯逻辑：`buildProjectState(overview, at, extra?)` 是**唯一生产者**，`applyProjectState(state, event)` 是**纯全函数**——不是本事件类型就**返回同一个对象**（Host 给每个事件缓存 reducer 输出，每次 turn 事件都新分配会让面板缓存持续失效）。
  3. `src/host/projections.ts` 用 `zod` 写 schema 并返回 `ProjectionDefinition`；`src/index.ts` 在 `ctx.inject(['sessionProjections','sessions'])` 里注册，并把 `runtime.setPublisher` 接到 `sessions.get(id)?.append(...)`。卸载时**先注销投影、再清空 publisher**：向没有投影的会话追加事件会留下永远读不掉的会话事件。
  4. 写入点收敛在 `updateThread`（所有 descriptor 变更的唯一漏斗）末尾 `void this.publishState()`；`noteCaller(parent)` 在 `coordinate` / `startSuggested` / `manageThread` / `healSweep` / `setMemory` 首行记录协调者会话。发布是 fire-and-forget：面板更新失败绝不能把产生它的写入一起失败。
  5. 快照按桶截断到 `MAX_THREADS_PER_BUCKET = 20` 并把溢出数记在 `truncated` —— 面板显示「19 个线程」而实际有 40 个，比显示 20/40 更糟。
  6. 新依赖 `zod`（Host 自带的在 asar 内，外部插件必须自带）。
- **验收（全部有测试）**：注册后无需敲命令即可在会话快照里看到线程摘要（`test/unit/projectState.test.ts` 的 `buildProjectState` 组）；turn 结束后状态随之改变（`test/engine.test.ts` 的 `state publishing` 组）；`apply` 纯函数性（同事件序列同状态 + 非本类事件返回同一引用）；dispose 后 key 消失（`src/index.ts` 的 effect 清理；实机探针确认 `registered projection keys` 含 `projectBeta`）。

### GAP-04 Overview 只有五桶，官方是六组 ✅ 已做

- **依据**：`OFFICIAL`「The pane's **Threads** tab **groups threads by state**」+ 六分组表：**Ready for review**（PR open awaiting review）/ **Waiting on you**（"need your reply or approval, **or that failed**"）/ **Working**（"still running"）/ **Landing**（"approved or **queued to merge**"）/ **Idle**（"finished and **aren't waiting on anything**"）/ **Resolved**（"marked done: by you, by Claude once you've taken the last step, or **automatically after a week with no activity**"，可 reopen）。
- **现状**：`OverviewBucket`（`src/types.ts:23`）= `completed | awaiting_review | waiting_for_feedback | running | failed`（5 项）；`bucketOf`（`src/core/overview.ts:41`）把 `queued|running|ci_fixing` 归 `running`、`completed` 归 `completed`、`failed` 归 `failed`（单独一桶）。
- **两个具体错误**：
  1. **`failed` 单列一桶**是错的。官方把它放进 `Waiting on you`（"or that failed"），也就是**同一个桶**。现在「有 3 个失败」和「有 2 个等你」被拆成两处，正是原文档里那个「用户要看两个地方」抱怨的真实成因。
  2. **`completed` 混了两种语义**：`Idle`（"finished and aren't waiting on anything"）与 `Resolved`（人已确认/PR 已合/一周无活动）。前者是**活的**状态，后者是**终态标记且可重开**。
- **缺失三个语义**：`Landing`（数据已读进来但无状态表达）、`Idle`、`Resolved`。
- **做法（这是加法，不是重构 —— 2026-10-28 修正原判断）**：
  1. `ThreadStatus` 增加 `landing`；`completed` 拆成 `idle` + `resolved`（或保留 `completed` 作为 `idle` 的别名并新增 `resolved`，避免动落盘数据）；
  2. `bucketOf` 改两处：`failed` 并入 `waiting_for_feedback`；新增 `landing` / `idle` / `resolved` 的 case；
  3. `BUCKET_ORDER` / `BUCKET_LABELS` 各增两项、删 `failed` 一项；`totals.failed` 改成**按 status 数**而不是按桶数（桶里已经混了 `needs_feedback`）。
  - 预期量：**二十行以内**。`stateVersion` 不需要升，落盘数据不需要迁移，测试只动数桶的那几条。
- **互斥性已裁定（第二轮复核，`docs/REVIEW-RESPONSE-2.md` §问题一）**：✅ 互斥，不要改成多维标签。根据是「groups threads by **state**」——分组是 state 的投影，一个线程一个桶。
  - 你们问的那个具体线程（「PR 开着、CI 绿、等 reviewer」）落 **`Ready for review`**。两条理由都在原文里：`Waiting on you` 的 "approval" 指**权限审批**而不是 PR approval（`OFFICIAL` L247-251 有专节）；而且它写的是 "need **your** reply or approval"，而 reviewer 不必是项目所有者。
  - 让六条定义彼此排开的是 `Idle` 的 "finished and **aren't waiting on anything**"——一条排除子句就把它和三个「在等」的组隔开。
- **`bucketOf` 必须写成带优先级的映射，不是一张平的映射表**：

  ```
  human-blocking（needs_feedback / failed / 等权限审批）
    > PR 生命周期位置（landing > awaiting_review）
    > 运行中（working）
    > 终态（idle > resolved）
  ```

  **为什么人阻塞必须优先**：一个线程可以同时「PR 开着等 review」和「在线程内卡住等权限审批」，两条定义同真，官方表格没裁定。但 Overview 的定义裁定了——`OFFICIAL` L193「the **Overview** button … **shows a dot when a thread is waiting on you**」。若这种线程归进 `Ready for review`，点不亮；而官方明说「Telling Claude in the project conversation to go ahead **doesn't reach it**」，于是没人会去解锁它——线程永久卡死，面板显示一切正常。按平表写就会掉进这个坑。
  - 更弱的一个碰撞：GitHub 上 PR 可被一人 approve 而仍等另一人，`approved` 与 `awaiting review` 同真。建议取 `Landing`，并在 `bucketOf` 注释里写明这是**我们的裁定**而非原文。
- **要小心的**：`isActiveStatus`（`src/core/overview.ts`）当前是 `['queued','running','ci_fixing']`。`landing` 加进来后**不应**算作 active（球已经踢出去了），但**必须**仍在 `healSweep` 候选里以便发现合并完成。这两个判断现在写在不同地方，容易漏一个。
- **验收标准**：
  1. 六个分组与官方命名一一对应（键名对应，中文文案自行决定）；
  2. 一个线程恰好出现在一个桶里 —— 互斥性要有断言，不能只在实现里成立；
  3. `failed` 不再单独成桶，"or that failed" 的合并语义有测试断言；
  4. 同时命中「等权限审批」与「PR 等 review」的线程落在 `Waiting on you`，且 Overview 的「有你的事」信号为真；
  5. `Resolved` 的线程不再进入 `healSweep` 候选，且可被重新打开；
  6. 旧的五桶断言全部更新，不允许留双重语义。

- **实际做法（2026-10-29 落地）**：
  1. `ThreadStatus` 增 `landing` 与 `resolved`；`completed` 保留为 Idle 的名字（已在磁盘上，改名没有收益，只改标签）。
  2. `OverviewBucket` 换成官方六个键：`ready_for_review | waiting_on_you | working | landing | idle | resolved`；`BUCKET_ORDER` 按官方顺序。
  3. `bucketOf` 写成**带优先级**的 switch：`needs_feedback | failed → waiting_on_you` > `landing → landing` > `awaiting_review → ready_for_review` > `queued | running | ci_fixing → working` > `completed → idle` > `resolved → resolved`。注释里写明「`landing > ready_for_review` 是我们的裁定」。
  4. `totals` 改为 `{threads, active, waitingOnYou, resolved, needsAttention}`；`needsAttention` 就是 Overview 那个「有你的事」的点，定义是 `waiting_on_you` 非空。
  5. `isActiveStatus` 保持只认 `queued | running | ci_fixing`（`landing` 球已踢出，`resolved` 终态），但 `healSweep` 候选集**加入** `landing` —— 只有持续看才能发现「排队合并」完成。
  6. 实际改动量：`src/types.ts` + `src/core/overview.ts` + `src/core/engine.ts` + 三处 host 适配 + 两处测试，**约 120 行**（原估「二十行以内」偏乐观：把它当纯映射，漏算了 totals、隐藏逻辑与 healSweep 联动）。
- **验收（全部有测试）**：六组一对一（`test/unit/overview.test.ts` 的 `follows the official six names one-to-one`）；互斥性（`puts every thread in exactly one bucket`，含 7 个状态）；`failed` 并入 `waiting_on_you`（`puts a failure in Waiting on you`）；人阻塞优先于 PR 生命周期（`gives the human-blocking group priority over the PR lifecycle`）；`resolved` 不进 `healSweep` 且可重开（`test/engine.test.ts`）；旧五桶断言已全部替换（无双重语义）。

### GAP-05 线程没有终态与归档 ✅ 已做

- **依据**：`OFFICIAL`「**Resolved**: …marked done: by you from the thread's menu, by Claude once you've taken the last step, such as merging its pull request, or automatically after a week with no activity. **You can reopen one from the same menu**」。
- **现状**：`manifest.threads` **只增不减**，`grep "delete draft.threads"` 返回空。没有任何状态表达「这个线程结束了，别再管它」，因此 `healSweep` 只能靠「状态不在候选集」隐式停止。
- **三个入口要分清**（2026-10-28 明确）：
  - 人工：用户从菜单标记（对应 `close` 动作）；
  - 自动 1：合并后由协调者标记（`decideHealAction` 的 `prState === 'merged'` 分支已有，`src/core/healing.ts:153-154`）；
  - 自动 2：**一周无活动**。这是**所有状态**的兜底，不是从 `Idle` 出发的转移。
- **「无活动」的定义**：任何 turn 都算活动，**PR 事件也算**（CI 失败 / 新评论会唤醒线程起一个 turn）。所以不必给「PR 还开着等 review」加特例 —— 真正一周零活动的 PR 是谁都没碰过的 PR。
- **做法**：
  1. 复用 `GAP-04` 的 `resolved` 状态（**不要**新造 `archivedAt` 这一套平行概念，会和状态机打架）；
  2. `updatedAt` 超阈值自动转 `resolved`，摘要写进 `note` 说明是自动的；
  3. **自动转 `resolved` 不得停止 PR 监视的清理逻辑本身**，但要按 `GAP-24` 退订（不再唤醒）；若之后 PR 有新事件，允许 reopen；
  4. `overview` 默认不列 `resolved`，加 `/project threads --all` 与 `/project reopen <id>`。
- **验收标准**：
  1. 超阈值的线程获得 `resolved` 且 `note` 说明原因；
  2. 默认 overview 不显示已 resolved 线程，但数据仍在 manifest 里；
  3. 已 resolved 的线程不被 `healSweep` 唤醒，可手动 reopen；
  4. 三个入口都有测试。

- **实际做法（2026-10-29 落地）**：
  1. 复用 `resolved`，不新造 `archivedAt`；`close` 改为写 `resolved`（原来写 `completed` —— 用户关掉的线程不是「做完了」）。
  2. 新增 `reopen`：有 PR 回 `awaiting_review`，否则回 `completed`（没有 PR 就没有 reviewer 可等）。
  3. 一周无活动：`RESOLVE_AFTER_MS = 7 天` + `dueForResolve(thread, nowMs)`（`resolved` 自身返回 false）；由 `healSweep` 开头调 `autoResolveIdle(now)`，`note` 写明「resolved automatically after N day(s) without activity」，`HealSweepResult.resolved` 报数量。
  4. `buildOverview(..., { includeResolved })` 默认隐藏 `resolved`，但 `totals.resolved` 统计全部；markdown 追加「N hidden；`/project threads --all`」。
  5. `/project threads --all` 与 `/project reopen <id>` 已接；`project_thread_manage` 的 action 白名单补 `reopen`（顺带修掉 `watch` / `unwatch` 在 enum 里却没接进分派的真实缺陷）。
- **三个入口都有测试**：人工 close（`closes a thread without pretending it succeeded`）；PR 合并自动（`test/unit/healing.test.ts` 的 merged 分支 + `test/integration/flow.test.ts` 全链路）；一周无活动（`resolves a silent thread after a week and says why`）。另有 `hides resolved threads by default and shows them on request` 与 `says how many resolved threads it is hiding`。

---

## P3 — 官方有、我们无（独立功能）

### GAP-06 项目没有持久化的 goal —— ✅ 已做

- **依据**：`OFFICIAL`「**Goal** (optional): one line of what you're trying to get done… Without a goal, Claude works from the tasks you send, and you can add a goal later in **Project settings > General**」，且「Claude in the conversation **works toward it**」。
- **现状**：`goal` 只是 `coordinate` 的入参字符串（`src/core/engine.ts:402`），**不落盘**。`grep -c goal src/types.ts` = **0**。
- **注意**：它不只是元数据，**参与协调决策** —— 装配 charter 时要有它，拆解时也要参考它。
- **做法**：`ProjectManifest` 加 `goal?: string`；`init` 接受 goal；`charter` 渲染；`/project goal <text>` 修改；`project_overview` 返回。
- **验收标准**：
  1. `init` 带 goal 后落盘、跨进程读回；
  2. charter 含 goal，goal 不变时 charter 字节不变（不破坏 prefix cache）；
  3. 无 goal 时不渲染空段落。

**实际做法（2026-10-29 落地）**：

1. `ProjectManifest` 新增 `goal?: string`（`src/types.ts`）；`init()` 接受 `goal`，`setGoal()` 负责改与清，`normaliseGoal()` 折成一行并截到 `MAX_GOAL_CHARS = 280`。
2. goal 进共享 charter（`renderGoalSection`，位于标题之下、记忆之上）。**它是前缀的一部分**，所以 `setGoal` 变更时 `prefixVersion += 1`——假装它不影响前缀会让面板报出一个过期的 fingerprint。
3. `/project goal` 读、`/project goal <text>` 写、`/project goal clear` 清；`project_overview` 的 JSON 与 markdown 面板都带 `goal`。
4. 没有 goal 时**整段不渲染**（不是空标题），`describeGoal` 也返回 `undefined`。

**验收（全部有测试）**：`persists a goal given at init and reads it back from another engine`（换 engine 读回）、`renders the goal into the charter and leaves it out when unset`、`keeps the charter byte-identical when only recent messages change`、`prints the goal exactly once in the markdown panel`（防重复行回归）、`test/unit/coordState.test.ts` 的 `normaliseGoal` / `renderGoalSection` 组。
### GAP-09 不读仓库里的 CLAUDE.md / .claude/rules/ —— ✅ 已做

- **依据**：`OFFICIAL`「`CLAUDE.md`, `.claude/CLAUDE.md`, and `.claude/rules/` at the **repository root** — Loaded from every repository when the thread starts」，且「Permission rules in `.claude/settings.json` | **Not applied**」。
- **现状**：charter 只读自己的 `.dsh-project/PROJECT_INSTRUCTIONS.md`（路径在 `src/core/engine.ts:218`，读取在 `:362`）。
- **边界必须照抄官方，否则会做多**：只读**仓库根**的这三个位置。**不读**子目录的 `CLAUDE.md`、**不读** path-specific rules、**不读** `.claude/settings.json` 的权限规则。我们在本地能读全盘，顺手把子目录也读了会让 charter 随检出内容膨胀，直接冲突 prefix cache 目标。
- **做法**：`renderProjectCharter` 的输入加「仓库约定」来源，按 `CLAUDE.md` → `.claude/CLAUDE.md` → `.claude/rules/*.md` 顺序收集（存在才读）。**顺序固定、无时间戳**，保持前缀稳定。
- **验收标准**：
  1. 仓库根有 `CLAUDE.md` 时 charter 包含它；
  2. 多来源按固定顺序合并，同内容多次渲染字节相同；
  3. 文件不存在时静默跳过，不产生空段落；
  4. **子目录的 `CLAUDE.md` 不被读取**（有测试断言）。

**实际做法（2026-10-29 落地）**：

1. 新模块 `src/core/conventions.ts`：`collectConventions(rootDir)` 按 `CLAUDE.md` → `.claude/CLAUDE.md` → `.claude/rules/*.md`（按文件名排序）收集，**只读仓库根**。
2. `conventionsStamp(rootDir)` 用「大小 + mtime」拼一个戳，`engine.conventions()` 用它做缓存：仓库没变时零读盘，`CLAUDE.md` 改了下一个 render 就能看到——不需要文件监听。
3. 渲染成 `## Repository conventions`，每个文件一个 `### <相对路径>` 小节，紧邻 project instructions（两者都是用户写的作业方式，不是作业内容）。
4. 总预算 `MAX_CONVENTIONS_CHARS = 16_000`，超出**截断并记 warning**（不静默丢尾部）。读不到的文件静默跳过；权限错误进 warning 但不影响 charter 生成。
5. **不读**子目录 `CLAUDE.md`、path-specific rules、`.claude/settings.json` 的权限规则（官方明确 "Not applied"）。多读会让前缀随检出膨胀，直接冲掉前缀缓存。

**验收（全部有测试）**：`test/unit/conventions.test.ts` 14 项（顺序、排序、忽略子目录、BOM 剥离、截断与警告、预算耗尽不再读、stamp 变化/稳定）；`test/engine.test.ts` 的 `repository conventions` 组 5 项（进 charter、忽略子目录、改文件下一轮生效、rules 排序、未变时字节稳定）。
### GAP-10 没有 Library（线程产出文件）—— ✅ 已做

- **依据**：`OFFICIAL`「**Library**: the files **and folders** you added and the files threads produced」；非代码项目「threads deliver each write-up **as a file** on the project's Library tab」。
- **现状**：只收集用户绑定的知识路径。**线程产出的文件完全不收集**，只留在 `.dsh-project/worktrees/<threadId>`，worktree 一回收就没了。
- **关键认知（本轮修正，从「中」降为「小」）**：官方云端必须拷贝文件，因为沙箱会消失（「If the sandbox can't be resumed, the thread continues from a fresh clone, so uncommitted changes can be lost」）。**我们在本地没有这个约束 —— 文件就在盘上**。所以 Library = 一份清单 + 按需读取，**不是新的存储层**。
- **做法**：`deliverThread`（`src/core/engine.ts:1071`）记录 `git diff --name-status <base>..<branch>` 的文件清单进 descriptor；`overviewJson()` 汇总去重后返回；读取时按 `worktreePath` + 路径直接读盘。清单是元数据，worktree 删除后仍在（配合 `GAP-19`）。
- **要小心的**：只记 `name-status` 不够 —— 用户想知道「这个文件是什么」。`read` 动作要能按需读内容，且**文件已被删时如实报「已不可读」**，不要显示空内容。
- **验收标准**：
  1. `deliverThread` 后 descriptor 有产出清单（含变更类型 A/M/D）；
  2. overview 汇总去重；
  3. worktree 删除后清单仍在，读取时明确报不可读；
  4. 非代码产出（文档类）同样进清单。

**实际做法（2026-10-29 落地）**：

1. 新模块 `src/core/library.ts`（纯逻辑，唯一碰盘的函数是 `readOutput`）：`parseNameStatus` 把 `git diff --name-status` 转成 `{path, change}`；`aggregateLibrary` 按 path 去重、合并 `threads`、变更类型取强（`added > modified > deleted`，某分支上仍存在就不算删除）。
2. `src/core/vcs.ts` 新增 `readChangedFiles(runner, cwd, from, to)`，用 `git diff --name-status --no-renames <base>..<branch>`；**故意关掉重命名检测** —— 重命名显示为「删除 + 新增」，用户要的旧路径不会消失。非零退出返回 `undefined`，调用方保留上一次观察（「没能查」不等于「没变化」）。
3. `deliverThread` 在提交前后各记一次（含 `git status --porcelain` 为空的早退路径），因为线程可能在自己的回合里已经提交过。
4. `engine.library()` 汇总；`buildOverview` 用 **全部线程（含 resolved）** 聚合 —— resolved 只是把人从面板上挪开，不是把工作结果抹掉。
5. 新增第 7 个工具 `project_library`（`list` / `read`）与 `/project library [read <path>]`。
6. **`readOutput` 拒绝越权路径**：`resolve` 后做包含性校验，`../..` 无法爬到项目根之外（路径来自模型或命令行，不能信）。

**验收（全部有测试）**：

1. ✅ `deliverThread` 后 descriptor 有清单且含 `added`/`modified` —— `test/engine.test.ts`「records what the branch changed when the thread delivers」；
2. ✅ overview 去重合并 —— `test/unit/overview.test.ts`「aggregates the files two threads produced into one row each」；
3. ✅ worktree 不在时清单仍在、读取明确报 `not on disk` —— `test/engine.test.ts`「says a reclaimed worktree is unreadable instead of returning an empty file」；
4. ✅ 非代码产出同样进清单（`parseNameStatus` 与路径无关）—— `test/unit/library.test.ts`；
5. ✅ 空库不假装有内容 —— `test/tools.test.ts`「says the library is empty rather than pretending the tool failed」。

### GAP-11 没有 Pull requests 聚合视图 —— ✅ 已做

- **依据**：`OFFICIAL`「**Pull requests**: shown once threads have opened any」。
- **现状**：每线程一个 `prOrDeliverableRef` 字符串，没有聚合。
- **做法**：`overviewJson()` 加 `pullRequests`，从各 descriptor 的 `review` 快照提取；带 `state` / checks 摘要 / `url` / `threadId`。
- **验收标准**：有 PR 的线程出现在聚合里并按状态分组；无 PR 时**不返回该字段**（不要返回空数组假装有）。

**实际做法（2026-10-29 落地）**：`src/core/overview.ts` 新增 `collectPullRequests(threads)`，按 `review.state` 分组（固定顺序 open → draft → merged → closed → unknown，组内按 threadId 排序），每行带 `threadId` / `title` / `prRef` / `url?` / `checks{total,passing,failing,pending}` / `newComments`（未消费的审查评论数）/ `observedAt`。**全部线程参与，含 resolved**：合掉的 PR 仍是这个项目的历史。

要小心的一点：checks 与 state 都是**上一次自愈轮观察到的快照**，不是实时 GitHub 数据。面板自己不去查 GitHub —— 那会在每次渲染时花掉用户的 API 配额，而自愈器本来就在轮询。

**验收（全部有测试）**：✅ 按状态分组、计数正确 —— `test/unit/overview.test.ts`「groups pull requests by state and tallies their checks」；✅ 无 PR 时字段不出现 —— 同文件「stays absent until a thread produces something」；✅ 空状态组不出现 —— 「omits a state group no thread is in」。

### GAP-12 线程卡片动作缺 Merge it / Resolve conflicts / Review PR — ✅ 已做

- **依据**：`OFFICIAL` 卡片动作六个，且**执行者分两类**：
  > **Resolve conflicts**, **Fix CI**, **Address comments**, and **Merge it** send that instruction to the thread **as a message from you**, so you can prompt the thread yourself instead of waiting for it to react to the pull request.
  >
  > **Create PR** … creates the pull request from that branch **directly rather than sending the thread an instruction** to open one.
- **现状对照**：`ThreadAction`（`src/core/engine.ts:125`）= `inspect | steer | respond | interrupt | retry | close`；工具侧 enum（`src/host/tools.ts:233`）多 `deliver | heal`。
  - `Fix CI` / `Address comments` → `heal` 覆盖（自动判定修哪类）；
  - `Create PR` → `deliver` 覆盖（**恰好是唯一宿主直办的那个，方向对了**）；
  - **`Merge it` → 缺**。⚠️ **必须发消息给线程，不要让宿主代跑 `gh pr merge`。** 理由不是形式，是责任链：线程才知道自己的 PR 现在什么状态、要不要先 rebase、合完要不要清理。照着 `deliver` 的样子写就会做错。
  - **`Resolve conflicts` → 缺**。本质是「把目标分支合进线程分支 + 解冲突 + push」，用现有 `resume` 实现，但需要独立 prompt 模板（`buildHealPrompt` 不能复用 —— 它讲的是 CI 失败与评审意见）。
  - **`Review PR` → 缺**。要求把 PR URL 传回会话让前端可点；投影（`GAP-03`）做好后才有真正落点。
- **验收标准**：
  1. `merge` 通过**发消息**给线程执行（断言 `threads.resumes` 收到消息、且宿主没有直接跑 `gh pr merge`）；
  2. `conflicts` 唤醒线程并把冲突文件清单交给它；
  3. `review` 返回可点击的 URL；
  4. 三者都有成功与失败路径的单测。

**实际做法（2026-10-29 落地）**：三个动作加进 `ThreadAction`（`src/core/engine.ts`），命令与工具的白名单同步。

- **`merge`** —— 宿主**不跑** `gh pr merge`，只用 `threads.resume` 给线程发 `renderMergeRequest`，并把状态置 `landing`。prompt 要求线程先自查可合并性（checks 绿、无冲突、评审要求满足），落后就先更新分支再合，合完报告 merge commit 与待清理项。
  为什么不让宿主代跑：线程才知道自己那条分支要不要先 rebase、合完该清理什么。宿主代跑会在一个线程仍以为「等评审」的分支上宣告成功，而 `landing` 这个状态就再也回不到真相。
- **`conflicts`** —— 先把 PR 的 base 分支读出来（`gh pr view <n> --json baseRefName`），再算**两侧各自相对 merge-base 改过的文件**取交集，作为「候选冲突点」交给 `renderConflictRequest`。状态置 `running`。
  候选而不是定论：git 只有在真正尝试 merge 时才知道哪些文件真冲突。交集为空时**只省略文件清单、保留指令** —— 列一个零文件清单会读成「已经查过，没事」。
- **`review`** —— 返回 PR URL，**不唤醒线程**。官方卡片里 Review PR 是人点开去看，不是给线程下指令；发一条消息会白烧一轮的 token。CLI 里输出即链接，面板里由 `GAP-03` 的投影带出 `pr` 字段。
- 三者都在没有 PR 时以 `INVALID_INPUT` 拒绝（`merge` / `conflicts` 还要求线程带分支），而不是静默成功。

**验收（全部有测试）**：✅ `merge` 走消息且宿主没有 `gh pr merge` —— `test/engine.test.ts`「asks the thread to merge instead of merging behind its back」；✅ `conflicts` 把交集交给线程、非交集文件不出现 —— 「hands the thread the likely conflict sites and the base branch」；✅ 交集为空仍发指令 —— 「still asks the thread to fetch and inspect when nothing overlaps」；✅ `review` 返回 URL 且不唤醒 —— 「answers review with the link and spends no thread turn」；✅ 三者的失败路径 —— 三条「refuses ... without a pull request」。

### GAP-13 没有 Usage（token 用量）

- **依据**：`OFFICIAL`「Open **Usage** in **Project settings** to see token use by thread and by model, and how much went to the project conversation.」
- **现状**：完全没有。Host 有 `tokenMeter` 服务但未接入（`grep -rn tokenMeter src/` 返回空）。
- **做法**：读 Host `tokenMeter` 按线程归集；`overviewJson()` 加 `usage`。**如果 `tokenMeter` 只能给全局数字，就明确标注「本项目无法按线程拆分」，不要造假的分布。**
- **验收标准**：能看到按线程用量；拿不到精确数据时如实显示「不可用」而不是 0。

### GAP-26 拆解应模型优先，并把「先提议后启动」与它一起做 ✅ 已做

- **依据**：
  - `OFFICIAL`「Claude acts as coordinator. It takes what you send, decides what becomes a thread」；
  - 「Sometimes Claude **proposes** threads instead of starting them, in a **Suggested threads** list. Click the arrow on a suggestion to start that thread. … a button under the list starts all of them.」—— 确定性文本分析不会 "propose"；
  - 路由规则一「**A quick question usually gets an answer in the conversation**」**要求**判断「这是问题还是活」，正则做不了；
  - 官方首批建议第 4 条：「Propose threads **and wait for my go-ahead** before starting them, and drop those limits once a few threads come back the way you want」。
- **现状（2026-10-29 已落地）**：见下方「实际做法」。

#### 实际做法（2026-10-29）

**1. 「模型优先」的实现方式：由协调者自己给计划，而不是在工具里调模型**

原验收标准写的是「有模型时由模型产出计划（可用 fake provider 测）」，暗示在 `coordinate` 内部调一次模型。**这条路走错了**：DSH 里**协调者本身就是那个模型**（根会话在调用 `project_coordinate` 工具），工具内再调一次模型是嵌套委派——多花一次 token、多一层失败点，而且拿不到用户在对话里的上下文（用户刚说「只改前端」，工具里的模型不知道）。

正确的落法是**计划从参数进来**：`project_coordinate` 接受 `tasks: [{ title, objective, scopeHint? }]`，`normaliseTasks`（`src/core/planner.ts`）只做校验与截断（缺 objective 用 title 顶、超长截 80、去重、上限 `MAX_PLANNED_TASKS = 8`）。模型给计划就是**决定**，直接启动；模型没给（或被 route 掉）才走 `planTasks` 的确定性兜底，而那一路的输出是**提议**。

**2. 降级必须可见**

`resolvePlan`（`src/core/engine.ts:583`）返回 `{ tasks, origin: 'model' | 'fallback', note? }`，fallback 时 `note` 用调用方的单位解释降级：
`no task list was supplied, so the goal was split by its bullet markers (3 tasks). This is a deterministic guess, not a model decision — check the titles before accepting them.`
`CoordinateResult.planOrigin` / `planNote` 原样透传到工具结果与 `/project coordinate` 输出。

**3. Suggested threads：默认提议**

- `planOnly` 默认值 = `origin === 'fallback'`（`src/core/engine.ts:468`）。模型自己给的计划直接起，猜出来的计划先提议 —— 这是「猜测需要确认、决定不需要」的同一原则。
- 计划存进 `ProjectManifest.plan: ProjectPlan`（`plannedAt` / `origin` / `note?` / `tasks`），只有一份，对齐官方单一 **Suggested threads** 列表。
- 启动：`startSuggested(parent, { indices?, limit? })`（`src/core/engine.ts:627`）—— 全部、按序号子集、或带 limit；启动成功的任务离开计划，**失败的留在计划里可重试**；释放未用掉的配额预约（本地账本 + 全局账本两处都退）。
- 丢弃：`discardSuggested()`；`/project drop`。
- 过期：`PLAN_TTL_MS = 24h`（`src/core/planner.ts`）。**过期是读时报告、写时执行**：`pendingPlan()` 只返回 `{ expired }` 不动记录（否则面板每次渲染都会 bump revision 并和其他写入打架），真正清除发生在下一次 `startSuggested` / `discardSuggested`。
- 面板：`ProjectOverview.suggested?: SuggestedPlanView`（含 `expired`），`renderOverviewMarkdown` 单列一节；过期时文案为 `## Suggested threads (stale, dropped on next run)` 且不再给启动指引。

**4. 命令与工具**

- `/project coordinate <goal>` 现在**只提议**（命令路径没有模型，必然是 fallback），输出 `nothing started. \`/project start\` for all, \`/project start 1 3\` for some, \`/project drop\` to discard.`
- `/project start [ordinals...]`、`/project drop` 新增。
- `project_thread_manage` 新增 `action: 'start' | 'drop'`（`indices?`），并在 `project_coordinate` 的 `planOnly` 结果里附 `next` 指引，明确告诉模型「把标题给用户看，等他们同意后再 start」。

**5. 不做的部分**

官方建议里的「drop those limits once a few threads come back the way you want」（自适应放宽并发偏好）属 `GAP-28`，未在本条实现。

#### 验收标准（全部已有测试）

1. ✅ 模型给了 `tasks` 时按它启动、**不再被正则重切**（`test/tools.test.ts`「starts exactly the tasks the model supplied, without re-splitting the goal」，断言 goal 是散文而 tasks 是两条时 `planned` 恰为那两条、`planOrigin === 'model'`）。
2. ✅ fallback 时**结果里带降级说明**（`test/engine.test.ts` 断言 `planNote` 含 `deterministic guess`）。
3. ✅ `planOnly` 时**零线程启动、零配额消耗**（`test/engine.test.ts` 断言 `started` 为空且 `quota.created` 不变）。
4. ✅ 建议可**单独启动**、也可**一次全起**、失败的留下可重试（`test/engine.test.ts` 的 `startSuggested` 组）。
5. ✅ 建议超 24h **自动丢弃**（读时 `expired: true`，`startSuggested` 抛 `INVALID_INPUT` 并清掉计划）。
6. ✅ 正则 fallback 的原有单测继续通过（`test/unit/planner.test.ts` 15 项未改动）。
7. ✅ 面板能看到待启动建议（`test/unit/overview.test.ts`、`test/commands.test.ts`）。


### GAP-29 协调状态跨会话不可恢复（原「项目绑定会话」重定义）—— ✅ 已做

- **依据**：`OFFICIAL`「You don't manage context windows in a project. Threads compact automatically, and **the conversation works from recent messages, recent threads, and project memory rather than its full history**, so it keeps going for as long as the project runs.」还有 **`Restart Claude`**（"Restarts the project conversation"，且 "threads aren't affected"）—— 协调会话是**可重启、可丢的**。
- **原判断的错误**：原 `GAP-07` 写「项目与协调会话之间没有绑定」，被理解成「需要让项目绑定一段长期会话」。**这是错的**：官方协调者自己就不靠完整历史，还提供重启按钮。真正缺的不是「绑定」，是**协调状态能跨会话恢复**。
- **缺的是三件套**（不是两件套）：
  | 项 | 现状 |
  | --- | --- |
  | 线程摘要 | ✅ 有（`manifest.threads`） |
  | 共享记忆 | ✅ 有（`manifest.memories`） |
  | **近期消息** | ❌ 没有 —— 协调者侧最近几轮说了什么，完全没存 |
- **结论**：**不做会话绑定**，做「协调状态三件套」的持久化。项目仍然是一个无状态工具集 + 一份 manifest，任何会话进来都能从三件套里恢复出「现在有哪些活、在等谁、之前决定过什么」。
- **做法**：manifest 加 `recentMessages: Array<{ at, role, text }>`（环形缓冲，容量可配，默认 ~20 条），由 `coordinate` / `memory` / `healSweep` 的写入路径追加；charter 的协调者视角渲染最近消息摘要（**注意：只给协调者，不进线程前缀**，否则线程前缀会随消息变化，prefix cache 全废）。
- **验收标准**：
  1. 换一个全新会话打开同一项目，能读到三件套；
  2. 最近消息有容量上限，不会无限增长；
  3. 线程的 charter 字节**不因**协调者消息变化而改变（有测试断言）。

---

**实际做法（2026-10-29 落地）**：

1. 新模块 `src/core/coordState.ts`（纯逻辑）：`appendRecent` 环形缓冲（`RECENT_MESSAGE_LIMIT = 20`，单条 `MAX_RECENT_MESSAGE_CHARS = 400`）、`newestFirst`、`renderRecentMessages`。
2. `ProjectManifest` 新增 `recentMessages?: RecentMessage[]`；`engine.recordRecent()` 在 `coordinate` / `setMemory` / `removeMemory` / `setGoal` / `healSweep` 的写入路径追加，**尽力而为**（失败不影响主操作）。
3. **不进 charter**：charter 是所有线程共享的前缀，消息每轮都变，放进去等于每轮废掉一次前缀缓存。协调者通过 `/project goal`、`project_overview` 读它。
4. 三件套齐了：线程摘要（`manifest.threads`）、共享记忆（`manifest.memories`）、近期消息（`manifest.recentMessages`）。任何新会话打开同一项目都能从 manifest 恢复「在做什么、刚决定了什么、还有什么在飞」。

**验收（全部有测试）**：`test/unit/coordState.test.ts` 13 项（环形上限、单条截断、空消息不入环、返回新数组、newest-first、渲染尾部）；`test/engine.test.ts` 的 `goal and recent messages` 组（`records what the coordinator did, bounded`、`surfaces the goal and the recent messages through the overview payload`、`keeps the charter byte-identical when only recent messages change`）。
## P4 — 项目管理类

### GAP-14 没有 Pause — ✅ 已做

- **依据**：`OFFICIAL`「**Pause**: stops everything at once. Every running thread and the conversation are interrupted, no new threads start, scheduled tasks don't run, and the project doesn't accept messages until you resume it.」
- **判断**：在本地平台上这就是「我要用这台机器干别的」的那个开关，**比归档常用得多**，应优先于 `GAP-15`。
- **做法**：`ProjectManifest` 加 `pausedAt?: number`；`coordinate` / `healSweep` / `deliverThread` 开头检查并拒绝；`/project pause` 与 `/project resume`；暂停时 `interrupt` 所有活跃线程。
- **验收标准**：暂停后 `coordinate` / `healSweep` 都不动作且给出明确原因；恢复后可继续；暂停状态跨进程持久。

**实际做法（2026-10-29 落地）**：

- `ProjectManifest` 新增 `pausedAt?` 与 `pauseReason?`：**记时间戳而不是布尔开关**，这样它天然跨重启、跨进程（两个 engine 读同一个记录），并且面板能说「从什么时候开始暂停的」。
- `engine.pause(parent, reason?)` 先写记录、**再**中断活跃线程。顺序不能反：线程观察到自己的 abort 后如果还能跑一轮自愈，那就不叫暂停了。中断只发 `interrupt`，不改状态（`queued` 仍可 retry）。
- 守卫点：`coordinate` / `startSuggested` / `deliverThread` 直接抛 `PROJECT_PAUSED`（新错误码，消息里带 `/project resume`）；`manageThread` 的 `steer` / `respond` / `retry` / `merge` / `conflicts` 同样拒绝。**只读与收尾动作仍然可用**（`inspect` / `close` / `reopen` / `review` / `watch` / `unwatch` / `interrupt`）——用户暂停机器之后仍需要能整理线程。
- `healSweep` **不抛错而是返回** `{ observed: 0, paused: reason }`：后台 watcher 按定时器调它，抛错会每轮写一条堆栈，而项目是**按设计**停着的。
- `/project pause [原因]` 与 `/project resume` 命令；`/project heal` 的输出会带 `paused: ...`。
- 面板：`ProjectOverview.paused` → markdown 在 quota **之前**输出 `- PAUSED: <原因> (\`/project resume\`)`（埋在几十个线程下面的话，读者会以为面板坏了而不是项目停着），`overviewJson()` 与投影快照同样带 `paused`。

**验收（全部有测试）**：✅ 暂停后 `coordinate`/`healSweep`/`deliverThread` 不动作且原因明确 —— `test/engine.test.ts` 的 `refuses to start work, sweep, or deliver while paused, and says so`；✅ 恢复后可继续 —— `interrupts live threads and keeps them resumable`；✅ 跨进程持久 —— `survives a restart, and resuming an unpaused project is a no-op`；✅ 只读动作仍可用 —— `still allows reading and closing while paused`；✅ 命令层 —— `test/commands.test.ts` 的 `stops the project, reports why, and lifts on resume`；✅ 面板 —— `test/unit/overview.test.ts` 的 `announces a paused project above the quota, with the way out`。

### GAP-15 没有 Archive

- **依据**：`OFFICIAL`「**Archive**: hides the project from the sidebar and archives its threads, which stops any thread that was running or watching a pull request.」
- **现状**：无归档概念。**（`GAP-05` 是线程级终态，本条是项目级，两者不同，不要合并实现。）**
- **做法**：`archivedAt` 字段；归档时中断活跃线程、退订所有 PR 监视、置停 watcher；`/project archive` 与 `/project unarchive`。
- **验收标准**：归档后无任何后台动作（watcher 不再碰它）；取消归档后线程可继续。

### GAP-17 无线程运行时长上限

- **现状**：卡死的线程会一直占 `running`，只能人工 `interrupt`。`grep -rn "maxDuration\|deadline" src/core/engine.ts` 返回空。
- **做法**：descriptor 加 `deadlineAt`；`healSweep` 检查超时并 `interrupt` + 置 `needs_feedback`（**不是 `failed`** —— 超时是「没跑完」，不是「跑失败」）。
- **验收标准**：超时线程被中断且状态可解释；不误杀长任务（阈值可配，默认足够宽）。

### GAP-18 未接入审批 — ✅ 已做

- **依据**：`OFFICIAL`「When a thread needs your approval, the prompt is **inside that thread** and the thread waits until you answer it **there**. Telling Claude in the project conversation to go ahead **doesn't reach it**.」+「Threads run in **auto mode**」+「Don't **merge**, **force-push**, or **change CI configuration** without asking me in the thread.」
- **⚠️ 关键约束：官方那种「在线程内阻塞等人」在 DSH 上做不到。** 已核实两个 Host 服务：
  - `userQuestions.ask(req)` 在 `agent` 被别的 agent 拥有时直接抛 **`DELEGATED_CALLER`**，且要求是注册表里的**精确 live root**（否则 `CALLER_NOT_LIVE`）——**子线程没有人类应答者，问不了人**；
  - `approval.request(req)` 要求 `toolName`（它是给**单次工具调用**做门的），且**必须有 open turn**，否则直接拒绝。
- **改译结果：「人放行 + 宿主执行」，不是「线程内阻塞」。** 线程不阻塞在任何东西上；放行记录落在 `thread.approvals`，宿主在**自己动手的那一刻**检查它。

#### 实际做法（2026-10-29 落地）

1. **配置项 `requireApprovalFor: ApprovalAction[]`**（`ApprovalAction = 'push' | 'pr' | 'merge' | 'force-push'`，`src/types.ts`），默认**空数组**，行为与从前完全一致。
2. **放行记录挂在线程描述符上**：`ProjectThreadDescriptor.approvals?: Partial<Record<ApprovalAction, number>>`，值是**时间戳**不是布尔——和 `pausedAt` 同一个理由：要能回答「什么时候批的」，且跨重启跨进程仍在。
3. **宿主在动作前检查，不靠线程自觉**：`engine.assertApproved(thread, actions, verb)` 只对 `requireApprovalFor` 里列出的动作生效，缺失时抛 `APPROVAL_REQUIRED`，消息点名**清掉它的那条命令**：``/<id> approve push``。检查点：`deliverThread` 的 push 与 pr（`assertApproved(thread, ['push'], 'push')` / `['pr']`）、`manageThread('merge')` 的 merge。
4. **重试不会重新扣一次审批**：`push` 通过后 `pr` 仍需单独放行——两个动作是两件事（推分支可以，公开 PR 不行）。
5. **线程被提前告知**：`renderThreadTask` 在 `approvals` 非空时插入 `Stop before publishing` 段，说明哪些动作被门住、以及**不要自己跑 `gh pr merge`**；`buildHealPrompt` 同样在自愈轮带上。理由：让线程撞一次硬错误再重试，比先告诉它贵。
6. **面板与命令两条出口**：`overviewJson().approvalsRequired` 与 markdown 的 `sign-off required before: push, pr` 说明当前口径；`/project thread <id> approve <action>` 与工具 `project_thread_manage` 的 `approve` 动作都能放行。

#### 为什么不按原计划让线程转 `needs_feedback`

原方案要求「线程结束本轮、把请求写进结束消息」。实现时发现它有个更差的后果：**线程在等放行时已经做完了工作，转 `needs_feedback` 会把它从 `awaiting_review` 打回人的队列，而 PR 其实已经开好了**；人批准后还得再唤醒一轮才能继续。改成「宿主检查 + 记录放行」后，同一个线程状态不变，人批准是**一步**而不是两轮往返。球仍在人手上（没人批就不 push、不开 PR、不合），成本更低。

#### 验收（全部有测试）

1. 默认行为不变：`keeps the original behaviour when nothing is gated`（未配置时交付一次通过、零审批往返）。
2. 开启后未放行一律拒绝并给出可执行命令：`refuses to publish until push and pr are approved, and says how`（拒绝时 `git push` 从未发生；逐项放行后交付成功）。
3. 放行按动作独立：`gates merging separately from publishing`（`requireApprovalFor: ['merge']` 时交付照常、`merge` 被拒；放行后转 `landing`）。
4. 非法动作不被静默记录：`rejects an unknown approval action instead of recording it`。
5. 线程被提前告知、面板口径可见：`tells a fresh thread to stop before publishing, and the panel says what is gated`。
6. 不在子线程里调用 `userQuestions.ask`（有测试断言不会抛 `DELEGATED_CALLER`）：宿主侧**没有任何** `userQuestions` 调用，`grep -rn userQuestions src/` 为空——这条约束靠「根本不写」保证，而不是靠运行期捕获。

### GAP-25 heal prompt 没禁止 force-push 与改 CI 配置 — ✅ 已做

- **依据**：`OFFICIAL` 项目指令示范：「Don't merge, **force-push**, or **change CI configuration** without asking me in the thread.」——官方自己把「需要人点头」的动作列出来了。
- **现状**：`buildHealPrompt`（`src/core/healing.ts:139-143`）的 5 步里只禁了弱化断言：第 2 步 "Do not weaken, skip, or delete the failing assertion to make it pass."。**没有**禁 `force-push`，也**没有**禁改 CI 配置文件。
- **为什么危险**：一个自愈线程在修 CI 时**最省力的「修法」就是改 CI 本身**（放宽超时、加 `continue-on-error`、把失败的 test 从 workflow 里去掉）。这会让「CI 变绿」与「代码变对」脱钩，而这正是自愈器最该防的。
- **做法**：`buildHealPrompt` 的第 2 步或新增一步加两条禁令：不得 `force-push`；不得修改 `.github/workflows/` 等 CI 配置来让检查通过。需要改 CI 时停下来问。
- **顺带**：`deliverThread` 与将来的 `merge` 动作也应带上这两条（`force-push` 会重写别人可能已拉取的历史，不属于「分支上 push 完全可逆」那一类）。
- **验收标准**：
  1. heal prompt 文本含 force-push 与 CI 配置禁令（单测断言关键词）；
  2. 交付 prompt 同样含；
  3. 文档里写明「改 CI 必须问人」。

**实际做法（2026-10-29 落地）**：禁令写进三个 prompt 模板，各按其场景措辞。

- `buildHealPrompt`（`src/core/healing.ts`）在「What to do」之后加三条：不得 `force-push`（评审者可能正在读这条分支）；不得改 CI 配置（workflow 文件、跑哪些检查、检查的阈值）来让检查通过，检查本身错了就停下来说；不得自己合 PR。
- `renderThreadTask`（`src/core/prompt.ts`，线程的第一轮）加同样三条。第一轮和自愈轮面对的是同一种诱惑：为了绕过一个 rebase 而重写分支，或者为了让检查变绿去动 workflow。
- `renderMergeRequest` 保留「不得 `force-push`、不得改 CI 配置来把合并推进」；`renderConflictRequest` 保留「不得 `force-push`、不得自己合 PR」。
- 文档侧写明：**改 CI 必须问人**（本条目与 `PROJECT_BETA_SPEC.md` 模块 D 的护栏段）。

**验收（全部有测试）**：✅ heal prompt 含两条禁令 —— `test/unit/healing.test.ts`「mentions the branch and forbids softening the test」（三个关键词断言）；✅ 交付/首轮 prompt 同样含 —— `test/unit/prompt.test.ts`「carries the three OFFICIAL prohibitions into the first turn」；✅ merge 路径仍禁 —— 「keeps force-push and CI edits forbidden on the merge path」。

### GAP-28 并发偏好无法表达

- **依据**：`OFFICIAL`「There's no fixed number; Claude starts as many as the work calls for, and a limit you ask for is a **preference rather than a cap**.」+ 紧接着的「Claude **saves preferences like these to project memory** on its own and follows them in later cloud threads. … **Add one to project instructions when you want it worded exactly and applied to every thread from the start.**」
- **现状**：没有任何表达并发偏好的地方。`MAX_PLANNED_TASKS = 8`（`src/core/planner.ts:18`）是**一次拆解最多几项**，不是并发 —— 连续两次 `coordinate` 就是 16 个线程在跑。
- **判断**：**不加硬上限是对的**（有据）。但官方的「偏好」不是「什么都不做」，而是**持久化进记忆/指令，由模型遵守**。我们有记忆层、有 instructions 层，实现成本接近零。
- **做法**：一条共享记忆键 `concurrency-preference`（或 manifest 字段 `maxConcurrentThreads?: number`），`coordinate` 时读它并在计划阶段告知模型/限制本次启动数；`/project concurrent <n>` 写入。**明确写进文档：这是偏好不是硬闸。**
- **本地额外理由**：云端的并发成本是 token，我们的成本是 token + 磁盘 + 宿主进程 + 同一台机器的 CPU，所以更该有。官方首批建议也主张新项目从低并发开始。
- **验收标准**：偏好可写、可读、跨进程持久；`coordinate` 遵守它并在结果里说明「按你的并发偏好只启动了 N 个」；不设时行为不变。

---

## P5 — 磁盘、性能与健壮性

### GAP-19 worktree 永不回收 — ✅ 已做

- **现状**：`worktreeRoot` 是 `.dsh-project/worktrees`（`src/core/manifest.ts:47`），每线程一个目录，**从不删除**（`grep "worktree remove\|prune" src/` 返回空，engine 里没有任何 `rm`）。跑 100 个线程 = 100 份完整 checkout。
- **做法**：`deliverThread` 成功后（PR 已开、分支已推）删除 worktree（`git worktree remove --force` + 目录兜底），**保留分支**。删除前必须确认分支已推送，否则未推送的提交会丢。
- **顺序不能反**：先有产出清单（`GAP-10`），再删目录。否则删完就再也说不清「这个线程产出了什么」。
- **排期上移**（2026-10-28 修正）：原排在最后一批。但**不可逆的动作不该最后做防护** —— 在它之前，每一次 `deinit` / 归档都在这个风险上。因此移到与 `Pause` / `Archive` 同批。
- **实际做法（2026-10-29 落地）**：
  1. `vcs.ts` 新增 `removeWorktree(runner, repoRoot, worktreePath)`：`git worktree remove --force` 失败就 `git worktree prune` 再复查，仍不消失则返回 `{ removed: false, warning }` —— 清理是家务事，交付已经完成，不能因为它失败就把交付判失败。
  2. `deliverThread` 在 **push 成功且 PR 已开之后**才回收，成功则删掉 `worktreePath` 并记 `note: 'worktree reclaimed after delivery'`，失败则把 warning 写进 note 与返回消息。
  3. **无分支线程不回收**：scope 隔离的线程没有远端可去，删了就真丢了（早退分支在回收之前）。
  4. 回收后唤醒线程要能重建 checkout：`vcs.ts` 的 `ensureWorktree(runner, repoRoot, branch, worktreePath)`（不健康就 `git worktree add <path> <branch>`），engine 的 `checkoutFor(thread)` 统一走它 —— 有 `worktreePath` 就确保存在，没有 `branch` 返回项目根，有 `branch` 没 `worktreePath` 就在 `worktrees/<threadId>` 重建并写回 descriptor。六个接线点：`deliver` / `respond` / `retry` / `merge` / `conflicts` / `observeOne` 的自愈唤醒（唤醒**之前**调用，子会话的 cwd 就是那个路径）。
  5. 只读 PR 状态的路径（`observeOne` / `settleUnreachable`）仍用 `thread.worktreePath ?? rootDir`：读 gh 不值得为它重建一份 checkout。
  6. 回收后读产出文件返回明确原因：`` `... lives on branch <branch> and is readable here only once that branch is merged` ``，而不是空内容。
- **顺带修的真实缺陷**：Windows 上 `rename` 覆盖一个被其他进程短暂打开的文件会抛 `EPERM`/`EBUSY`（索引器、杀软、第二个读者），`manifest.json` 的原子写因此偶发失败。`manifest.ts` 新增 `renameWithRetry`（5 次、5ms×2^n 退避，非重试码立即抛），POSIX 上无副作用。修复前全量并行跑测试稳定复现 `EPERM: rename ... manifest.json.tmp -> manifest.json`；修复后连续三次 `394/394` 全绿。
- **验收（全部有测试）**：
  1. ✅ 交付成功且已推送后 worktree 被删、分支与远端都在 —— `test/engine.test.ts` 的 `reclaims the checkout once the branch is pushed`
  2. ✅ 未推送时不删 —— 同一 describe 的 `keeps the checkout and reports a warning when git refuses to remove it`（外加无分支早退路径）
  3. ✅ 删除失败不阻塞交付、只记 warning —— 同上用例断言的 note 与 message
  4. ✅ 删除后 Library 清单仍可读 —— 用例 1 断言 `outputs[0].path === 'src/a.ts'`，回收用例另断言读盘返回 `reclaimed after delivery`
  5. ✅ 唤醒前恢复 checkout —— `puts the checkout back before waking a delivered thread`（断言第二次 `git worktree add` 发生、目录重新存在、descriptor 写回路径）

### GAP-20 `deinit` 只删 manifest，其余全留磁盘

- **现状**：`ManifestStore.destroy()`（`src/core/manifest.ts:192`）只删 `manifest.json` 与 `.tmp`。`.dsh-project/` 目录、所有 worktree、`KNOWLEDGE_INDEX.json`、`SHARED_MEMORY.md` 全留在磁盘。
- **做法**：`destroy` 增加可选 `{ purge: boolean }`，默认 `false`（保守）。`/project deinit --purge` 显式清理整个 `.dsh-project/`。**先确认 `.dsh-project` 下没有用户手写文件**（`PROJECT_INSTRUCTIONS.md` 是**用户写的**，不能默认删）。
- **验收标准**：
  1. 默认 `deinit` 行为不变；
  2. `--purge` 删除 `.dsh-project/` 但保留仓库其他内容；
  3. `--purge` 时对 `PROJECT_INSTRUCTIONS.md` 给出明确警告或先备份。

### GAP-27 git 锁冲突被当成失败

- **依据**：无官方明文（云端每线程自己的 clone，不会有这个问题）。这是**本地架构特有**的问题：所有 worktree **共享同一个 `.git`**（object database、`packed-refs`、`.git/config`、`worktrees/` 元数据）。
- **现状**：`CommandError` 会把 `cannot lock ref` / `index.lock` / `cannot lock ... File exists` 当作普通失败，进而让线程转 `failed` 或交付失败。
- **为什么是 P5 而不是更高**：它不产生**错误答案**，产生的是**错误结论**（「这个线程失败了」），而失败是可见的、可 retry 的。但仍该修 —— 正常并发下不该有假失败。
- **做法**：
  1. `CommandError` 增加可重试判定：`cannot lock ref|index.lock|Unable to create '.*\.lock'|Lock file already exists` 视为**瞬时**，指数退避重试 2~3 次；
  2. 重试耗尽仍失败才报错，且报错文案要说明是「仓库被另一个线程占用」而不是「你的代码有问题」。
- **共享 `.git` 的其它护栏（一并记录，避免下轮重新分析）**：
  - `git gc` / `worktree prune` **只由宿主串行执行**，且建议对共享仓库设 `gc.auto=0`（并发 gc 会 prune 掉另一个 worktree 刚写、尚未被 ref 指向的 object —— 这会真的丢数据）；
  - **线程永不写 `.git/config`**（`user.email`、remote 等），需要时用 `git -c k=v` 单次传入；
  - 凭证走每线程独立 env / `GIT_ASKPASS`，不落 config。
- **验收标准**：
  1. 模拟一次 `cannot lock ref` 后重试成功，线程不转 `failed`；
  2. 连续失败仍如实报错，文案指出仓库占用；
  3. 重试次数可配，不无限重试。

---

## ARCH — 架构性差异（记录，不排期）

这些**不是缺陷**，是载体不同（见 `## 复刻的是什么，不是什么`）。只有明确要改变产品定位时才做；顺手实现会破坏现有取舍的完整性。

### GAP-A1 云端 sandbox vs 本地 worktree

- **官方**：每个云线程在自己的云端 sandbox 里 clone 仓库，关掉笔记本也继续跑，sandbox 在轮次之间暂停；resume 失败则从 fresh clone 继续，可能丢未提交改动。
- **我们**：本地 worktree，宿主进程在跑才能推进；未提交改动一直在盘上，不会因 resume 失败丢失。
- **官方对同一件事的背书**：官方**支持**线程跑在用户自己的电脑上（Remote Control），且 `claude remote-control --spawn worktree` 就是「每线程一个 worktree」的官方开关；官方的本地线程限制原文可直接抄作我们的 README 口径：
  - "Runs only while that computer is awake with Remote Control turned on"
  - "The thread **pauses** while that computer is asleep, and **stops** if the desktop app or `claude remote-control` quits"
  - "Starts with the project's instructions, **but not with its memory files loaded**"
- **换来的**：本地工具链、本地文件、本地网络、本地凭据、文件不会丢。
- **代价**：宿主不在就停（`BOUND-1`），共享 `.git` 带来锁竞争（`GAP-27`）。**第三条尤其要记**：官方本地线程**不加载记忆文件**，我们是加载的（`src/core/prompt.ts:56`）—— 这不算错（本地读得到，官方是跨设备传输成本），但若有人拿官方行为提 bug，出处在这里。

### GAP-A2 没有 GitHub App / connectors / cloud environment

- **官方**：装 Claude GitHub App；线程从账号 connectors 拿 MCP 工具；cloud environment 决定网络白名单、环境变量、网络密钥、setup 脚本。
- **我们**：走 `gh` CLI 的已有鉴权，不装 App；MCP 用 DSH 自己的配置；环境就是用户机器。
- **换来的**：零安装、零云端配置。
- **代价**：没有 setup 脚本与网络密钥管理。若将来需要，应作为独立能力设计，不要塞进本项目。

### GAP-A3 没有 Team 协作

- **官方**：beta 期间**同样不支持**共享（「A project belongs to one user. You can't share a project or its threads with another user」）。`support.claude.com` 那篇的 Team 共享表属于**旧版**项目。
- **结论**：**持平**，不是差距。不要因为看到旧文档里的共享权限表就去做。

### GAP-A4 没有 Continue in project

- **官方**：从一个已有云会话「Continue in project」，把它的工作带进项目。
- **我们**：无。
- **判断**：DSH 里会话与工作区的关系已足够松，收益不明。记录，不排期。

---

## BOUND — 有意为之的边界（非缺陷）

这些是已写进代码注释的**已知限制**，不打算改或改不动。列在这里是为了避免下一轮把它们当新缺陷重新分析一遍。

### BOUND-1 重启后后台自愈停摆

- `SubagentThreadRuntime.parents` 是**进程内存**（`src/host/subagents.ts`）。宿主重启后 `firstKnownParent`（`src/index.ts:299`）返回 `undefined`，watcher（`src/index.ts:265`，注册于 `:230`）跳过该引擎，无法唤醒任何线程。
- **根因**：Host 按 **live sender** 授权唤醒（`subagents.sendMessage` 要有真实 `Agent`），凭空造一个 parent 会被拒。这不是我们的疏漏，是安全模型。
- **缓解**：重启后用户主动敲 `/project heal`（命令行里有 `agent`，是可用的 parent）或 `thread <id> retry`。
- **要不要改**：不改，除非 Host 提供持久化的授权主体。

### BOUND-2 记忆广播给运行中线程（比官方多，非缺口）

- 我们会给 `busy` 线程广播共享记忆；官方**不给运行中的线程任何更新**：「Changes to instructions, repositories, plugins, and environment in **Project settings** reach new threads, **not threads already running**」，且「Every cloud thread reads the index file `MEMORY.md` **when it starts**」。
- **判断：这不是债，是超额实现。** 只推 `busy`、不推 `idle`（省 token）那个取舍是对的。
- **若要动，方向是删**（去掉实时广播，省一条代码路径和一类竞态），**不是补**。不要把它当缺口排期。

### BOUND-3 `quotaWarning()` 是死代码 — ✅ 已解决（2026-10-27，随 `GAP-01`）

`quotaWarning()` 新增 `label` 参数，`ProjectEngine.overview()` 改为调用它**两次**——一次给项目偏好、一次给用户全局账本。内联的 80% 判断已删除，两个计数器用同一把尺子，且各自说清是哪一本账。

### BOUND-5 记忆仍整段渲进 charter，而官方记忆也是 paths-first

- **一条取证错误**（第二轮复核，`docs/REVIEW-RESPONSE-2.md` §取证错误）：历来把「记忆放在 system prompt 固定槽位以命中缓存」当成已对上官方，引的是 `OFFICIAL` L22「**Set context once**: every new thread starts with the project's **instructions**」。引文逐字无误，**但它讲的是 instructions，不是 memory**。
- **官方的 memory 是 paths-first**（L291）：「Notes Claude keeps about the project … **stored as files**. Every cloud thread reads the index file `MEMORY.md` when it starts and **opens the other files when it needs them**」。也就是说**官方对记忆和对知识用的是同一套机制**，而 `GAP-22` 只把知识改了，记忆还整段渲进 charter（`renderMemoryPrefix`）。
- **为什么列为 BOUND 而不是 GAP**：⚠️ 这是判断而非依据——记忆是**决策**而不是**文档**，每条都短、每条都该被读到，lazy 读取反而会让线程漏掉约束；而 16,000 字符的预算对它绰绰有余。所以保留槽位是**我们的取舍**。
- **要做的只有记账**：~~别再把它当「有据的基线」（`REVIEW-REQUEST` §1 那一行应改掉）~~ —— **这句待办已作废**：`8dad36c` 送审版确实有 `REVIEW-REQUEST.md:48` 那行「记忆放在 system prompt 固定槽位以命中缓存」，但它在 `bb71325` 重写时就没了，`9866952` 送审版 grep `槽位|固定位置|system prompt|缓存` 零命中。**剩下一半仍有效**：用 `MAX_INSTRUCTIONS_CHARS` 同一把尺子给记忆段也设一个报警阈值（`memoryOverBudget` 至今零命中）。若将来记忆长到会挤掉 instructions，再按官方形状改成文件 + 索引。

### BOUND-4 单进程内一个 root 恰好一个 turn-end 订阅

- `createRuntime` 用 `detaches: Map<string, () => void>` 保证每个 root 只 `attach()` 一次。这是**正确设计**，不要为了「多实例」去动它。

---

## 编号变更记录

条目编号一旦撤销就**不再复用**，避免旧讨论里的编号指向别的东西。搜索某个编号找不到定义时，查这张表。

| 编号 | 状态 | 去向 |
| --- | --- | --- |
| `GAP-02` | **撤销** | 知识陈旧检测。paths-first 下知识由模型按需读盘，没有「陈旧」概念。并入 `GAP-22` |
| `GAP-07` | **撤销** | 「项目与协调会话绑定」。框架错了，改为「协调状态跨会话可恢复」= `GAP-29` |
| `GAP-08` | **从未启用** | 上一轮编号跳号，无对应条目 |
| `GAP-16` | **撤销** | 「知识自动重建的时机」。并入 `GAP-22` 第 4 条（查询时按需重建） |
| `GAP-21` | **撤销** | 知识阈值写死。阈值本身随模式二分一起消失。并入 `GAP-22` |

**新增编号**（第一轮加入）：`GAP-22` ~ `GAP-29`。
**新增编号**（第二轮加入）：`GAP-22a`（从 `GAP-22` 第 2 条拆出，见该条）、`BOUND-5`（记忆仍在 charter 槽位里，取舍而非缺陷）。

## 已修正的错误判断

记录曾经判断错、后来纠正的结论，避免下一轮重复踩。**理由错了比结论错了更值得记 —— 它会传染到下一个决策。**

| 时间 | 曾经的判断 | 实际 | 出处 |
| --- | --- | --- | --- |
| 2026-10 | 「缺并发度控制」列为规格缺口 | **判断错误**。官方明写「a limit you ask for is a preference rather than a cap」。真正的缺口是**偏好无处表达**（→ `GAP-28`）。 | 讨论 m01720 前后 |
| 2026-10 | 「review verdicts 没接入」 | **判断错误**，已接入（`readReviewVerdicts`，`src/core/engine.ts:806`）。 | 代码核对 |
| 2026-10 | README 称「Host-only 会话投影保持面板随会话更新」 | **文档虚述**，投影未实现。已改为事实陈述。 | `README.md` |
| 2026-10 | 「项目知识 RAG 未实现」 | 已补齐（`knowledge.ts` + `knowledgeSource.ts`）。**但补错了产品**，见下条。 | commit `71cac2e` |
| 2026-10-28 | 「知识模式按体积切换已对上官方」 | **前提错了**。`RAG` 那篇讲的是 chat Projects；`OFFICIAL` 全文 `RAG`/`retrieval`/`project knowledge` 各 0 次。整套二分、阈值、陈旧检测**全部撤销**，改为 paths-first（→ `GAP-22`）。 | 第一轮复核 §0 |
| 2026-10-28 | 「状态轴是『轮到谁』，六分组有五个是人视角」 | **过度解读一半**。`Idle` 的官方定义是 "finished and **aren't waiting on anything**"，在二元 `ai\|human` 里没有合法取值。真正的轴是**工作在生命周期里的位置**，`Waiting on you` 只是其中一个分组被挑出来做「需要你」的收口。**结论（用户只看一处）仍对。** | 第一轮复核 §0 ① |
| 2026-10-28 | 「`failed` 被归入 `Waiting on you` 说明底层是两层模型」 | **理由错**。官方原句是「The pane's Threads tab **groups threads by state**」—— 分组是 state 的**投影**，state 是一维的。把它当两层模型的证据，下一次看到任何界面聚合都会再推一次同样结论。 | 第一轮复核 §0 ② |
| 2026-10-28 | 「改状态枚举是破坏性改动，要改投影 schema、升 `stateVersion`、迁移落盘数据」 | **代价估高一个数量级**。`bucketOf`（`src/core/overview.ts:41`）已是现成的 `state → bucket` 派生层，`BUCKET_ORDER` 只有 5 项。实际改动二十行以内，`ThreadStatus` 不动、`stateVersion` 不升、数据不迁移（→ `GAP-04`）。 | 第一轮复核 §0 ③ |
| 2026-10-28 | 「投影必须晚于状态模型（`stateSchema` 由枚举决定）」 | **约束不成立**。投影暴露的是**桶**不是枚举；后加三个状态只改 `bucketOf` 的 case。批次 2/3 可以合并（→ `GAP-03`）。 | 第一轮复核 §1 B |
| 2026-10-28 | 「项目需要『绑定一段长期会话』」 | **框架错了**。官方协调者自己「works from recent messages, recent threads, and project memory **rather than its full history**」，还有 `Restart Claude` 可重启会话。真正缺的是**协调状态三件套**（线程摘要 ✅ / 记忆 ✅ / **近期消息 ❌**）（→ `GAP-29`）。 | 第一轮复核 §1 D |
| 2026-10-28 | 「`MAX_HEAL_ATTEMPTS = 3` 是合理的护栏」 | **轴选错了**。它是生命周期累计，会误伤正常的多轮评审（四轮不同意见的第四轮被当成「修不好」）。应改为**连续失败**计数（→ `GAP-23`）。 | 第一轮复核 §2 Q2 |
| 2026-10-28 | 「记忆广播给运行中线程是过度实现，可能要删」 | **反问句的答案是：不删**。官方只影响新线程，我们做得比官方多；只推 `busy` 的取舍正确（→ `BOUND-2`）。 | 第一轮复核 §3 §5.3 |
| 2026-10-28 | 「拆解不调模型是可以接受的取舍」 | **是技术债，且它不在原六批计划里**。排序规则（「会不会安静地出错」）把它过滤掉了，因为拆解烂是**用户一眼看得见**的。但拆解质量是所有后续批次的**输入**（→ `GAP-26`）。 | 第一轮复核 §4 |
| 2026-10-28 | 「审批要挂在线程上、阻塞线程」 | **在 DSH 上做不到**。`userQuestions.ask` 对 owned agent 抛 `DELEGATED_CALLER`；`approval.request` 只服务单次工具调用且要求 open turn。必须改译为「根会话问人、线程执行」（→ `GAP-18`）。 | 本轮 Host 契约核对 |
| 2026-10-27 | 「知识预算应由上下文窗口派生」（第一轮回执给的建议） | **有明文数字，不需要推**。`OFFICIAL` L292：project instructions「up to **16,000 characters**」。比窗口派生出来的数小两个数量级，而且是写明的。第一轮建议的双阈值 hysteresis 也随之不需要——没有阈值就没有抖动。 | 第二轮复核 §问题二 ④ |
| 2026-10-27 | 「paths-first 就是把路径**清单**渲进 charter」 | **形状差一级**。`OFFICIAL` L291：官方开局给的是**索引文件**（`MEMORY.md`），正文按需打开。只给路径，模型得先 `ls` 或先读一遍才知道哪份相关；给索引（路径 + 规模），它才能**选**。已按索引实现。 | 同上 ③ |
| 2026-10-27 | 「paths-first 没有 prompt 层引导，我们得自己加一句，那是偏离」 | **担心不成立**。引导存在，但被编码在**读取协议**里（索引 eager / 正文 lazy），不是 charter 里一句话。所以不要自己加句子，要加索引——加了就不是偏离，是照抄。 | 同上 ①② |
| 2026-10-27 | 「`OFFICIAL` 全文 `RAG`/`retrieval`/`project knowledge` 各 0 次」 | **比这更强：四个 0**。`knowledge` 这个词本身也是 0 次。Code Projects 连「知识」都不用，只有「挂载给线程读的文件」与「线程自己记的 memory 文件」。 | 同上 ② |
| 2026-10-27 | 「六分组可能重叠，也许要改成多维标签」 | **互斥，不要改**。但互斥是**按构造**成立（「groups threads by state」），所以两条定义同真时必须自己定优先级：**人阻塞优先于 PR 生命周期位置**，否则等审批的线程会被 PR 状态掩埋而面板一切正常（→ `GAP-04`）。 | 同上 §问题一 |
| 2026-10-27 | 「账本用和 `ManifestStore` 同级的串行队列就够」 | **不够**。这个文件按定义被机器上所有项目、所有 Host 进程共享，进程内队列只能序列化从来不是问题的那批写者。实现改为排他锁文件 + 锁内重读 + 陈旧锁打破（→ `GAP-01`）。 | 本批实现 |
| 2026-10-29 | 「模型优先」= 在 `coordinate` 工具内部调一次模型 | **框架错了**。DSH 里协调者本身就是那个模型（根会话在调 `project_coordinate`），工具内再调一次是嵌套委派：多花一次 token、多一层失败点，而且**看不到用户在对话里刚说的话**。正确落法是计划**从参数进来**（`tasks`），工具只校验；拿不到就降级为正则兜底并明确标注（→ `GAP-26`）。 | 本批实现 |
| 2026-10-27 | `test/engine.test.ts` 的 `quotaDay` 断言 | **测试写错**，不是实现错。`dayKey` 取**本地**日历日，而固定时钟 `2026-01-02T03:04:05Z` 在任何比 UTC 晚 3 小时以上的时区都落在 01-01。硬编码字面量在欧洲过、在加州挂（已在改动前的 HEAD 上复现确认）。改为 `dayKey(fixedClock().now())`。 | 本批 `npm run verify` |

---

## 分批计划

每批独立提交、独立验证。批内条目彼此有依赖，不要拆开做。

**排序原则**（2026-10-28 修订）：不只看「会不会安静地出错」，还要看**它是不是后续批次的输入**。原排序把「错得不安静」的项（拆解、审批）过滤到了最后，结果是在给错的输入抛光。

| 批次 | 条目 | 依赖 | 说明 |
| --- | --- | --- | --- |
| **第一批 让输出可信** | `GAP-01` 全局配额 ✅ + `GAP-22` 知识 paths-first ✅ | 无 | 2026-10-27 `9c7ef10`：`GAP-01` 关闭，`GAP-22` 的减法做完（确实净减）；2026-10-29：`GAP-22a`（路径锚定项目根）关闭 —— **第一批完成** |
| **第二批 让拆解可信** | `GAP-26` 模型优先拆解 + Suggested threads ✅ | 无（可与一批并行） | 后者是前者的保险，必须同批。2026-10-29 关闭 —— **第二批完成** |
| **第三批 让报回可用** | `GAP-03` 投影 ✅ + `GAP-04` 六分组 ✅ + `GAP-05` 终态 ✅ + `GAP-10` Library ✅ + `GAP-11` PR 聚合 ✅ | 03 与 04 **可同批**（原判断的串行约束不成立） | 2026-10-29 全部关闭 —— **第三批完成** |
| **第四批 让裁定可用** ✅ | ~~`GAP-12` 卡片动作~~ ✅ + ~~`GAP-25` 禁令~~ ✅ + ~~`GAP-19` worktree 回收~~ ✅ + ~~`GAP-18` 审批~~ ✅ + ~~`GAP-14` Pause~~ ✅ | 19 依赖 10（先有清单再删目录）| **整批已于 2026-10-29 完成**。不可逆动作（19）与它的防护（18/25）同批，没有推到最后一刻 |
| **第五批 减少重复交代** ✅ | ~~`GAP-06` goal~~ ✅ + ~~`GAP-09` 仓库约定~~ ✅ + ~~`GAP-29` 三件套~~ ✅ | 无 | **整批已于 2026-10-29 完成**：goal 进共享前缀、约定按官方三处只读根、近期消息环只给协调者不进线程前缀 |
| **第六批 卫生** | `GAP-13` Usage + `GAP-15` Archive + `GAP-17` 超时 + `GAP-20` purge + `GAP-27` 锁重试 | 无 | |
| **按需** | `GAP-28` 并发偏好 | 无 | ~~`GAP-23`~~ ✅ 已于 2026-10-29 提前做完 |

> **`GAP-23` / `GAP-24` 为什么提前做了（2026-10-29）**：原计划把它们放在第四批与「按需」，理由是触发条件要等到真的跑起来。实际复核后发现 `GAP-24` 的触发条件比预想近得多 —— 只要一个 PR 合并后分支被删，下一轮 sweep 就会安静地失败，而这是**每个正常收尾的 PR 都会走的路**；`GAP-23` 与它共用 `observeOne` 的同一段代码，分开做要改两遍。两项一起做，`observeOne` 的判断只落一次。

> **第一批已完成（2026-10-29）**：`GAP-22a` 曾是第一批唯一的正确性残留——线程**读不到** charter 指给它的知识文件，也就是「让输出可信」还差最后一步。该条已在方案 A 下关闭（charter 渲染 `Project root` + 相对路径 + worktree 说明，检索结果带 root），**不要再按旧状态把它当未完成项**。`GAP-22` 的其余未完成项（`tree` / `read`、查询时按需重建）是能力增强，留在 P3。

**验证方式（每批都要走）**：

1. `npm run verify`（typecheck + build + 全部测试）
2. 实机探针：junction 挂载 + `dsh --profile web --patch ./probe-patch.yml --no-open --port 1949x`，检查 `PROBE-OK tools:` 与零 `did not activate`
3. **日志不得截断**（`| head` 会吞掉真实错误 —— 这是踩过的坑，见 `AGENTS.md`）
4. 改动 doc 里引用的行号，或改成符号名引用
