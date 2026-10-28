# 复核回执：Projects 复刻的判断与疑问

复核者：Claude (Opus 5)，2026-10-27
复核对象：[`docs/REVIEW-REQUEST.md`](./REVIEW-REQUEST.md) @ `8dad36c`

## 怎么读这份回执

按你们 §8 要求的三种回答组织，**先回两个头号问题**，再逐条给判断的理由复核，最后是引文核对与排期复核。

三种标记沿用你们的：✅ 文档可逐字核对 / ⚠️ 我的推断 / ❓ 文档确实不够、我也不能裁定。

我核对的是两个来源的当前版本（2026-10-27 抓取）：

- `OFFICIAL` = https://code.claude.com/docs/en/claude-projects **全文**
- `RAG` = https://support.claude.com/en/articles/11473015-... （该站点只给到摘要，逐字引用我标注为未核）

你们说"复核者不需要读我们的代码"。我读了四个文件（`overview.ts`、`prompt.ts`、`knowledge.ts`、`planner.ts`），**因为其中两处直接推翻了你们对自己改动代价的估算**。下面标了行号的地方都是这个原因。

---

## 0. 两个头号问题的答案

### 头号问题：判断 A 的「轮到谁」这个轴，对还是过度解读？

**过度解读了一半；更要紧的是，你们为它估的代价是假的。**

三件事分开说：

**① 六分组里只有两个是「轮到谁」，不是五个。**

| 分组 | 官方定义 | 是「轮到谁」吗 |
| --- | --- | --- |
| `Waiting on you` | "need your reply or approval, or that failed" | ✅ 是，人 |
| `Working` | "Threads still running" | ✅ 是，AI |
| `Ready for review` | "pull request is open and **awaiting review**" | ❌ PR 生命周期位置。等的是 reviewer，而 reviewer 不必是项目所有者 —— 跟 `Waiting on you` 里那个 "**your**" 不是同一个人 |
| `Landing` | "pull request is **approved or queued to merge**" | ❌ PR 生命周期位置。approved 之后谁都没在等，队列自己在动 |
| `Idle` | "Threads that **finished and aren't waiting on anything**" | ❌ **明确「不等任何人」** |
| `Resolved` | "marked done: by you… by Claude… or automatically after a week" | ❌ 终态标记，三条入口 |

`Idle` 是决定性的反例。它的官方定义里 "aren't waiting on anything" 是原文。在一个二元 `ai | human` 的第一层里，`Idle` 没有合法取值 —— 你们只能把它硬塞进某一侧，而塞进哪一侧都是错的。真正的轴是**工作在生命周期里的位置**，其中恰好有一个分组（`Waiting on you`）被挑出来做「需要你」的收口。这个读法比「轮到谁」弱，但它能容纳全部六个分组，而你们的读法容纳不了。

**② 你们的理由 2 不成立，而且官方原文直接回答了它。**

你们从「`failed` 被放进 `Waiting on you`」推断底层存在两层模型。但官方那一节的原句是：

> The pane's **Threads** tab **groups threads by state**

分组是**对 state 的投影**。state 是一维的，分组是派生函数。这一句就是对「底层是不是两层模型」的直接回答：不是。`failed` 和 `needs_feedback` 落在同一个桶里，说明的是**桶的映射**把它们合并了，不是说明 state 多了一层。

你们在 §8 说「理由错了比结论错了更值得指出，因为会传染到下一个决策」。这一条就是会传染的那种：把「UI 分组」当成「底层模型」的证据，下一次看到任何界面聚合都会再推一次同样的结论。

**③ 你们列的破坏性改动代价是假的，因为那个派生层你们已经写好了。**

你们写「改状态枚举是破坏性改动，要同时改投影的 `stateSchema`、`stateVersion`、所有测试断言、以及已落盘的旧数据迁移」。但 [`src/core/overview.ts:40`](../src/core/overview.ts) 的 `bucketOf(status)` 就是一个现成的 `state → bucket` 派生函数，而 [`src/core/overview.ts:21`](../src/core/overview.ts) 的 `BUCKET_ORDER` 只有 5 个桶 —— 你们早就不是 7 状态直通 UI 了。

你们理由 3 抱怨的那个真问题（「前端要显示『有 3 个失败』和『有 2 个等你』两处」）的成因不在 `ThreadStatus`，**在 `BUCKET_ORDER` 里把 `failed` 单列了一项**。修法是：

```ts
// overview.ts: failed 并入 waiting_for_feedback，对上官方 "or that failed"
case 'needs_feedback':
case 'failed':
  return 'waiting_for_feedback';
```

加上 `BUCKET_ORDER` 删一项、`BUCKET_LABELS` 删一项、`totals.failed` 改成从 `status` 数而不是从桶数。二十行以内。`ThreadStatus` 不动，`stateVersion` 不升，落盘数据不迁移，测试断言只动数桶的那几条。

**所以：结论（用户只看一处）对，理由错，代价估高了一个数量级。**

**④ 真正该改的是枚举缺项 —— 而这是加法，不是重构。**

| 官方状态 | 你们的 | 缺口 |
| --- | --- | --- |
| `Working` | `queued` / `running` / `ci_fixing` | ✅ |
| `Ready for review` | `awaiting_review` | ✅ |
| `Waiting on you` | `needs_feedback` + `failed` | ✅ 状态齐，桶要合（见上） |
| **`Landing`** | — | ❌ 缺。「approved / queued to merge」没有任何表示 |
| **`Idle`** | `completed`（与 Resolved 混为一个） | ❌ "finished and aren't waiting on anything" 跟「人确认完了」是两回事 |
| **`Resolved`** | `completed`（同上） | ❌ 可 reopen 的 done |

加一个 `landing`，把 `completed` 拆成 `idle` + `resolved`。三个加法 + 一次桶映射修正，拿到官方全部六分组，不触及现有状态的语义。

这个版本的改动既满足了你们判断 A 想要的 UX（用户只看一处），又不需要你们为之定价的那场迁移。

---

### 第二号问题：知识阈值按哪个模型的窗口算？「10 倍」相对什么？

