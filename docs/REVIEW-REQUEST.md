# 请 Claude 复核：Projects 复刻的判断与疑问

这份文档是**给 Anthropic 的 Claude 复核用的**，不是给我们自己看的笔记。

目的：我们按公开文档复刻了 Claude Code Projects（Beta），但有几处判断是在文档没有明说的地方**自己推的**。这些推错方向的代价很高——会决定后面 4 批实现的形状。所以先把判断、理由和疑问摆出来，请复核者指出哪些推错了。

复核者不需要读我们的代码。所有判断都写了文档依据或代码证据，可以独立核对。

## 怎么用这份文档

- **第 2 节**是我们已经做对的、不需要复核的部分（列出来只是让复核者知道基线在哪，不用花时间）。
- **第 3 节**是**判断 + 理由**。理由比结论重要——结论可能碰巧对，理由错了会在下一个类似决策上再错一次。请重点看理由。
- **第 4 节**是**我们无法从公开文档确定的疑问**，需要复核者给出方向。
- **第 5 节**是**我们自己知道可能错了**的几处，已标出怀疑的强度。

判断的置信度用三种标记：

| 标记 | 含义 |
| --- | --- |
| ✅ 有据 | 公开文档原文支持，可逐字核对 |
| ⚠️ 推断 | 文档没明说，我们根据文档其他部分或 DSH 平台约束推断 |
| ❓ 存疑 | 我们没有把握，明确请复核者裁定 |

## 1. 背景：我们做了什么

宿主是 **DeepSeek Harness (DSH)**，一个基于 Cordis 插件体系的编码 agent 宿主。我们做的是一个 DSH 插件，按 Claude Code Projects 的公开文档复刻其能力。

已经能工作的部分（261 项测试，实机验证过工具注册）：

- 目标拆解 → 每个任务一个后台子会话 + 独立 git worktree + 独立分支
- 项目级共享记忆，写进 system prompt 的固定槽位（利用 provider 端 prefix cache）
- 线程自己 commit / push / 开 PR
- CI 失败与 PR review comment 自动唤醒线程修复，最多 3 轮
- 项目知识库：小项目全文放进 prompt，超预算自动切 BM25 检索
- 6 个模型工具 + `/project` 命令族

**关键平台差异**：官方线程跑在**云端 sandbox**，我们跑在**用户本地的 git worktree**。宿主进程不在就不推进。这个差异影响了下面好几个判断。

## 2. 无需复核的基线（✅ 有据）

这些都直接对上了官方文档，列出来只为界定讨论范围：

| 我们实现的行为 | 官方原文 |
| --- | --- |
| 线程自己 commit、push、开 PR | "**Branch**: works on a new branch… **Pull request**: opens one when you ask, and can open one on its own for a bug fix" |
| 开 PR 后自动盯 CI 与 review，CI 失败就推修复 | "**After it opens**: watches the pull request with auto-fix turned on… It pushes fixes when CI fails, addresses review comments" |
| 知识库按体积在「全文」与「检索」之间切换，不存 flag | "RAG automatically activates when your project approaches or exceeds the context window limits… If your project knowledge later drops below the context window threshold, Claude can automatically convert back"（support.claude.com RAG 专文；**但阈值口径我们实现错了，见 Q3**） |
| 记忆放在 system prompt 固定槽位以命中缓存 | "**Set context once**: every new thread starts with the project's instructions, so a rule you state once… reaches all of them" |
| 遇阻才标记需要人，不猜结论 | "**Waiting on you**: Threads that need your reply or approval, or that failed"（失败也归入「等你」） |

## 3. 我们的判断与理由（请重点看理由）

### 判断 A：状态模型应该按「轮到谁」分层，而不是按「AI 在干什么」

**我们的做法**：把线程状态从现在的 7 个（`queued` / `running` / `ci_fixing` / `awaiting_review` / `needs_feedback` / `completed` / `failed`）重构成两层：

