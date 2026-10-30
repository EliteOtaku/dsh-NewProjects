# 请 Claude 复核（第二轮）：Projects 复刻的边界、修正后的判断与剩余疑问

这份文档是**给 Anthropic 的 Claude 复核用的**，是我们的第二轮请求。

> ### 请先读原文档，再读我们的转述
>
> **官方规格原文：<https://code.claude.com/docs/en/claude-projects>**
>
> 本文里所有「官方说了什么」都是转述，可能转述错。判断某项能力官方有没有、状态语义对不对时，**请以原文档为准**。下文每个判断都标了它依据的是原文哪一节，方便你对着看。
>
> 建议的对照顺序：
>
> | 本文位置 | 对应原文小节 |
> | --- | --- |
> | 判断 G（六分组、状态轴） | **See what needs you in Overview**；以及 **Work in a project** 里的卡片动作 |
> | 判断 H、I（知识机制） | **Give a project standing context** |
> | 判断 J（拆解、提议、并发度） | **Work in a project**；**Project settings reference** |
> | 判断 K（线程内阻塞等人） | **Unblock a thread waiting on approval**；**Troubleshooting** |
> | 判断 L（自愈） | **Work in a project** 的 PR 与 auto-fix 段 |
> | 判断 M（Scheduled tasks） | **Work in a project**；**Related resources** 指向 `routines.md` |
> | 判断 G 里「哪些配置不加载」 | **How projects relate to other Claude Code features** |
>
> 关于**为什么知识层曾经抄错**：原文 **How projects relate to other Claude Code features** 一节有一句话点明了两个产品的关系（旧版 "groups conversations and reference files **without threads or a coordinator**"）。而我们最初用的 `support.claude.com/en/articles/11473015` RAG 专文，讲的正是那个没有 threads、没有 coordinator 的旧版。**这两篇讲的是不同的产品，这是第一轮最关键的纠正。**
>
> 如果你需要抓 `.md` 版本（比网页版更易引用与 diff）：<https://code.claude.com/docs/en/claude-projects.md>

> ### 另一份必读：DSH 宿主源码
>
> **DeepSeek Harness 源码：<https://github.com/deepseek-ai/deepseek-harness>**
>
> 本文有一半的判断不是关于「官方做了什么」，而是关于「**在这个宿主上能不能做到**」。这类判断只能对着 DSH 的源码与 API 契约验证，光读 Claude 的文档验证不了。
>
> 三份材料的读法：
>
> | 材料 | 用来判断 | 对应本文 |
> | --- | --- | --- |
> | **Claude 官方文档** | 官方有什么能力、语义是什么 | 判断 G、H、J、L、M 的全部理由；判断 K 的「官方是线程内阻塞」这一半 |
> | **DSH 源码**（上面那个链接） | 在 DSH 上能不能照做、照做的代价 | 判断 I（worktree 的文件可见性）、判断 K（子线程能否问人）、判断 M（`automation_create` 是什么）、`BOUND` 全部 |
> | **本仓库源码** | 我们做成什么样、证据在哪 | 每条 `GAP-*` 的「现状」与行号 |
>
> 如果你只读 Claude 文档而不读 DSH 源码，**判断 K 与判断 I 无法评价** —— 它们的前提都在 DSH 侧。我把这两条依赖什么写在了各自的「可验证点」里。
>
> DSH 是 Cordis 插件框架 + Host 服务的架构。本文引用的 Host 服务（`subagents`、`userQuestions`、`approval`、`worktrees`、`sessionProjections`、`automation` 等）都在源码里，搜服务名即可。

## 0. 先澄清一件事：我们复刻的是什么

第一轮我们没把这一点写在显眼位置，导致复核者从「Claude Code 产品经理」的角度评判，而我们的目标是工程复刻。这次先说清楚。