**按 `min(协调者窗口, 线程窗口)`。但更要紧的是：这个问题在 Code Projects 的设计里本来不该存在 —— 你们从错的产品继承了这整套语义。**

**① 证据：`OFFICIAL` 全文零次出现 RAG 相关概念。**

你们 §9 写「全文不含 RAG 字样」。核实通过，而且比你们说的更强 —— 我 grep 了整页：

| 词 | 出现次数 |
| --- | --- |
| `RAG` | 0 |
| `retrieval` | 0 |
| `project knowledge` | 0 |
| `/mnt/project-files` | 1 |

那唯一一次是：项目文件「the folders and files it can read under `/mnt/project-files`」—— **挂载给线程的文件系统**，线程用普通文件工具读，产出走 Library 标签页。Code Projects 根本不把知识塞进 prompt，所以它**没有**「全文模式 vs 检索模式」这个切换，也就没有阈值。

**② `RAG` 那篇讲的是另一个产品。** 它写 RAG "available on paid plans: Pro, Max, Team, and Enterprise"，而 `OFFICIAL` 明写 "Projects aren't offered on Team or Enterprise plans yet"。两边的 plan 矩阵对不上 → `RAG` 那篇说的是 claude.ai chat 的 Projects，也就是 `OFFICIAL` 自己称作的：

> the earlier Projects experience, which groups conversations and reference files **without threads or a coordinator**

你们复刻的是有 threads 和 coordinator 的那个，知识机制写的是没有 threads 和 coordinator 的那个。

**③ 所以你们 §5 第 6 项的自评要重新分类。** 你们写「知识切换阈值写死 96,000 字符，怀疑强度高」。问题确实存在，但诊断错了方向：不是常量选错，是**整个 in-context / RAG 二分从错的产品抄来的**。按你们原来的诊断去修（把常量改成窗口派生），得到的是一个更精确的错误。

**④ 如果仍保留 in-context 注入，窗口口径的答案由你们的架构给出，不是文档给出。**

[`src/core/prompt.ts:7`](../src/core/prompt.ts) 的注释写得很清楚：

> `renderProjectCharter` goes into a global system-prompt section. **All threads and the coordinator share it**, so their prefixes match

一段字节相同的前缀被两个可能不同的模型消费。预算必须对**最小**的那个窗口安全。按协调者算（你们倾向的那个）在 `Thread model` 比 `Coordinator model` 小时会直接溢出线程窗口 —— 而官方把这两个做成**两个独立设置**（`Project settings > General`：Coordinator model/effort 与 Thread model/effort），默认甚至 effort 都不同（协调者 low，线程 high），正是为了让人把它们设成不一样。

→ **取 `min(coordinatorWindow, threadWindow)`。**

顺带回答你们那个担心：⚠️ **`prefixVersion` 不会分叉**。charter 本来就是全项目一份、字节相同（这是你们自己的设计约束），一个项目一个预算、一个前缀。你们担心的「按各自线程模型算会导致 prefixVersion 分叉」只在你们把 charter 做成 per-thread 时才会发生，而你们没有。

**⑤ 「10 倍」相对什么：相对切换前那个按窗口算的容量，没有固定基线。** `RAG` 说 "up to 10x more content"，上下文指的是相对原先受上下文窗口限制的容量。所以 `knowledgeCapacity = budget × 10`（[`knowledge.ts:58`](../src/core/knowledge.ts)）**结构上是对的** —— 前提是 `budget` 本身随窗口走，不是 `96_000`。

**⑥ 比例：你们提的 50%~70% 太高。** 你们的理由是「留 30%~50% 给对话、system prompt、工具结果」。漏了一样最大的：**线程是要动手的**。它要读文件、跑测试、把 diff 和失败日志拿在手里。知识是静态开销，被这些动态开销挤压。

⚠️ 建议 ≤25%~30%，并且**两个阈值做 hysteresis**（例如 30% 切 `rag`、22% 切回 `context`）。理由是你们文档里没提的一条：

你们在 [`knowledge.ts:63`](../src/core/knowledge.ts) 把 mode 做成 `totalChars <= budget` 的纯函数，并在注释里把「从不存 flag」当成正确性保证。方向对 —— 但单阈值纯函数在边界上会**抖动**。一个体积贴着阈值的项目，每加一句记忆就翻一次 mode，charter 就换一次字节，你们整个 prefix cache 设计就被这一个布尔抵掉了。

而官方措辞本身就暗示切换点在上限之下：

> RAG automatically activates when your project **approaches or exceeds** the context window limits

"approaches" 就是第一个阈值。"If your project knowledge later **drops below** the context window threshold, Claude can automatically convert back" 是第二个。两个阈值不是我加的，是原文里就有两个动作。

**⑦ 我真正建议的方向（减法）：paths-first。**

[`src/core/prompt.ts:85`](../src/core/prompt.ts) 已经有这条路径了 —— 没有索引时渲染 `## Bound project knowledge` + 路径清单，让线程自己读。**那个 fallback 才是 Code Projects 的形状**（`/mnt/project-files` + 文件工具）。把它和索引注入倒过来：

- 读盘为主：路径清单进 charter，线程按需读。窗口开销 ≈ 0，阈值问题消失，`DEFAULT_CONTEXT_BUDGET_CHARS` 这个常量不再需要存在。
- 全文注入降级为**小项目优化**：只在确实很小时做，因为它能命中 prefix cache，这是个真收益，但它是优化而不是机制。
- BM25 保留为**便利工具**，不再是「模式」。

这条顺带消掉你们批次 1 的另一项，见 §4。

---

## 1. 判断 A–F 的理由复核

判断 A 见 §0。

### 判断 B：投影必须晚于状态模型 —— ❌ 约束不成立

你们的理由是「投影的 `stateSchema` 由状态枚举决定」。这个因果在你们的代码里已经被打断了：`bucketOf()` 把枚举和桶解耦，`BUCKET_ORDER` 只有 5 项而枚举有 7 个。投影要暴露的是**桶**，不是枚举。