- 第一层是**球在谁手上**：`ai`（AI 的回合）或 `human`（人的回合）
- 第二层是**原因**：`等审 PR` / `等你回答` / `要处理失败`

**理由**：

1. 官方 Overview 的六个分组里，**`Ready for review`、`Waiting on you`、`Landing`、`Idle`、`Resolved` 全部是「球在谁手上」的表述**，只有 `Working` 是 AI 视角。六个里五个，这不像巧合。
2. 官方把 **`failed` 放进 `Waiting on you`**（"Threads that need your reply or approval, or that failed"）。如果状态是按「AI 在干什么」组织的，失败应该跟「AI 跑完了」放在一起；它跟「等你」放一起，说明分组轴是「谁该动」。
3. 我们现在的模型把 `failed` 单独成桶，导致前端要显示「有 3 个失败」和「有 2 个等你」两处，用户得在两个地方都看一眼才知道有没有自己的事。按「轮到谁」组织，用户只看一处。

**这个判断的代价**：改状态枚举是破坏性改动，要同时改投影的 `stateSchema`、`stateVersion`、所有测试断言、以及已落盘的旧数据迁移。

**请复核**：这个分层轴的推断对不对？还是说官方图省事把人相关的分组凑一堆，并没有底层的两层模型？

### 判断 B：投影（UI 数据层）必须晚于状态模型

**我们的做法**：先重构状态模型，再接入 `ctx.projection`。

**理由**：投影的 `stateSchema` 由状态枚举决定。如果先做投影再改枚举，要写两遍 `stateSchema`、做一次 `stateVersion` 迁移、并且前端要适配两个版本。

**请复核**：这个顺序约束是不是真的存在？还是说投影层可以做薄一点（只投影原始 descriptor、分组留给前端），从而摆脱对状态枚举的依赖？

**如果是后者，我们的第 2、3 批可以合并**，能省一整批。

### 判断 C：只有「合进主分支」需要人批准，其余全自动

**我们的做法**：线程 push、开 PR、修 CI 全自动；只有 merge 需要人点。目前**完全没有**接入审批机制。

**理由**：按可逆性划线。

| 动作 | 可逆性 | 判断 |
| --- | --- | --- |
| 分支上 commit / push | 完全可逆，分支随时删 | 全自动 |
| 开 PR | 可逆，关掉即可 | 全自动 |
| 合进主分支 | 半不可逆，历史留痕、下游可能已拉 | **人点一下** |
| 删 worktree / 归档项目 | 不可逆，未推送的提交会丢 | **先确认已推送** |

**对应官方**："**Merge it**" 是线程卡片上一个需要人点的按钮，而 push 与开 PR 是自动的。

**请复核**：这条线划得对吗？有没有我们没意识到的半不可逆动作被划进了自动那侧？

**一处我们不确定的**：如果 CI 全绿、reviewer 全 approve、PR 无冲突，官方会让线程自己合并吗？文档只说 `Landing` 分组包含 "Threads whose pull request is approved or **queued to merge**"。「queued to merge」听起来像自动流程，但**谁触发那个队列**文档没说。❓

### 判断 D：DSH 上不需要「项目绑定一段长期会话」

**这是本轮改动最大的一条判断**，先说清楚它推翻了什么。

**原来的判断**：官方是「一个项目 = 一段持续对话」，我们要照抄，就得让项目绑定一个协调会话。我当时把它列为「产品定位改动」，理由是「要回答『DSH 一个会话可能同时开多个工作区，项目绑定哪个会话』这个设计问题」。

**现在的判断**：**不需要绑定会话**。项目需要跨会话存活的其实只有四样：

| 需要跨会话存活的 | 我们的状态 |
| --- | --- |
| 1. 这个项目要干什么（goal） | ❌ 缺（只是 `coordinate` 的入参，不落盘） |
| 2. 哪些线程在做什么 | ✅ 已有（`manifest.threads`） |
| 3. **哪些事在等我决定** | ❌ 缺 —— 但这就是判断 A 那个「轮到人」的集合，重构状态模型后免费得到 |
| 4. 已定的决策与理由 | ✅ 已有（共享记忆） |