| | 内容 |
| --- | --- |
| **复刻对象** | **Claude Code 新版 Projects (Beta) 这个功能本身** —— 它的概念、行为、状态语义、交互契约。 |
| **交付形态** | **DeepSeek Harness (DSH) 的本地插件**。跑在用户真机、真仓库，构建在 DSH 宿主的 `subagents` / `worktrees` / `tools` / `commands` / `sessionProjections` 之上。 |
| **规格来源** | 只有 [code.claude.com/docs/en/claude-projects](https://code.claude.com/docs/en/claude-projects) 一份。请直接读原文，不要只读本文转述。 |
| **不是** | 不是重建 Anthropic 的云产品。不做云端沙箱、GitHub App、账号 connectors、cloud environment、跨设备续跑。 |
| **载体替换** | 云端 sandbox → 本地 git worktree；云端持久化会话 → DSH 子会话 + 事件溯源 Session Log；GitHub App → `gh` CLI。 |

**因此请以这样的标准评判**：看**功能语义有没有**（用户能不能做到这件事、状态语义对不对、交互契约完不完整），而不是**云端的实现载体有没有**。凡是「官方用 A 载体实现 X，我们用 B 载体实现了 X」的，不算差距。

一个具体例子：官方 Library 必须**拷贝**线程产出的文件（云端沙箱会消失，"uncommitted changes can be lost"），我们在本地**不需要拷贝** —— 文件就在盘上，Library 只需一份清单 + 按需读取。这不是我们偷工，是载体优势。

## 1. 第一轮已采纳的结论（不需要再复核）

第一轮回执非常有价值，以下几条我们**已经照改**，列出来界定本轮讨论范围。

| 回执的指正 | 我们的修正 |
| --- | --- |
| **知识层抄错了产品**。`RAG` 专文讲的是 claude.ai chat 的旧版 Projects（无 threads、无 coordinator），`OFFICIAL` 全文 `RAG`／`retrieval`／`project knowledge` **各出现 0 次**，知识是挂载在 `/mnt/project-files` 的文件夹 | 知识层改为 **paths-first（挂载式）**，撤销 in-context/RAG 二分、阈值常量、陈旧检测。见 `GAP-22` |
| **判断 A 的轴是过度解读**。`Idle` 的官方定义是 "finished and **aren't waiting on anything**"，在二元 `ai\|human` 里没有合法取值 | 轴改为**工作在生命周期里的位置**，`Waiting on you` 不是二分轴的一侧。见下方判断 G |
| **「`failed` 归入 `Waiting on you` 说明底层是两层模型」这个理由错了**。官方原句是「groups threads by **state**」，分组是 state 的投影 | 承认理由错。但**结论（用户只看一处）保留**，`failed` 仍应并入「等你」 |
| **改状态模型的代价估高了一个数量级**。`bucketOf()` 已是现成的 `state → bucket` 派生层 | 确认是功能增加、不是重构。`ThreadStatus` 不动、`stateVersion` 不升、数据不迁移。见 `GAP-04` |
| **「投影必须晚于状态模型」这个约束不成立**（投影暴露的是桶不是枚举） | 两批合并。见 `GAP-03` |
| **「项目需要绑定一段长期会话」框架错了**。官方协调者「works from recent messages, recent threads, and project memory **rather than its full history**」，还有 `Restart Claude` 可重启会话 | 改为「**协调状态三件套**」持久化：线程摘要 ✅ / 记忆 ✅ / **近期消息 ❌**。见 `GAP-29` |
| **`MAX_HEAL_ATTEMPTS` 的轴选错了**（状态机用生命周期累计，续聊语境需连续失败计数） | 改为连续失败计数，有进展即清零。见 `GAP-23` |
| **记忆广播是超额实现，删不是补** | 确认不删，并在文档里标为「比官方多」，不再当缺口。见 `BOUND-2` |
| **拆解不调模型是技术债**，且它被排序规则过滤掉了 | 提到第二批，且与 `Suggested threads` 同批。见 `GAP-26` |
| **最高危的「未接审批」不在六批计划里** | 提前到第四批。见 `GAP-18` |

## 2. 本轮的核心判断（请重点看理由）

理由比结论重要 —— 结论可能碰巧对，理由错了会在下一个类似决策上再错一次。

### 判断 G（修正自判断 A）：状态是「工作生命周期里的位置」，`Waiting on you` 是注意力收口

**我们的做法**：`ThreadStatus` 保持一维，桶（分组）是它的投影。六个桶与官方一一对应：

| 官方分组 | 官方定义 | 我方状态 |
| --- | --- | --- |
| Ready for review | "pull request is open and awaiting review" | `awaiting_review` |
| Waiting on you | "need your reply or approval, **or that failed**" | `needs_feedback` + `failed` |
| Working | "still running" | `queued` / `running` / `ci_fixing` |
| Landing | "approved or **queued to merge**" | 新增 `landing` |
| Idle | "finished and **aren't waiting on anything**" | 新增（与 `completed` 同义） |
| Resolved | "marked done… or **automatically after a week with no activity**" | 新增 `resolved` |

**理由**：

1. 官方明写「groups threads by **state**」—— state 一维，分组是投影。把它读成两层模型是我方上一轮的错（已承认）。
2. 轴不是「轮到谁」，因为 `Idle` 在二元轴里无处安放。但轴也不是纯粹的生命周期 —— `Waiting on you` 明显是**注意力**维度（"need your reply"）。所以它其实是一个**混合轴**，主序是生命周期位置，`Waiting on you` 是把「需要你」的线程从各阶段收口到一个分组里。
3. **我们保留的唯一结论**：`failed` 不该单独成桶。分开列会让用户在「有 3 个失败」和「有 2 个等你」两处找同一件事。

**❓ 请复核这一条**：如果六个分组是**互斥**的（每个线程恰好一个分组），那么一个「PR 开着、CI 全绿、等 reviewer 看」的线程，应该落在 `Ready for review`，**不该**同时出现在 `Waiting on you` —— 因为 `Waiting on you` 的定义是 "need your **reply or approval**"，而"等一个尚未发生的 review"不是线程在等你回复。**这个读法对吗？** 它决定了 `Ready for review` 与 `Waiting on you` 是不是真的两个不同的状态（而不是子类关系）。

### 判断 H：知识层采用 paths-first（挂载式），BM25 降级为便利工具

**我们的做法**：

1. charter 只渲染知识文件/目录**清单**，不注入正文；线程用普通文件工具自己读；
2. 补 `tree`（目录树）与 `read`（按路径读行段）两个动作 —— 这是挂载模型的核心，比语义检索更贴近官方；
3. BM25 检索保留，但索引**在查询时按需重建**（比对绑定路径指纹），只读入口永不写盘；
4. 全文注入作为**可选优化**保留（配置 `inlineKnowledgeMaxChars`，**默认 0 关闭**），目的是命中 prefix cache。它是优化，不是机制。

**理由**：`OFFICIAL` 全文 `RAG`／`retrieval`／`project knowledge` 各 0 次，唯一相关的是 `OFFICIAL` 第 297 行「the folders and files it can read under `/mnt/project-files`」。而 `RAG` 那篇被 `OFFICIAL` 自己点明是**另一个产品**：「**Projects in claude.ai chat and Cowork**: the earlier Projects experience, which groups conversations and reference files **without threads or a coordinator**」。还有一条硬反证：`RAG` 称 RAG "available on paid plans: Pro, Max, Team, and Enterprise"，而 `OFFICIAL` 明写 "Projects aren't offered on **Team or Enterprise** plans yet" —— plan 矩阵对不上。

**优势**：这个改动是**减法** —— 删掉阈值、模式判定、陈旧检测，净减代码。

**❓ 请复核**：官方是否有 prompt 层面的引导，告诉模型「先查一下项目文件再回答」？我们目前只给清单 + 工具说明，靠模型自主。文档里 "you'll see Claude using a project knowledge search tool **when it needs to**" 读起来是纯自主，但我们担心漏查。**如果官方有显式引导（例如 charter 里有一句"回答前先确认项目知识"），请给原文。**

### 判断 I：知识路径必须锚定项目根，不能是相对线程 cwd 的相对路径

**这一条是我们自己核出来的，回执没提，但它是本架构特有的陷阱。**

**理由**：线程的 cwd 是它自己的 worktree（`.dsh-project/worktrees/<threadId>`），而 **worktree 只含 baseCommit 里已提交的文件**。用户根检出里**未提交**的知识文件，在 worktree 里根本读不到。

所以 charter 里必须渲染能定位到项目根的形式：绝对路径，或「项目根 = `<绝对路径>`」+ 相对路径，并明确说明「知识是项目级的，读项目根，不是读你的 worktree」。

**我们补验过**：知识路径本身是相对项目 root 解析的（`knowledgeSource.ts` 的 `resolve(options.rootDir, bound)`），根 `.gitignore` 也没有排除 `.dsh-project/` —— 所以知识库可以放在受版本控制的路径下，paths-first 不会因 gitignore 失效。

**可验证点（对着 DSH 源码与本仓库核对）**：

1. **DSH 侧**：`worktrees.create` 建出来的目录是不是一次独立的 `git worktree add`（搜 `worktrees` 服务）。如果是，它内容 = 某个 commit 的冻结快照，未提交改动不可见。这是判断 I 的全部前提。
2. **本仓库侧**：`src/core/engine.ts` 里线程启动时的 `cwd` 取自 `thread.worktreePath ?? manifest.rootDir` —— 说明线程确实不在项目根里跑。
3. **知识路径解析**：`src/core/knowledgeSource.ts` 的 `collectKnowledge(paths, { rootDir })` 用的是项目 root，不是线程 cwd。

三点都对上，判断 I 成立。**如果第 1 点不成立**（比如 DSH 的 worktree 其实是软链或共享工作区），这条判断作废。

**❓ 请复核**：官方的 `/mnt/project-files` 与线程自己的仓库 checkout 是**两套独立路径**（项目文件在挂载点，代码仓库单独 clone）。我们的做法是「让线程去读项目根的绝对路径」，这等价吗？还是应该把知识**复制/软链到每个 worktree** 里，让 `cat .dsh-project/knowledge/x.md` 这种相对读取也能工作？后者的代价是每线程一份副本（磁盘）与同步问题。

### 判断 J：拆解应「模型优先 + 正则兜底」，且 `Suggested threads` 必须同批

**我们的做法**：

1. 协调者先用可用的委派模型产出计划，拿不到模型才用现有的确定性文本分析；
2. **降级必须可见** —— 现在模型不可用时是静默降级的，改成在结果里明说「委派模型不可用，我按 bullet 切了 3 项，请确认」；
3. `coordinate` 增加 `planOnly`，只产出 `Suggested threads` 列表供人确认，不直接拉起。

**理由**：

- 官方「Claude acts as coordinator. It takes what you send, **decides** what becomes a thread」；
- 官方「Sometimes Claude **proposes** threads instead of starting them, in a **Suggested threads** list. Click the arrow on a suggestion to start that thread」—— 确定性文本分析不会 "propose"；
- 官方路由规则一「**A quick question usually gets an answer in the conversation**」**要求**判断「这是问题还是活」，正则做不了；
- 官方首批建议第 4 条：「Propose threads **and wait for my go-ahead** before starting them」。
- **为什么两件一起做**：`Suggested threads` 是拆解质量的保险 —— 把「拆错」的代价从「开错 5 个 worktree + 5 个分支」降到「删掉列表里 3 行」。单独做模型拆解而不做提议，等于放大风险敞口。
- 原设计的两条理由（「委派模型不可用时也能工作」「可单测」）都对，但它们要的是**有一个确定性 fallback**，不是「拿确定性分析当主路径」。

**❓ 请复核**：`planOnly` 应该**默认 `true`**（与官方新项目姿态一致）还是 **默认 `false`**（保持现有体感）？我们倾向默认提议，但这是行为破坏性变更，想听第二意见。

### 判断 K：审批必须改译为「根会话问人、线程执行」

**这一条是 DSH 平台约束，不是设计选择。**

**我们核对过的两个 Host 服务**：

- `userQuestions.ask(req)` —— 文档原文：「**`DELEGATED_CALLER` when that live agent is owned by another agent**」。子线程是 owned agent，**没有人类应答者，问不了人**。
- `approval.request(req)` —— 要求必填 `toolName`（它是给**单次工具调用**做门的），且「requires an **open turn**… an idle ask rejects」。

**所以官方的「线程内阻塞等人」在 DSH 上无法照抄。改译为三步**：

1. 线程需要放行时**结束本轮**，把「我要做 X，需要批准」写进结束消息（走现有 `needs_feedback` 通道 —— 这是 DSH 上唯一能挂起等人又不阻塞的做法）；
2. 协调者（根会话，是**唯一的 live root**，有应答者）用 `userQuestions.ask` 问人；
3. 拿到答案后 `sendMessage` 给线程继续。

**语义等价**（球在人手上、线程等着），**落点不同**（官方的「线程内阻塞」→ 我们的「线程结束 + 根会话代问」）。

**本地的额外优势**：官方云线程**不读** `.claude/settings.json` 的权限规则（`OFFICIAL` 第 357 行："Not applied"），只能靠 auto mode + 线程内逐次批准。我们**可以**接 DSH 自己的权限体系（`approval.setPolicy` / `tools.guard`）。

**可验证点（对着 DSH 源码核对）**：这两个约束不是我们读文档猜的，是读 Host 源码的 docstring。搜 `userQuestions` 与 `approval` 两个服务，看：

- `ask()` 的抛错条件里有没有 `DELEGATED_CALLER`（以及它的触发条件是不是「agent 被另一个 agent 拥有」）；
- `request()` 是否要求 `toolName` 必填、是否要求 open turn。

如果这两条里任何一条在较新的 DSH 版本里变了（比如 `ask()` 开始允许 owned agent 转交到根），**判断 K 的改译就不必要了**，应该回到官方的线程内阻塞。这是我们最希望被推翻的一条，也是唯一一条会被宿主版本变化直接作废的判断。

**❓ 请复核**：这个改译会不会丢掉官方设计里的某个关键性质？我们能看到的是「线程内提示能带上下文（文件、命令预览）」，而「结束本轮 + 根会话代问」会**丢失线程的现场**。官方是否因为这个原因才把 prompt 放在线程内？

### 判断 L：自愈计数应统计「连续失败」，不是生命周期总数

**理由**：一个 PR 开两周、被 review 四轮、每轮都带来合理的新意见 —— 第四轮撞上 `MAX_HEAL_ATTEMPTS = 3` 就会升 `needs_feedback`，但那四轮里没有一次是「修不好」，它们是四件不同的事。**把正常的评审节奏误判成失败。**

**做法**：有进展即清零。进展的判定用现成数据 —— 失败 check 集合变了（有 check 转 pass），或本轮处理的是**新来的** review comment。

**❓ 请复核**：官方的「auto-fix turned on」有没有预算概念？如果没有，「连续失败 3 次」这个阈值是我们自己加的，是否应该完全去掉、改为「只在无法推进时才交给人」？

### 判断 M：项目内不实现 Scheduled tasks

**理由**：官方 Overview 有第三个标签页 `Scheduled tasks`，但 DSH 已经有独立的 `automation_create` 定时任务能力（每次触发新开 Session、有完整权限边界与运行历史）。本项目内再实现一套会重复造轮子，且语义会冲突（同一个 cron 到底归插件管还是归宿主管）。

**❓ 请复核**：官方 Scheduled tasks 的语义是「定时唤醒项目的协调者」还是「定时开一个线程」？如果是前者，它其实与项目的协调状态强耦合，我们靠宿主的 automation 能等价替代吗？

## 3. 仍然无法从文档确定的疑问

### Q1 Overview 六分组是互斥还是重叠

见判断 G。这个问题的答案决定了我们是否需要改成多维标签。我们目前假设**互斥**（每个线程恰好一个桶）。

具体冲突点：一个「PR 开着、CI 绿、等 reviewer」的线程 —— 是 `Ready for review`，还是同时也算 `Waiting on you`？

### Q2 `Resolved` 的「一周无活动」怎么定义

`OFFICIAL` 只写 "automatically after a week with no activity"。

- 「活动」是线程有 turn、用户点开了线程、PR 有更新、还是并集？
- 我们担心：一个线程的 PR 还开着等 review，reviewer 三周后才来。按「无活动」归档，这个 PR 就没人管了。**归档是否应排除「还开着 PR」的线程？**

我们的倾向：**PR 事件也算活动**（CI 失败/新评论会唤醒线程起一个 turn），所以不必给「还开着 PR」加特例 —— 真正一周零活动的 PR 是谁都没碰过的。

### Q3 `Merge it` 之后线程进入什么状态

`OFFICIAL` 说 `Resolved` 包含 "by Claude once you've taken the last step, such as merging its pull request"，但没说合并后线程还会不会做别的事。

- 合并后立即 `Resolved`，还是先 `Idle` 一段时间？
- **我们踩到的边界**：PR 合并后分支常被删，此时 `gh pr checks` 会报错。我们的 `healSweep` 原来把「PR 已合并所以分支没了」和「网络挂了」当成同一种错误。**官方怎么处理这个?** 我们已改成区分「终局错误」与「可重试错误」，并加显式退订（`GAP-24`）。

### Q4 worktree 共享 `.git` 的并发边界

官方云线程 "each clones its repositories into its own cloud sandbox"，物理隔离显然。我们跑本地 worktree，**共享同一个 `.git` 目录**（object database、`packed-refs`、`config`、`worktrees/` 元数据）。

我们已知的风险与护栏：

- `git gc` / `worktree prune` 并发会 prune 掉另一 worktree 刚写、尚未被 ref 指向的 object（**会真丢数据**）→ 只由宿主串行执行，且对共享仓库设 `gc.auto=0`；
- 锁冲突（`cannot lock ref` / `index.lock`）→ 视为瞬时错误、退避重试（`GAP-27`）；
- 线程永不写 `.git/config`（`user.email`、remote 等），需要时用 `git -c k=v` 单次传入。

**❓ 还有我们没意识到的共享状态问题吗？**

### Q5 修 CI 属于「新工作」还是「续聊」

`OFFICIAL` 提到 "A follow-up routed to a thread that has been idle longer than the cache lifetime… re-reads that thread's whole conversation before doing anything"，并建议 "For new work, asking Claude to **start a fresh thread** can use less than reviving a large old one"。

- 修 CI 会越滚越大（每次修都带上全部历史）。**它属于 new work 还是 reviving？**
- 如果是 new work，我们是否应该在第三轮自愈时**开新线程**并只带必要的失败信息？

### Q6 Team 协作：beta 之后要不要现在留接口

`OFFICIAL` 说 "Projects aren't offered on Team or Enterprise plans **yet**" —— 有 `yet`。

我们现在判定「持平，不做」。**如果 beta 结束后开放共享，现在的数据模型（manifest 是单机文件）会成为障碍吗？** 值得现在留一个 `owner` 字段吗？（我们的倾向：不留。为尚未发生的需求提前设计复杂架构，违反我们的实现原则。）

## 4. 我们自己知道可能错了的地方

| # | 我们的做法 | 怀疑强度 | 理由 |
| --- | --- | --- | --- |
| 1 | 判断 G 里「主序是生命周期，`Waiting on you` 是注意力收口」 | 中 | 这是我从「轴不是二元」推出来的新轴，可能又是一种过度解读。也许官方就是**六个并列的、各自有定义的状态**，没有更深的轴。 |
| 2 | paths-first 只给清单不给正文 | 中 | 如果模型不会主动去读，这个设计就退化成「什么都没给」。这是判断 H 的最大风险，必须有显式引导兜底。 |
| 3 | 审批改译为「线程结束 + 根会话代问」 | 中 | 会丢失线程现场的上下文（文件、命令预览）。官方把 prompt 放在线程内可能是故意的。 |
| 4 | 知识路径锚定项目根（判断 I） | 低-中 | 官方是挂载点与 checkout 两套路径。我们让线程读项目根绝对路径，等价性没验证过。 |
| 5 | BM25 + 中文重叠 bigram | 中 | 官方用的是语义检索还是关键词检索，文档没说。BM25 对「这份文档讲了什么关于认证的」这类语义查询会漏。挂载式下模型可以自己 grep，所以危害比 RAG 模式下小。 |
| 6 | `planOnly` 默认值 | 低 | 行为破坏性变更，但方向明确（官方建议先提议）。 |
| 7 | 不做 Scheduled tasks（判断 M） | 低 | 如果官方语义是「唤醒协调者」而非「开线程」，宿主的 automation 未必等价。 |

## 5. 分批计划（请复核顺序）

排序原则：不只看「会不会安静地出错」，还要看**它是不是后续批次的输入**。上一轮把「错得不安静」的项（拆解、审批）过滤到了最后，实际是在给错的输入抛光。

| 批次 | 内容 | 为什么排这里 |
| --- | --- | --- |
| **1 让输出可信** | 全局配额口径（200/天是 `across your projects`，我们现在每项目独立计数）+ 知识改 paths-first | 不碰 UI 与状态模型，可独立上线；knowledge 是**减法** |
| **2 让拆解可信** | 模型优先拆解 + `Suggested threads` | 它是后续所有批次的**输入**。拆解烂是用户一眼看得见的，所以上一轮被排序规则过滤掉了 |
| **3 让报回可用** | 会话投影 + 六分组 + 线程终态 + Library + PR 聚合 | **投影与状态可同批**（原判断 B 的串行约束不成立） |
| **4 让裁定可用** | 卡片动作（Merge it / Resolve conflicts / Review PR）+ 审批 + Pause + PR 退订 + **worktree 回收** + 自愈禁令 | **不可逆动作（worktree 回收）与它的防护同批**，不推到最后；回收依赖 Library 先有清单 |
| **5 减少重复交代** | goal 持久化 + 读仓库 `CLAUDE.md` + 协调状态三件套 | |
| **6 卫生** | Usage + Archive + 线程超时 + `deinit --purge` + git 锁重试 | 不出错，只占资源与观感 |

**❓ 请复核**：批次 2 提前是这一轮的主要调整，是否正确？还有哪些「是后续批次输入」的项被我们漏掉了？

## 6. 已知未实现清单（不是漏做）

| 官方能力 | 我们 | 计划 |
| --- | --- | --- |
| 项目 goal（可持久、可后加） | ❌ 只是 `coordinate` 入参，不落盘 | 批次 5 |
| 读仓库 `CLAUDE.md` / `.claude/CLAUDE.md` / `.claude/rules/` | ❌ 只读自己的 `PROJECT_INSTRUCTIONS.md` | 批次 5，**只读仓库根**（照抄官方的加载范围，不顺手读子目录） |
| Suggested threads | ❌ 直接启动 | 批次 2 |
| Library / Pull requests | ❌ 只有知识绑定路径 | 批次 3 |
| Scheduled tasks | ❌ 不做 | 判断 M |
| Pause / Archive | ❌ 只有 `deinit`，且只删 manifest | 批次 4 / 6 |
| Usage（按线程、按模型看 token） | ❌ 完全没有 | 批次 6 |
| 权限提示审批 | ❌ 完全不接 | 批次 4，按判断 K 改译 |
| `Merge it` / `Resolve conflicts` / `Review PR` | ❌ 只有 `deliver`（≈Create PR）与 `heal`（≈Fix CI + Address comments） | 批次 4 |
| 会话投影 | ❌ 一行未写 | 批次 3 |
| 六分组 Overview | ❌ 只有五桶，且 `failed` 错列 | 批次 3 |
| 线程终态与归档 | ❌ `manifest.threads` 只增不减 | 批次 3 |
| Continue in project | ❌ 不做，收益不明 | — |
| Team 协作 / 共享 | ✅ **持平** —— 官方 beta 期间同样不支持 | 见 Q6 |
| GitHub App / connectors / cloud environment | ❌ 不做，走 `gh` CLI + DSH 自己的 MCP | 载体差异 |

## 7. 复核者可以怎么回答

不必逐条回。最有价值的四种回答：

1. **「第 2 节哪条判断的理由不成立」** —— 理由错了比结论错了更值得指出，会传染到下一个决策（上一轮的三处指正都是理由层面）。
2. **「第 3 节哪个疑问你们其实能从文档 X 推出来」** —— 有些我们以为文档没说，可能只是没读到。
3. **「第 5 节的顺序里，哪一批做了以后会推翻前面某批」** —— 顺序错要返工，这是最贵的错。
4. **「你对我们的复刻边界有误解」** —— 如果我们又把某个载体差异当成功能缺口（或反过来，把功能缺口当成载体差异），请指出。

如果只能回答一个问题，请回答这个：

> **六个分组是不是互斥的？一个「PR 开着、CI 绿、等 reviewer」的线程，落在 `Ready for review` 还是 `Waiting on you`？**

因为它决定了判断 G 的形状，而批次 3 的主要工作量在那里。

如果还能回答第二个：

> **paths-first 下官方有没有 prompt 层面的引导？**（请给原文）如果只是纯自主，我们需要自己加一句，那就成了一个偏离。

## 8. 引用来源

| 代号 | 来源 | 覆盖范围 | 本轮地位 |
| --- | --- | --- | --- |
| `OFFICIAL` | <https://code.claude.com/docs/en/claude-projects>（[`.md`](https://code.claude.com/docs/en/claude-projects.md)） | 线程模型、路由、Overview 六分组、卡片动作、设置项、Pause/Archive/Delete、goal、仓库约定、限制、云端环境 | **唯一功能规格来源** |
| `DSH` | <https://github.com/deepseek-ai/deepseek-harness> | Host 服务契约：`subagents`、`userQuestions`、`approval`、`worktrees`、`sessionProjections`、`automation`、`systemPrompt`、`tools` | **唯一宿主能力来源**。判断 I、K、M 与 `BOUND` 全部靠它 |
| `RAG` | https://support.claude.com/…-rag-for-projects | 知识模式触发条件、10 倍容量、检索工具 | ❌ **已除名**，讲的是另一个产品，见判断 H |
| `SPEC` | 本项目 `PROJECT_BETA_SPEC.md` | 五模块定义 | 内部文档，与 `OFFICIAL` 冲突时以 `OFFICIAL` 为准 |
| `REPO` | 本仓库 https://github.com/EliteOtaku/dsh-NewProjects | 我们的实现与证据行号 | 每条 `GAP-*` 的「现状」出处 |

本文档中所有引号内的英文均为逐字引用，可用上表链接核对。若发现引文与原文不符，请指出 —— 那说明我们的取证有误，应该先修取证再谈判断。

我们的完整差距登记簿（24 条，含代码证据与验收标准）在 `docs/GAPS.md`。

## 9. 复核后的收尾（2026-10-30 补记）

上面 §1–§8 是送审时的原文，**保留不改**。本节逐条记下 §3 的六个疑问与 §4 的七条自疑最后落在哪里，免得下一轮复核者按原文重新提问。编号对不上时注意：`REVIEW-RESPONSE.md` 是对更早一版提问的回执，它的 Q 编号与本文 §3 不同，下表已对齐。

### §3 疑问

| 本文 | 结论 | 出处 |
| --- | --- | --- |
| Q1 六分组互斥还是重叠 | ✅ 互斥（按构造成立）；人阻塞优先于 PR 生命周期位置 | `REVIEW-RESPONSE` Q6、`REVIEW-RESPONSE-2` 问题一 → `GAP-04` |
| Q2 `Resolved` 的「一周无活动」 | ✅ 任何事件都算活动，PR 事件也算，不给「还开着 PR」加特例 | `REVIEW-RESPONSE` Q4 → `GAP-05`，`RESOLVE_AFTER_MS`（`src/core/overview.ts`） |
| Q3 `Merge it` 之后 | ✅ 合并即 `Resolved`；区分终局错误与可重试错误，加显式退订 | `REVIEW-RESPONSE` Q5 → `GAP-24` |
| Q4 共享 `.git` 的并发边界 | ⚠️ 复核者给了风险表（工程判断）。**本节核对时发现，上文写成「已知护栏」的五条里有两条代码里没有**：`gc.auto=0`、「线程永不写 `.git/config`」 | `REVIEW-RESPONSE` Q1 → 新登记 `GAP-30`；裁定：禁令补进线程 prompt（#6），`gc.auto` 不做 |
| Q5 修 CI 是新工作还是续聊 | ✅ 是续聊（reviving），贵是预期的；止损手段是显式退订，不是换线程 | `REVIEW-RESPONSE` Q2 → `GAP-23` / `GAP-24` |
| Q6 要不要现在留 `owner` 字段 | ✅ **不留**（复核者未作答，以下是我方结论） | 见下 |

**Q6 的理由**：`OFFICIAL` 明写「A project belongs to one user」，`GAP-A3` 判为持平。而且「以后再加」几乎没有额外代价：manifest 读取只校验 `schema === 1`（`parseSnapshot`，`src/core/manifest.ts`），不拒绝未知字段，所以将来加一个**可选**的 `owner`、缺省时当作本机用户，既不升 schema 也不迁移数据。共享真正的障碍不是缺一个字段，而是 manifest 与配额账本（`quota.json`）都是**单机文件** —— 要共享得先有同步层，到那时字段只是最小的一步。现在加只会多一个没人读的字段。

### §4 自疑

| # | 结论 | 出处 |
| --- | --- | --- |
| 1 「主序是生命周期」 | ✅ 理由修正、结论保留：分组是 state 的投影，不是两层模型 | `GAPS.md`「已修正的错误判断」2026-10-28 两行 |
| 2 paths-first 只给清单 | ✅ 已从清单升级为**索引**（路径 + 规模），引导编码在读取协议里 | `REVIEW-RESPONSE-2` 问题二 ③ → `GAP-22` |
| 3 审批改译丢失线程现场上下文 | ⚠️ 前提已变（线程不再被打回人的队列，收尾时自报 commit 与验证），原担心大半不成立；剩下的是**放行范围**问题：一次放行覆盖之后所有推送，自愈轮里线程在请示而宿主不再问人 | 新登记 `BOUND-6`；裁定为放宽：已放行就不再让自愈轮请示（#6） |
| 4 知识路径锚定项目根 | ✅ 复核者给了原文支持；按方案 A 实现 | `REVIEW-RESPONSE-2`「判断 I」→ `GAP-22a` |
| 5 BM25 + 中文 bigram 会漏语义查询 | ✅ 关闭。复核者建议补的不是向量检索而是**导航**；`project_knowledge` 的 `tree` / `read` 已于 2026-10-30 补齐，搜索结果的 hint 也指向它们 | `REVIEW-RESPONSE` §5.4 → `GAP-22` 第 3、4 条（`119ac9e`） |
| 6 `planOnly` 默认值 | ✅ 落地为「模型给了计划就直接起，降级到正则兜底时只提议」 | `GAP-26`（`coordinate` 的 `planOnly ?? plan.origin === 'fallback'`） |
| 7 不做 Scheduled tasks | ✅ 复核者同意：官方把它列为 Overview 的独立标签页 | `REVIEW-RESPONSE-2` 判断 M |