官方也是这么分的：✅ "groups threads by state" —— 分组是 state 的函数。前端消费的是分组，所以前端对枚举不敏感。

所以你们问的「还是说投影层可以做薄一点（只投影原始 descriptor、分组留给前端）」—— 答案是**既不用做薄，也不用等**：分组留在 `overview.ts`（你们现在就是这样，而且这是对的，注释里「there is no second source of truth for 'which bucket is this thread in'」这个理由是站得住的），投影暴露 `{descriptor, bucket}`，枚举后加的 `landing`/`idle`/`resolved` 只改 `bucketOf` 的 case，`stateSchema` 不变。

**→ 批次 2 与 3 可以合并。你们在判断 B 里写「如果是后者，我们的第 2、3 批可以合并，能省一整批」—— 这一整批是真的能省，但省的理由跟你们设想的不同：不是因为投影能做薄，是因为解耦层已经在了。**

### 判断 C：只有合并需要人批准 —— ⚠️ 线划得基本对，但执行者划错了，而且漏了两个动作

**线本身：有据支持，比你们引的更强。** 官方给的项目指令示范里有这么一行：

> Don't **merge**, **force-push**, or **change CI configuration** without asking me in the thread.

这是官方自己把「需要人点头」的动作列出来了，而且比你们表格里多两项：

| 动作 | 你们 | 官方示范指令 |
| --- | --- | --- |
| merge | ✅ 人点 | ✅ 需要问 |
| **force-push** | ❌ 未提，落在「分支上 push」那一格的「完全可逆」里 | ⚠️ 需要问 |
| **改 CI 配置** | ❌ 未提 | ⚠️ 需要问 |

force-push 被你们归进「完全可逆，分支随时删」是错的：它是**重写他人可能已拉取的历史**，和普通 push 不是一类。改 CI 配置更隐蔽 —— 一个自愈线程在修 CI 时最省力的"修法"就是改 CI 本身，而你们 `buildHealPrompt`（[`healing.ts:103`](../src/core/healing.ts)）第 2 条只禁了「weaken, skip, or delete the failing assertion」，没禁改 workflow 文件。⚠️ 建议把这条补进 heal prompt。

**执行者：你们划错了。** 官方把卡片动作分成两类，执行者不同：

> **Resolve conflicts**, **Fix CI**, **Address comments**, and **Merge it** send that instruction to the thread **as a message from you**
>
> **Create PR** … Clicking it creates the pull request from that branch **directly rather than sending the thread an instruction** to open one.

即：merge 是**人触发、线程执行**；只有 Create PR 是**宿主直接执行**。你们现有的 `deliver`（≈Create PR）恰好对上了那个唯一宿主直办的动作 —— 巧合但对了。将来做 `Merge it` 时**不要**让宿主代跑 `gh pr merge`，要给线程发一条消息。理由不是形式，是责任链：线程才知道自己的 PR 现在是什么状态、要不要先 rebase、合完要不要清理。

**你们的 ❓ 问题（CI 全绿 + approve + 无冲突，官方会让线程自己合吗）：⚠️ 几乎可以确定不会。** 三条证据：

1. `Merge it` 是一个**要人点的按钮**，而它存在的理由官方写明了：「so you can prompt the thread yourself **instead of waiting for it to react to the pull request**」—— 言下之意，线程自己不会 react 到"可以合了"这件事。
2. 官方的项目指令示范里明写 "Don't merge … without asking me"。官方拿它当**示范**写出来，说明这是推荐姿态。
3. `Resolved` 的定义是 "by Claude once **you've** taken the last step, such as merging its pull request" —— 最后一步的主语是 you。

至于 "queued to merge"：⚠️ 最可能指 GitHub 自己的 merge queue / auto-merge，即**人触发之后**排队，不是 Claude 决定去合。`Landing` 这个分组名（落地中）也支持这个读法：球已经踢出去了，在飞。

**你们漏的半不可逆动作（本地平台特有）：**

你们那条「关键平台差异」推得很好，但这一格没推到。官方线程跑在一次性沙箱里，你们跑在用户真机：

| 动作 | 云端沙箱 | 你们本地 |
| --- | --- | --- |
| `git gc` / `git prune` | 自己的 clone，无所谓 | 共享 `.git`，影响所有线程（见 Q1） |
| 写 `.git/config` | 自己的 clone | 共享，会被别的线程看见 |
| `git worktree remove` | 不存在 | **不可逆，未推送提交丢失** |
| 删远端分支 | 同 | 同 |
| 写 worktree 之外的路径 | 沙箱边界拦住 | **没有边界** |

最后一行是最值得补一条护栏的：你们的 charter 里有「do not switch branches or touch the main checkout」，但那是**说给模型听的**，不是约束。

### 判断 D：DSH 上不需要「项目绑定一段长期会话」—— ✅ 结论对，而且官方给了你们缺的那份清单

**你们的三个问题逐个回答：**

**D.1 「不绑定会话、只维护『等你决定』清单」会不会丢掉只有长期对话才有的价值？**

✅ **不会，而且官方的协调者本身就不靠长期对话。** 原文：

> You don't manage context windows in a project. Threads compact automatically, and **the conversation works from recent messages, recent threads, and project memory rather than its full history**, so it keeps going for as long as the project runs.

这句话有两重作用：

1. 它直接否掉「长期对话 = 上下文累积」这个你们担心丢掉的价值 —— 官方的协调者**主动不用**完整历史。
2. 它给了你们那个「协调日志」该存什么的**确切清单**：`recent messages` + `recent threads` + `project memory`。你们现在的四项里有 2、4（threads、memory），缺的是 **recent messages**（协调者侧最近几轮的对话），不只是你们说的那个「等你决定」清单。

还有一条支持：官方有 **`Restart Claude`** —— 「Restarts the project conversation」，而且「threads aren't affected」。协调会话是**可重启的、可丢的**，threads 和 memory 才是持久的。一个官方自己提供「重启按钮」的东西，不该被你们复刻成必须绑定的身份。

**→ `GAP-07` 从「项目绑定会话」改成「协调状态跨会话可恢复」是对的。补一句：那个状态是三件套（近期消息 / 线程摘要 / 记忆），不是两件套。**