**理由**：只有第 3 项是缺的，而它不需要一段持续对话来承载——新会话进来只要查「有哪些球在我手上」就够了，不需要读历史。所以 `GAP-07` 应该从「项目绑定会话」改成「**协调状态跨会话可恢复**」（记一个协调日志 + 那个「等你决定」清单）。

**还推翻了另一个假设**：我原来认为「把后续消息路由到已有线程」需要一套路由算法。现在认为不需要——**默认开新线程，用户要转给已有线程就明说**。

支持这个的理由：官方专门有一节叫 *Threads guessed or stalled instead of asking*，讲的就是线程**猜错了**（"assumed something wrong"）怎么补救。Anthropic 自己也要为「模型猜」写排查指引，说明猜路由本质不可靠。与其让模型猜，不如让人说。

**请复核**（三个问题）：

1. ❓ 「不绑定会话、只维护『等你决定』清单」这个替代方案，会不会丢掉某些只有长期对话才有的价值？我们能想到的是「上下文累积」与「模型知道之前聊过什么」，但我们认为线程描述符 + 共享记忆 + 知识库已经覆盖了大半。
2. ❓ 官方文档写 "Claude decides where each message you send in the conversation goes"，并给出三条路由规则（快问快答留在对话里 / 新工作开新线程或转给已在做这块的线程 / 一条消息里多个无关任务拆成多条）。这个路由**在我们「每次显式调用拆解工具」的模型里能做到几成**？如果不做自动路由，用户体感会差多少？
3. ⚠️ 我们推断「云端线程能跨设备续，是因为有服务器持久化；DSH 本地 worktree 做不到，所以也不该假装做到」。这个推理对吗？

### 判断 E：并发数不设硬上限

**我们的做法**：不实现并发上限，只在拆解时限制「这一批最多几个任务」（8 个）。

**理由**：官方原文明确说并发不是硬上限：

> "There's no fixed number; Claude starts as many as the work calls for, and a limit you ask for is a **preference rather than a cap**. The enforced limit is 200 new threads per day across your projects."

**请复核**：我们把「并发偏好」完全不实现（连偏好都不给），是否合理？还是应该给一个「软建议」让模型自己遵守？

### 判断 F：失败的线程算「人的回合」，不算「AI 的失败」

含在判断 A 里，单独列出来是因为它有个后果：**`failed` 的线程不应该被永久留在失败桶里等人清理，而应该等人处理完后转 `Resolved`**。官方 "You can reopen one from the same menu" 支持「Resolved 是可逆的终态」这个读法。

❓ 请复核：`Resolved` 是不是**唯一**的正常终态？`Idle` 会不会自动转 `Resolved`（官方说「一周无活动自动转」），还是需要人为动作？

## 4. 我们无法从文档确定的疑问

按重要性排。每条都写了「为什么文档不够」。

### Q1 线程之间「互不污染」的边界到底在哪

**为什么文档不够**：官方说云线程 "each clones its repositories into its own cloud sandbox"，物理隔离是显然的。我们跑本地 worktree，共享同一个 `.git` 目录。

**我们的做法**：每个线程一个 worktree（只建分支时，线程仍在父检出里跑，并发时会互相看见未提交改动——这是我们踩过的真实缺陷）。

**我们的疑问**：

- ⚠️ worktree 共享 `.git` 会不会在某些操作上出问题（例如两个线程同时 `git gc`、或者同时改 `.git/config`）？
- ⚠️ 我们的 `healSweep` 会在线程空闲时唤醒它修 CI。如果两个线程的 PR 都失败、同时被唤醒，它们的 worktree 是独立的，但都操作同一个远端仓库。这算不算官方意义上的「互不污染」？

### Q2 「一个线程」的边界：一次 turn，还是一个任务的生命周期