**D.2 「每次显式调用拆解工具」能做到官方路由的几成？**

官方三条规则，你们各自的覆盖：

| 官方规则 | 你们 | 评价 |
| --- | --- | --- |
| 「快问快答留在对话里」 | ❌ 没有 | **这是用户体感最差的一条** |
| 「新工作开新线程，或转给已在做这块的线程」 | ⚠️ 只有前半 | 可接受 |
| 「一条消息里多个无关任务拆成多条」 | ⚠️ 取决于拆解质量 | 见 §3 第 1 项 |

⚠️ 掉的最厉害的是第一条。在云端，路由错了的代价是起了一个白跑的沙箱；在你们这儿，是**建了一个 worktree、切了一个分支、起了一个子会话**，然后用户发现自己只是问了一句「这个 flag 是干啥的」。这个代价是可见的、用户会抱怨的。

而这条**不需要路由算法**。它只需要一个判断：「这是个问题，还是一件活」。你们不做自动路由可以，但这一个判断值得做 —— 而它恰好是模型该做的那种判断，不是正则能做的。接 §3 第 1 项。

另外官方对路由的态度是**可错可纠**，不是必须准：「If Claude routes something differently than you wanted, **say so**」，而可说的话里就有「Reuse an existing thread for follow-ups in the same area」「Answer that here instead of starting a thread」。所以你们「默认开新线程，用户要转就明说」的方向是对的 —— 它就是官方的 fallback 路径。你们只是把 fallback 当成了唯一路径。

**D.3 「云端能跨设备续是因为服务器持久化，本地做不到所以不该假装做到」——⚠️ 结论对，但前提比你们以为的宽松，而且官方给你们背书。**

官方**支持**线程跑在用户自己的电脑上，通过 Remote Control，而且：

> In a git repository, add `--spawn worktree` to give each thread there **its own worktree**

**这就是你们的架构，官方认账。** 并且官方对这种线程写明了三条限制，你们可以直接抄作 README 口径，比你们自己措辞更有力：

- "Runs only while that computer is awake with Remote Control turned on"
- "The thread **pauses** while that computer is asleep, and **stops** if the desktop app or `claude remote-control` quits"
- "Starts with the project's instructions, **but not with its memory files loaded**"

第三条是你们可能会踩的：官方在本地线程上**不加载记忆文件**，只给 instructions。你们的 charter 是把 memory prefix 注进去的（[`prompt.ts:56`](../src/core/prompt.ts)）。这不算错 —— 你们在本地能读到文件，官方那边是跨设备传输成本问题 —— 但如果以后有人拿官方行为对你们提 bug，这是出处。

### 判断 E：并发数不设硬上限 —— ⚠️ 引文对，但「连偏好都不给」是个缺口

引文核对通过，逐字无误。

但你们漏了紧接着那段的另一句：

> Claude **saves preferences like these to project memory** on its own and follows them in later cloud threads. They're instructions Claude keeps to, not enforced settings, so a thread limit you give this way isn't a hard cap. **Add one to project instructions when you want it worded exactly and applied to every thread from the start.**

所以官方的「偏好」不是「什么都不做」，而是：**偏好被持久化进记忆/指令，由模型遵守**。你们有记忆层、有 instructions 层，这条实现成本接近零 —— 在 planner 读 manifest 时把「并发偏好」当成一条记忆读进来即可。

⚠️ 另外，官方首批建议里明确有这条：「Ask Claude to propose threads before starting them **and to run a few at a time**, and drop those limits once a few threads come back the way you want」。即官方认为**新项目应该从低并发开始**。你们在本地平台上更该有这个 —— 云端并发的成本是 token，你们的成本是 token + 磁盘 + 宿主进程 + 同一台机器的 CPU。

**→ 不加硬上限是对的（有据）。但应该让并发偏好可表达、可持久化、planner 读得到。这不是「软建议」的妥协，这就是官方的做法。**

注：`MAX_PLANNED_TASKS = 8`（[`planner.ts:18`](../src/core/planner.ts)）是「一次拆解最多几个」，和并发不是一回事 —— 连续两次 coordinate 就是 16 个线程在跑。你们文档里把它当成了并发限制的替代，它不是。

### 判断 F：失败算人的回合 —— ✅ 对。`Resolved` 问题有答案

**F 本身有据**：✅ 失败进 `Waiting on you`，而出口也有原文 —— troubleshooting 里讲处理猜错的线程：

> open the thread from **Overview** and **mark it resolved from its menu**, or tell it what to do instead in its message box

所以 `failed → (人处理) → Resolved` 这条路，官方在 troubleshooting 里明写了。你们的推论对。

**你们的 ❓「`Resolved` 是不是唯一正常终态？`Idle` 会不会自动转 `Resolved`？」**

✅ 两个都有答案，而且第二个和你们问的方式不一样：

`Resolved` 的官方定义列了**三条入口**：

> marked done: **by you** from the thread's menu, **by Claude** once you've taken the last step, such as merging its pull request, or **automatically after a week with no activity**

注意第三条的主语：是 `Resolved` 的入口条件，**不是 `Idle → Resolved` 的转移**。一周无活动的线程直接变 `Resolved`，不管它之前在哪个桶。所以你们问的「`Idle` 会不会自动转 `Resolved`」问法本身偏了 —— 不是 `Idle` 的特权，是所有状态的兜底。

而且 `Resolved` 不是吸收态：「You can **reopen** one from the same menu」。所以：

- ✅ `Resolved` 是唯一的"正常 done"，但它可逆。
- ✅ `Idle`（"finished and aren't waiting on anything"）是一个**独立**的活状态，不是 `Resolved` 的前置 —— 这也是 §0 ④ 说要把 `completed` 拆成两个的原因。

---

## 2. Q1–Q6

### Q1 线程之间互不污染的边界 —— 官方踩过同一个坑，给了同一个解

**先说好消息：你们那个"真实缺陷"官方也有，而且解法一样。** 官方讲本地线程时写：

> **Two threads working in one folder at the same time can overwrite each other's changes**, so if the folder is a git repository, you can turn on **Worktree** in the folder's options to give this thread its own worktree instead.

你们写「只建分支时，线程仍在父检出里跑，并发时会互相看见未提交改动 —— 这是我们踩过的真实缺陷」。同一个缺陷，同一个解（worktree）。✅ 你们"每线程一个 worktree"的方向有官方背书，而且 `claude remote-control --spawn worktree` 是官方 CLI 自己的开关。

**共享 `.git` 的具体风险（⚠️ 文档无，工程判断）：**

worktree 之间隔离的是工作区、索引（每个 worktree 有自己的 `index`、`HEAD`）。**共享的**是 object database、`packed-refs`、`.git/config`、以及 `worktrees/` 元数据。具体会咬人的：

| 操作 | 风险 | 建议 |
| --- | --- | --- |
| `git gc` / 自动 gc | 并发 gc 会互相报错；更糟的是 gc 会 prune 掉另一个 worktree 刚写的、还没被 ref 指向的 object | 在共享仓库上设 `gc.auto=0`，gc 由宿主在无活动线程时串行做 |
| `git worktree prune` | 会清掉"看起来失效"的 worktree 元数据 | 同上，只由宿主做 |
| 写 `.git/config` | 任何线程改了（比如设 `user.email`、加 remote）全局生效 | **线程永不写 config**，需要什么用 `git -c k=v` 单次传入 |
| 凭证 / askpass | 共享 config 意味着共享 helper | 每线程独立 `GIT_ASKPASS` / env，不落 config |
| `packed-refs` 并发写 | git 自己有锁，会报 `cannot lock ref`，不是静默损坏 | 重试即可，但要**重试**而不是当成失败 |

最后一行值得单独提：`cannot lock ref` / `index.lock` 是**可重试的瞬时错误**。你们 [`healing.ts`](../src/core/healing.ts) 把 `normaliseConclusion` 的未知值兜成 `pending` 那个判断（注释里讲 false green 的那段）写得很好 —— 同一种谨慎应该用在 git 错误上：锁冲突不该把线程推进 `failed`。

**`healSweep` 并发唤醒算不算污染：⚠️ 不算。** 两个线程的 worktree 独立、分支独立、PR 独立，对远端的操作是 per-ref 原子的。官方那边同样有多个线程同时 watch 各自 PR（"an idle thread wakes up … when CI fails or a review comment arrives on **its** pull request"），并且把它当正常成本列在 "What draws on your plan" 里，不当问题。唯一真风险是两个线程动同一个分支，而你们一线程一分支已经排除了。

### Q2 线程边界 / 修 CI 三轮 —— 「新工作还是复活」这个问题文档有答案

**续聊同一会话：✅ 对上官方。** 线程 "does one piece of work"、有自己的 context window、"Threads compact automatically"、并且开 PR 后持续 "watches the pull request" —— 是同一个会话继续，不是新建。

**「修 CI 属于 new work 还是reviving」：✅ 属于 reviving，而且官方把它当预期成本，不当要避免的事。**

你们引的那句（"For new work, asking Claude to start a fresh thread can use less than reviving a large old one"）出现在 **"See and reduce a project's usage"** 一节 —— 它是**省钱建议**，不是语义定义，而且它的条件是 "**For new work**"。修自己 PR 的 CI 不是 new work：需要的上下文正是这个线程自己的 diff 和它做过的决定。换新线程就是把那份上下文扔了再重建。

而官方把这件事明确列在 "What draws on your plan"：

> **Threads watching a pull request**: an idle thread wakes up and uses your plan again when CI fails or a review comment arrives on its pull request. **To stop that, ask in the thread for it to stop watching the pull request.**

所以：✅ 它是 reviving，✅ 它贵是预期的，✅ 官方的止损手段是**显式退订**，不是换线程。→ 你们需要一个 `unwatch`（接 Q5）。

**「最多 3 轮」这个上限：⚠️ 官方没有对应物，但你们需要一个；只是轴选错了。**

官方的护栏是 **turn 上限**（`CLAUDE_CODE_MAX_TURNS`，报 "Reached the turn limit"）和 context 上限，不是"修复轮数"。

你们 `MAX_HEAL_ATTEMPTS = 3`（[`healing.ts:21`](../src/core/healing.ts)）累计的是**线程生命周期内的总次数**。问题：一个 PR 开了两周、被 review 了四轮、每轮都有合理的新 comment，第四轮会撞上限 —— 但那四轮里没有一次是"修不好"，它们是四件不同的事。

⚠️ 建议把计数改成**连续失败次数**，并在"有进展"时清零。进展的定义可以很糙但有效：

- 一轮之后失败的 check 集合变了（有 check 从 fail 转 pass）→ 清零
- 处理的是**新来的** review comment（你们已经有 `consumedCommentIds`，信息是现成的）→ 清零
- 同一组 check 连续 3 次 fail → 升级给人

这保留了你们要的东西（「a wrong autonomous fix is worse than a question」—— 这个取舍是对的），但不会惩罚正常的多轮评审。

### Q3 知识阈值 —— 见 §0 第二号问题

补一条你们没问的：`knowledge.ts:1-19` 的模块注释把 Projects 的两模式行为当成前提陈述。那段注释现在是**错的来源**（它讲的是 chat Projects）。如果按 §0 ⑦ 改成 paths-first，这段注释要重写；如果保留两模式，至少要注明出处是 chat Projects 而非 Code Projects，否则下一个读代码的人会沿着它再推一次。

### Q4 「一周无活动自动归档」—— 你们把两件事混了，拆开之后担心就消了

**混的是：线程转 `Resolved`（自动）vs 项目 `Archive`（人工）。**

官方这两件事是分开的：

| | 对象 | 触发 | 效果 |
| --- | --- | --- | --- |
| 一周无活动 | **线程** | 自动 | 转 `Resolved`，**可从同一菜单 reopen** |
| `Archive` | **项目** | 只有人点 | 「hides the project from the sidebar and archives its threads, which **stops** any thread that was running or watching a pull request」 |