**为什么文档不够**：官方说线程 "does one piece of work and reports back to the conversation when it finishes"，但**修 CI 的三轮算一个线程还是三个**？

**我们的做法**：同一个线程会话，用 `resume` 续聊（不新建会话），状态在 `ci_fixing` 与 `awaiting_review` 之间切。

**我们的疑问**：

- ❓ 官方「最多修 3 轮」是我们自己加的护栏，官方文档没说上限。这个上限合理吗？还是会让某些本来就该多轮的修复被过早交给人？
- ⚠️ 续聊会让线程的上下文越滚越大（每次修都带上全部历史）。官方文档提到 "A follow-up routed to a thread that has been idle longer than the cache lifetime… re-reads that thread's whole conversation before doing anything"，并建议 "For new work, asking Claude to start a fresh thread can use less than reviving a large old one"。**修 CI 属于「new work」还是「reviving」**？

### Q3 知识的「全文模式」和「检索模式」的切换阈值怎么定

**为什么文档不够**：官方只说阈值是 "the context window limits"，没说这个窗口是**哪个模型**的、也没说知识占窗口多少比例。

**已能从文档确定的**（不再是疑问）：

> "RAG automatically activates when your project approaches or exceeds the context window limits." / "RAG activation is handled automatically based on the size of your project knowledge. When possible, projects will use in-context processing for optimal performance."

→ 阈值是**上下文窗口本身**，不是某个固定字符数。所以我们的做法在**方向上错了**，见下。

**我们的做法**：默认预算 `DEFAULT_CONTEXT_BUDGET_CHARS = 96_000` 字符（约 24k tokens），容量 = 预算 × 10。这是个**写死的常量**（`src/core/knowledge.ts:32`）。

**我们的疑问**：

- ❓ **这个常量应该怎么定？** 官方说是按上下文窗口算，但同一项目可以换模型（`Coordinator model` 与 `Thread model` 是两个独立设置），窗口从 200k 到 1M 都有。我们的推断：

  - 如果按**协调者模型**的窗口算，那么换线程模型不影响知识模式——但线程读不到全文知识时行为会变。
  - 如果按**各自线程模型**的窗口算，同一个项目在不同线程里知识模式不同，`prefixVersion` 会分叉，缓存命中率下降。

  ⚠️ 我们倾向第一种（按协调者模型），但 24k tokens 只占 200k 窗口的 12%，明显过于保守。**这个值大概应该定在窗口的 50%~70%**：知识要跟对话、system prompt、工具结果抢同一个窗口，留 30%~50% 给它们。

- ⚠️ **检索工具是模型自己决定何时调用吗？** 文档说 "you'll see Claude using a project knowledge search tool **when it needs to** find relevant information"，看起来是模型自主决定。我们的实现是**提供一个可调用工具、不强制**，与这个读法一致；但我们的 system prompt 里没有告诉模型"检索模式下先查知识再回答"，可能漏查。❓ 官方是纯自主，还是有 prompt 层面的引导？

- ⚠️ 我们的 `knowledgeCapacity = budget × 10` 对应 "expand capacity by up to 10x"。**如果预算本身随模型窗口变化，容量也跟着变**——官方是不是这个意思，还是 10x 是相对某个固定基线？

### Q4 「一周无活动自动归档」的「活动」怎么定义

**为什么文档不够**：官方原文只有 "automatically after a week with no activity"。

**我们的疑问**：

- ❓ 「活动」是指：线程有 turn、用户点开了线程、PR 有更新、还是这些的并集？
- ⚠️ 我们担心的是：一个线程的 PR 还开着等 review，reviewer 三周后才来看。如果按「无活动」归档，这个 PR 就没人管了。**归档是否应该排除「还开着 PR」的线程？**

### Q5 `Merge it` 之后线程应该怎样

**为什么文档不够**：官方说 `Resolved` 包含 "by Claude once you've taken the last step, such as merging its pull request"，但没说合并后线程还会不会做别的事。

**我们的疑问**：