你们 Q4 问的是"归档"，但官方的一周规则产出的是 `Resolved`，不是 archive。

**「活动」怎么定义：⚠️ 并集，而且 PR 事件确实算。** 依据是上面那句 "an idle thread **wakes up** … when CI fails or a review comment arrives on its pull request" —— PR 事件会让线程起一个 turn。线程有 turn 就是活动。所以：

**→ 你们那个担心（「PR 开着等 review，reviewer 三周后才来，按无活动归档就没人管了」）在官方语义下不成立**，两个原因：

1. 正在被评审的 PR 会产生 comment / CI 事件 → 线程被唤醒 → 有活动。真正"一周零活动"的 PR 是**谁都没碰过**的 PR。
2. 即使真转了 `Resolved`，那是个**可 reopen** 的标记，不是停止。而会"stop any thread watching a pull request"的只有项目级 `Archive`，那需要人点。

→ 所以不需要"归档排除还开着 PR 的线程"这条特例。需要的是：`Resolved` 可逆（§0 ④ 已包含），以及你们的自动转换**不要停掉 PR 监视**，只改状态标记。

### Q5 `Merge it` 之后 —— ✅ 两个问题都有答案，且你们说的那个 bug 是真的

**「立即 Resolved 还是先 Idle」：✅ 立即 `Resolved`。** 官方 `Resolved` 的定义里直接点名了这个场景：

> by Claude once you've taken the last step, **such as merging its pull request**

主语是 Claude（即线程/协调者自己标），时机是"人做完最后一步之后"，不经过 `Idle`。

**你们说的那个边界 bug：✅ 是真的，而且根因不在状态机。** `decideHealAction` 的第一条就是 `prState === 'merged' → transition completed`（[`healing.ts:160`](../src/core/healing.ts)），顺序也对（注释里"a merged/closed PR settles the thread before any check noise"这个取舍是对的）。所以状态机本身会处理。

真正的问题是**它要先轮询才知道**：`healSweep` 必须跑一次 `gh pr checks` / `gh pr view` 才能看到 `merged`，而 PR 合并 + 分支删除之后那次调用会报错 —— 于是第一次发现"已合并"的路径是一次失败的 CLI 调用。

⚠️ 两处要改：

1. `healSweep` 的轮询错误要能区分「PR 没了 / 分支没了」和「网络/认证挂了」。前者是**正常终局**（去查 PR 状态，大概率 merged → 转 `resolved`），后者才是错误。现在两者都走同一条失败路径。
2. 需要一个**显式退订**。官方的说法是 "ask in the thread for it to stop watching the pull request" —— 即退订是一等动作。合并后、`Resolved` 后、项目 Archive 后都要退订。你们现在的"退订"是隐式的（状态不在 `awaiting_review` 就不扫），这就是为什么合并后它还在扫。

### Q6 六个分组互斥还是重叠 —— ✅ 互斥，你们对了

两条证据：

1. 原文 "**groups threads by state**"。按 state 分组，每个线程一个 state，所以一个桶。
2. 你们看到的那个"重叠"是读法问题：`Waiting on you` 的 "need your reply or **approval**" 里的 approval 不是 **PR approval**，是**权限审批**。官方有专门一节 "Unblock a thread waiting on approval"：

> Threads run in auto mode … When a thread needs your approval, the prompt is **inside that thread** and the thread waits until you answer it **there**.

所以 `Ready for review`（等 PR review）和 `Waiting on you`（等你回答问题 / 批权限 / 处理失败）是两件不同的事，不重叠。

**→ 你们的互斥模型正确，不需要改成多维标签。**

---

## 3. §5 自疑清单的裁定

| # | 你们的怀疑强度 | 我的裁定 |
| --- | --- | --- |
| 1 拆解不调模型 | 高 / 可能根本性 | **✅ 确认，是最该先修的一项** |
| 2 产出只记 name-status | 中 | **✅ 确认，但修起来很便宜** |
| 3 记忆只推给运行中线程 | 中 | **❌ 你们做得比官方多，不是少** |
| 4 BM25 + 中文 bigram | 中 | ⚠️ 降级为低：方向可接受，缺的不是语义检索 |
| 5 `needs_feedback` / `failed` 两个状态 | 低-中 | ⚠️ 状态保留，桶要合（§0 ③） |
| 6 阈值写死 96k | 高 | ⚠️ 问题确认，诊断改向（§0 第二号问题） |

### §5.1 拆解不调模型 —— ✅ 确认，而且它不在你们的六批计划里

**理由比你们写的更强。** 你们引了 "Claude acts as coordinator. It takes what you send, decides what becomes a thread"。还有两处：

- `Suggested threads` 是模型输出：「Sometimes Claude **proposes** threads instead of starting them, in a **Suggested threads** list」。确定性文本分析不会"proposes"。
- 路由规则一（"A quick question usually gets an answer in the conversation"）**要求**一个判断：这是问题还是活。正则做不了（接 D.2）。

你们给的理由（「委派模型不可用时也能工作」+「可单测」）两条都是好理由，但它们要的不是"用确定性分析代替模型"，而是"**有一个确定性 fallback**"。差别在于哪个是主路径。

⚠️ 具体建议，三步，都很便宜：

1. **模型优先，正则兜底。** `planner.ts` 现在这一整套（bullet 识别、`splitTitle`、`scopeHintOf`）全部保留，只是降级为 fallback。单测继续测 fallback，测试资产不浪费。
2. **fallback 要可见。** 现在模型不可用时降级是静默的。改成在结果里明说：「委派模型不可用，我按 bullet 切了 3 项，请确认」。你们在 `knowledge.ts` 对"静默给旧答案"的警惕（批次 1 那条）是对的 —— 同一个标准该用在这里：**静默降级的拆解和静默过期的知识是同一类错误**，而且这个更常见。
3. **同时做 `Suggested threads`。** 这是对冲：提议列表把"拆错"的代价从"开了 5 个错 worktree + 5 个分支"降到"用户删掉列表里 3 行"。你们 §7 把它列为"已知未做"，但它其实是 §5.1 这个赌注的保险，应该**和它一起做**而不是单独排期。官方也正是把它当新项目的默认姿态推荐的（首批建议第 4 条：「Propose threads and wait for my go-ahead before starting them，and drop those limits once a few threads come back the way you want」），而且「a button under the list starts all of them」—— 全起一键，成本不高。