- ❓ 合并后是立即 `Resolved`，还是先 `Idle` 一段时间？
- ⚠️ 我们的 `deliverThread` 会在合并后继续 `healSweep`（因为状态还是 `awaiting_review`）。如果 PR 已合并且分支已删，`gh pr checks` 会报错。**这个边界官方怎么处理？**

### Q6 Overview 的六个分组是互斥的还是有重叠

**为什么文档不够**：官方表格里 `Ready for review`（"pull request is open and awaiting review"）与 `Waiting on you`（"need your reply or approval"）看起来会重叠——一个 PR 开着等你 review，同时是「等你」也同时是「待审」。

**我们的做法**：桶是互斥的（每个线程恰好一个桶）。

**我们的疑问**：

- ❓ 官方是让一个线程出现在多个分组里，还是 `Ready for review` 是 `Waiting on you` 下面的一个子类？
- ⚠️ 如果是重叠的，我们的互斥模型就错了，得改成多维标签。

## 5. 我们自己知道可能错了的地方

比上面几条更没把握，单独列出来。

| # | 我们的做法 | 怀疑的强度 | 怀疑的理由 |
| --- | --- | --- | --- |
| 1 | 拆解目标**不调模型**，用确定性的文本分析（识别 bullet 列表） | **高** | 官方是 Claude 在做协调（"Claude acts as coordinator. It takes what you send, decides what becomes a thread"），显然是模型判断。我们用确定性分析是为了「委派模型不可用时也能工作」和「可单测」，但这可能牺牲了真正的拆解质量——用户给一段散文式的需求，bullet 分析什么都拆不出来。**这是最大的一个技术债，可能是根本性的。** |
| 2 | 线程产出文件只记 `git diff --name-status`，不收集内容 | 中 | 官方 Library 是 "the files you added and the files threads produced"，听起来是**实际文件**（可以下载/预览）。我们只记清单。 |
| 3 | 记忆广播只推给**正在跑**的线程 | 中 | 我们的理由是「给 idle 子会话发消息会新起一轮，会白烧 token」。但官方说 "every new thread starts with the project's instructions"——它没说运行中的线程怎么拿到更新。如果官方是「等线程下次开口时自然带上」，那我们的做法可能过度了。 |
| 4 | 知识库用 BM25 + 中文重叠 bigram | 中 | 官方是向量检索还是关键词检索，文档没说。BM25 对小语料够用，但语义查询（"这份文档讲了什么关于认证的"）会漏。 |
| 5 | `needs_feedback` 与 `failed` 是两个状态 | 低-中 | 官方把它们都放进 `Waiting on you`，可能根本不需要区分。但要区分的话，原因是「等你回答」vs「要你处理失败」，对用户是有用的。 |
| 6 | **知识切换阈值写死 96,000 字符** | **高** | 官方口径是「按上下文窗口」算，我们写成了一个常量，与「换模型」这件事脱钩。见 Q3。 |

## 6. 我们打算怎么改（请复核这个顺序）

按「会不会安静地出错」排，不按工作量排：

| 批次 | 内容 | 为什么排这里 |
| --- | --- | --- |
| **1 让输出可信** | 全局配额口径修正（官方说 200/天是 `across your projects`，我们现在是每项目独立计数）+ 知识陈旧检测（绑定的文件改了必须手动重建，否则**静默给旧答案**）+ 知识阈值改为由上下文窗口派生（Q3，现在是写死常量） | 不碰 UI 与状态模型，可独立上线。这三项是错得最贵的，且都在知识层/配额层的同几行上 |
| **2 状态模型重构** | 7 状态 → 「轮到谁 + 原因」两层（判断 A） | 投影的 `stateSchema` 由它决定（判断 B）。**如果判断 B 不成立，本批可与第 3 批合并** |
| **3 让报回可用** | 会话投影 + Library + PR 聚合 | 三者合起来 = 一眼看到所有球在哪 |
| **4 让裁定可用** | Merge it / Resolve conflicts + Pause + 归档 | 人都看到球了，得能踢 |
| **5 减少重复交代** | goal 持久化 + 读仓库里的 `CLAUDE.md` + 协调状态可恢复（判断 D） | 依赖 3/4 的可视性才有意义 |
| **6 卫生** | worktree 回收 + `deinit --purge` + 线程超时 + Usage 统计 | 不出错，只占资源与观感 |

❓ **请复核这个顺序**。特别是：第 2 批（状态模型）压在第 3 批（投影）前面，代价是「用户要等两批才看到 UI 改善」。如果判断 B 不成立，这个代价就是白付的。

## 7. 公开文档里我们读到了但没实现的（已确认）

列出来是为了让复核者知道哪些是**已知未做**而不是**漏做**：

| 官方能力 | 我们 |
| --- | --- |
| 项目 goal（可持久、可后加） | ❌ 只是 `coordinate` 的入参，不落盘 |
| 读仓库的 `CLAUDE.md` / `.claude/rules/` | ❌ 只读自己的 `PROJECT_INSTRUCTIONS.md` |
| Suggested threads（先提议后启动） | ❌ 直接启动 |
| Library / Pull requests / Scheduled tasks 三个标签页 | ❌ 只有知识库的绑定路径 |
| Pause / Archive / Delete | ⚠️ 只有 `deinit`，且只删 manifest 不删 worktree |
| Thread model / effort（可给线程钉模型） | ❌ 只能指定 provider 名 |
| Usage（按线程、按模型看 token） | ❌ 完全没有 |
| 权限提示审批 | ❌ 完全不接审批 |
| `Merge it` / `Resolve conflicts` / `Review PR` 卡片动作 | ❌ 只有 `deliver`（≈Create PR）与 `heal`（≈Fix CI + Address comments） |
| Continue in project（把已有会话带进项目） | ❌ 不做，判断为收益不明 |
| Team 协作 / 共享 | ✅ 持平——官方 beta 期间也不支持（"A project belongs to one user"） |
| GitHub App / connectors / cloud environment | ❌ 不做，走 `gh` CLI 已有鉴权 + DSH 自己的 MCP 配置 |

## 8. 复核者可以怎么回答

不必逐条回。最有价值的三种回答：

1. **「第 3 节哪条判断的理由不成立」** —— 理由错了比结论错了更值得指出，因为会传染到下一个决策。
2. **「第 4 节哪个疑问你们其实能从文档 X 推出来」** —— 有些我们以为文档没说，可能只是没读到。
3. **「第 6 节的顺序里，哪一批做了以后会推翻前面某批」** —— 顺序错要返工，这是最贵的错。

如果只能回答一个问题，请回答这个：

> **判断 A（按「轮到谁」分层状态模型）这个轴，是对的，还是我们过度解读了六个分组？**

因为它决定了第 2、3 批的形状，而这两批是接下来投入最大的部分。

如果还能回答第二个，请回答 Q3 里的这个：

> **知识模式阈值应该按哪个模型的窗口算（协调者 / 线程 / 两者各自）？**「10 倍容量」是相对该窗口，还是相对某个固定基线？

## 9. 附：本文档引用来源

| 代号 | 来源 | 覆盖范围 |
| --- | --- | --- |
| `OFFICIAL` | https://code.claude.com/docs/en/claude-projects | 线程模型、Overview 六分组、设置项、Pause/Archive/Delete、goal、仓库约定、路由、限制。**全文不含 RAG 字样** |
| `RAG` | https://support.claude.com/en/articles/11473015-retrieval-augmented-generation-rag-for-projects | 知识模式触发条件、10 倍容量、检索工具、何时切回。**阈值口径只在这里** |
| `SPEC` | 本项目内部 `PROJECT_BETA_SPEC.md` | 五模块定义（写给自己的规格，与官方有出入时以官方为准） |

本文档中所有引号内的英文均为逐字引用，可用上表链接核对。若发现引文与原文不符，请指出——那说明我们的取证有误，应该先修取证再谈判断。