### §5.2 产出只记 name-status —— ✅ 确认，修法比你们想的便宜

官方 Library 是 "the files **and folders** you added and the files threads produced"，而且非代码项目「threads deliver each write-up **as a file** on the project's Library tab」。确实是实际文件。

但**你们在本地，文件就在盘上**。Library 不需要收集或拷贝内容：worktree 路径 + git blob 就是内容，按需读即可。云端必须拷贝是因为沙箱会消失（官方自己写 "A cloud thread's sandbox pauses between turns … If the sandbox can't be resumed, the thread continues from a fresh clone, so uncommitted changes can be lost"）。你们没有这个约束。

→ Library = 对 `git diff --name-status` 的清单**加一个按需读取**，不是一个新的存储层。这项从"中"降到"小"。

### §5.3 记忆只推给运行中线程 —— ❌ 你们做得比官方多

官方原文：

> **Changes to instructions, repositories, plugins, and environment in Project settings reach new threads, not threads already running.**

以及记忆的读取时机："Every cloud thread reads the index file `MEMORY.md` **when it starts**"。

所以官方的行为是：**更新只影响新线程，运行中的线程不管。** 你们给运行中线程广播（`renderMemorySteer`），比官方做得多；不给 idle 线程发（省 token）那个判断是对的。

你们问「如果官方是『等线程下次开口时自然带上』，那我们的做法可能过度了」—— ⚠️ 答案是比那还少：官方连下次开口都不带，只有**新**线程带。

→ 这项不是债。如果要动，方向是**删**（去掉实时广播，省一条代码路径和一类竞态），不是补。保留也无害 —— 只是别把它当缺口。

### §5.4 BM25 + 中文 bigram —— ⚠️ 降到低，但缺的东西不是你们想的那个

官方不说检索实现，这条无法从文档裁定。但你们担心的「语义查询会漏」在 Code Projects 的设计里不是主要问题，因为那边线程**根本不用检索**，它们 `ls` 和 `cat` 挂载目录（`/mnt/project-files`）。Agent 在"结构化导航 + 精确读取"上比在"一次检索命中"上强得多。

⚠️ 所以建议补的不是向量检索，是**导航能力**：列出知识文件树、按路径精确读取某个文件某段。BM25 留着做排序入口。这样语义查询漏了的时候，模型有第二条路（看目录、挑文件、读），而不是只能换关键词重试。这也是 §0 ⑦ paths-first 的同一个方向。

---

## 4. §6 排期复核

你们问「哪一批做了以后会推翻前面某批」。有一条，但更要紧的是另一件事：

### 最重要的发现：你们自评最高危的两项，六批里都没有位置

| 项 | 你们的自评 | 在哪一批 |
| --- | --- | --- |
| §5.1 拆解不调模型 | 「**最大的一个技术债，可能是根本性的**」 | **不在 1–6** |
| §7 权限审批「完全不接」 | 未评级 | **不在 1–6** |

这不是漏排，是**排序方法本身过滤掉了它们**。你们按「会不会安静地出错」排 —— 而这两项错得**不安静**：拆解烂是用户一眼看见的，没有审批是用户会亲眼看到文件被改的。于是排序规则把它们排到了"以后"。

但"不安静"≠"不贵"：

- **拆解质量是所有后续批次的输入。** 批次 3（投影 / Library / PR 聚合）、批次 4（Merge / Resolve）都是"把线程呈现得更好、裁定得更方便"。如果线程本身拆得不对，这两批是在给错的输入抛光。顺序上，**根输入该在呈现层之前**。
- **审批在你们的平台上比官方那边危险一个等级。** 这是你们那条「关键平台差异」唯一没推到的格子：官方线程在一次性沙箱里，没审批最多毁掉沙箱；你们的线程在**用户真机、真仓库、真 `gh` 凭证**上，`auto mode` 没有边界。官方自己把审批做成**线程内阻塞**，还特意说明「Telling Claude in the project conversation to go ahead **doesn't reach it**」—— 他们在沙箱里都认为这件事重要到要写一节。

### 修订后的排期建议

| 批次 | 内容 | 相对你们的变化 |
| --- | --- | --- |
| **1 让输出可信** | 全局配额口径修正 + **知识改为 paths-first** + **审批接入（线程内阻塞）** | 知识那两项（陈旧检测 + 阈值派生）**合成一项减法**：使用时读盘，陈旧这一整类消失，不需要检测，`DEFAULT_CONTEXT_BUDGET_CHARS` 不需要存在。腾出的预算给审批 |
| **2 让拆解可信** | 拆解改模型优先（正则降级为**可见的** fallback）+ `Suggested threads` | **新增**，从你们的 §5.1 + §7 提上来。两件一起做，后者是前者的保险 |
| **3 让报回可用** | 补 `landing` / `idle` / `resolved` 三个状态 + 修 `bucketOf` + 投影 + Library + PR 聚合 | 你们的批次 2 和 3 **合并**（判断 B 不成立），且状态部分从"重构"降为"加法" |
| **4 让裁定可用** | `Merge it`（**发消息给线程**，不要宿主代跑）/ Resolve conflicts + Pause + **PR 显式退订** | 加退订（Q2 / Q5） |
| **5 减少重复交代** | goal 持久化 + 读仓库 `CLAUDE.md` + 协调状态可恢复（**三件套**：近期消息 / 线程摘要 / 记忆） | 协调状态的内容按 D.1 修正 |
| **6 卫生** | `deinit --purge` + 线程超时 + Usage | **worktree 回收从这里上移到 4** |

### 另外两处

**worktree 回收的排期和你们判断 C 的表格自相矛盾。** 表格里写「删 worktree / 归档项目：**不可逆，未推送的提交会丢**」，然后它被排在最后一批。不可逆的动作不该最后做防护 —— 在它之前，每一次 `deinit` 都在那个风险上。上移到批次 4（和 Pause / Archive 同批）。

**读仓库 `CLAUDE.md` 的边界要照抄官方，否则会做多。** 官方加载的是**仓库根**的 `CLAUDE.md`、`.claude/CLAUDE.md`、`.claude/rules/`；明确**不**加载子目录的 `CLAUDE.md` 和 path-specific rules。你们在本地、能读全盘，很容易顺手把子目录也读了 —— 那会让 charter 随检出内容膨胀，和你们的 prefix cache 目标直接冲突。

---

## 5. 引文核对

你们在 §9 说「若发现引文与原文不符，请指出 —— 那说明我们的取证有误」。核对结果：**绝大多数逐字无误。** 三处偏差：

**① Library 漏了 "and folders"。** 原文是 "the files **and folders** you added and the files threads produced"。无害，但你们的 Library 实现要同时呈现文件夹，不只是文件。

**② §2 表格最后一行「遇阻才标记需要人，不猜结论」—— 后半句没有依据，而且官方的实际行为相反。**

前半句有据（`Waiting on you` 含 failed）。后半句"不猜结论"不是官方行为 —— 官方专门有一节叫 *Threads guessed or stalled instead of asking*，讲的就是线程**确实会猜**：

> When several threads come back **having assumed something wrong, worked around missing access, or stopped with "blocked"** …

你们在 §3 判断 D 里引用这一节的方式是对的（用它论证"猜路由不可靠"）。但 §2 把"不猜"列为"✅ 有据的基线"是不对的 —— 它是你们的**目标**，官方没有做到，也没有声称做到。把目标列进"无需复核的基线"会让后面所有关于"线程会不会猜"的推理偏乐观。

**③ Q3 里那句 "you'll see Claude using a project knowledge search tool when it needs to find relevant information" 我无法逐字核对。** 该 support 页面我只抓到摘要，它确认了"project knowledge search tool"这个工具名和"按需检索"的语义，但这一句的逐字文本请你们自己再核一遍。你们据它推出的结论（模型自主调用，不强制）⚠️ 我认为成立，但依据是语义而非逐字。

**④ §9 那条「`OFFICIAL` 全文不含 RAG 字样」—— 核实通过，而且比你们写的更强。** 见 §0 第二号问题 ①：RAG 0 次、retrieval 0 次、project knowledge 0 次。这条比你们当作脚注写在表格里的分量大得多 —— 它是整份文档里最值得往回推的一个观察，因为它意味着 Q3 那套问题继承自另一个产品。建议把它从 §9 的表格注释提到正文。

---

## 6. 官方文档里你们没列出的几条

不是你们的疑问，但会影响实现形状。

**① 卡片动作的执行者分两类。** `Resolve conflicts` / `Fix CI` / `Address comments` / `Merge it` 是「send that instruction to the thread **as a message from you**」；只有 `Create PR` 是「creates the pull request from that branch **directly** rather than sending the thread an instruction」。你们的 `deliver`（≈Create PR）恰好对上了唯一宿主直办的那个。做 `Merge it` 时别照着 `deliver` 的样子写。

**② 审批的收件人是线程，不是协调者。** 「the prompt is **inside that thread** and the thread waits until you answer it **there**. Telling Claude in the project conversation to go ahead **doesn't reach it**.」你们 §7 的「❌ 完全不接审批」将来实现时，审批必须挂在线程上、阻塞那个线程。顺带：官方明说云线程**不读**仓库 `.claude/settings.json` 的权限规则，「you rely on auto mode and on the approvals you give inside each thread」—— 你们在本地跑，反而**可以**读 DSH 自己的权限规则，这是你们相对官方的一个真优势，值得用。

**③ 官方支持本地线程，且官方 CLI 自己有 `--spawn worktree`。** 见 D.3。你们的架构不是偏离，是官方认账的一条路径；官方给本地线程写明的三条限制可以直接抄作你们的 README 口径。

**④ 偏好会被自动写进项目记忆。** 见判断 E。

**⑤ 协调者不靠完整历史，而且有 `Restart Claude`。** 见 D.1。

**⑥ 仓库约定的精确边界。** 见 §4 末。

**⑦ `goal` 是可持久、可后加的项目字段**（`Project settings > General`），且「Claude in the conversation **works toward it**」。你们 §7 把它列为"只是入参、不落盘" —— 补的时候注意它不只是元数据，它参与协调决策。

**⑧ 官方的 turn 护栏是 `CLAUDE_CODE_MAX_TURNS`**（报 "Reached the turn limit"），不是修复轮数。见 Q2。

**⑨ 官方对知识文件的陈旧问题是"认了并显式化"，不是检测。** 「uploads are copies, so a change you make on your computer afterward **doesn't reach the project until you upload the file again** and choose **Replace**」。官方必须拷贝（云端），所以只能让用户显式重传。你们在本地没有必须拷贝的理由 —— 这正是 §0 ⑦ paths-first 的依据：**不拷贝就没有陈旧。**

**⑩ 项目级 `Pause` 的语义比你们的 `deinit` 更值得先做。** 「stops everything at once. Every running thread and the conversation are interrupted, no new threads start … and the project doesn't accept messages until you resume it」。在本地平台上这就是"我要用这台机器干别的"的那个开关，比归档常用得多。

---

## 7. 如果只改三件事

1. **把判断 A 换成 §0 ④ 那个加法版本**（加三个状态 + 改 `bucketOf` 的一个 case），然后把批次 2 和 3 合并。你们的结论对，但代价是假的 —— 别为一场不需要的迁移停两批。
2. **知识改成 paths-first**（§0 ⑦）。阈值、陈旧检测、`96_000` 这个常量、`context`/`rag` 二分，连同它们带来的全部问题，一起消失。这是整份计划里唯一的减法项。
3. **把拆解（§5.1）和审批（§7）提到前两批。** 你们自评最高危的那一项不在计划里，而审批在本地平台上的风险等级比官方那边高 —— 这是你们那条"关键平台差异"唯一没推完的推论。
