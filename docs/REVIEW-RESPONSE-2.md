# 复核回执（第二轮）：§7 两个问题的裁定

复核者：Claude (Opus 5)，2026-10-27
复核对象：[`docs/REVIEW-REQUEST.md`](./REVIEW-REQUEST.md) @ `9866952`
本轮取证：`curl https://code.claude.com/docs/en/claude-projects.md` → 62,835 字节原始 markdown，落盘后逐字 grep。本文所有 `L<行号>` 都可对同一份文件复现。

第一轮回执见 [`docs/REVIEW-RESPONSE.md`](./REVIEW-RESPONSE.md)。那一轮我只拿到渲染页与 `RAG` 的摘要，有三处是「按语义推」；这一轮是逐字核的，所以下面有两条推翻了第一轮自己的建议。

---

## 问题一：六个分组互斥吗？「PR 开着、CI 绿、等 reviewer」落哪个桶？

**✅ 互斥。那个线程落 `Ready for review`，不是 `Waiting on you`。判断 G 的互斥假设成立，不要改成多维标签。**

### ① 直接回答你们举的那个线程

`Ready for review`。两条理由，都在原文里：

**a. `Waiting on you` 里的 "approval" 不是 PR approval，是权限审批。** `OFFICIAL` L247-251 有专门一节 *Unblock a thread waiting on approval*：

> Threads run in auto mode when the thread's model supports it, so most tool calls run without asking you. When a thread needs your approval, the prompt is **inside that thread** and the thread waits until you answer it **there**. Telling Claude in the project conversation to go ahead **doesn't reach it**.

**b. 等 reviewer 不等于等**你**。** `Waiting on you` 的原文是 "need **your** reply or approval"。reviewer 不必是项目所有者——而 `Ready for review` 的定义恰恰是 "pull request is open and **awaiting review**"，等的是那个不一定是你的人。

### ② 互斥是「按构造」成立，不是「按定义两两不交」—— 这个区别决定 `bucketOf` 怎么写

根据只有一条（`OFFICIAL` L197）：

> The pane's **Threads** tab **groups threads by state**

分组是对 state 的投影，一个线程一个 state，所以恰好一个桶。但这意味着**两条定义同时命中时，映射函数必须自己裁定**，文档不会替你裁。

让六条定义彼此排开的，是你们和第一轮都没引的那一条——`Idle` 的 "finished and **aren't waiting on anything**"。这句是定义里的排除子句，一条就把 `Idle` 和三个「在等」的组隔开；`Landing` 的 "approved or queued to merge" 与 `Ready for review` 的 "awaiting review" 则在 PR 生命周期上对立。

### ③ 真正需要裁定的那个碰撞，你们没问 —— 但它会埋掉线程

**场景**：一个线程 PR 开着等 review（命中 `Ready for review`），同时被唤醒去修 CI，在线程内卡住等一个权限审批（命中 `Waiting on you`）。两条定义同时为真，官方表格没说哪个赢。

**裁定依据在 Overview 自己的定义里**（`OFFICIAL` L193）：

> The **Overview** button in the project header closes and reopens it, and **shows a dot when a thread is waiting on you**.

那个点是「有我的事」的唯一信号。若这种线程被归进 `Ready for review`，点不亮；而按 ①a 的原文，**在项目对话里说「去吧」到不了那个线程**，所以没人会去解锁它。结果是线程永久卡死，而面板显示一切正常。

→ **`Waiting on you` 必须优先于 PR 生命周期位置。** `bucketOf` 要写成带优先级的映射，不是一张平的映射表：

```
human-blocking（needs_feedback / failed / 等权限审批）
  > PR 生命周期位置（landing > awaiting_review）
  > 运行中（working）
  > 终态（idle > resolved）
```

`GAP-04` 现在那个修法（`failed` 并入 `waiting_for_feedback` + 新增三个 case）是对的，但它只是这张优先级表最上面一格。按平表写，等审批的线程会被 PR 状态掩盖。

> 还有一个更弱的碰撞：GitHub 上一个 PR 可被一人 approve 而仍等另一人，`approved` 与 `awaiting review` 同真。官方不区分，建议取 `Landing`，并在 `bucketOf` 注释里写明这是我们的裁定而非原文。

---

## 问题二：paths-first 下官方有没有 prompt 层面的引导？

**✅ 有。原文在下面。而且它不是「charter 里加一句」——是一个两层读取协议，所以你们担心的那个偏离不存在：不要自己加句子，要加索引。**

### ① 原文（`OFFICIAL` L291，逐字）

> **Project memory** | Notes Claude keeps about the project, such as requirements, decisions, and pitfalls, **stored as files**. **Every cloud thread reads the index file `MEMORY.md` when it starts and opens the other files when it needs them**

这一句同时回答了三件事：

| 问 | 答 |
| --- | --- |
| 有引导吗？ | 有 |
| 是 prompt 里一句话吗？ | **不是** |
| 那是什么？ | **索引开局必读（eager）+ 正文按需打开（lazy）**，而索引本身是一个**文件** |

引导被编码在**读取协议**里，不在措辞里。线程开局就拿到一份「有什么」的清单，于是它不需要被告知「去查」—— 它已经知道有什么可查。这比 charter 里写「回答前先确认项目知识」可靠得多：后者是请求模型守规矩，前者是把事实摆在它面前。

### ② 项目文件那一侧确实没有引导，也不需要

`OFFICIAL` L293 只说「the folders and files it can read under `/mnt/project-files`」——只有「可读」。没有索引、没有检索工具、没有 prompt 指令。

你们 §判断 H 引的那句 "you'll see Claude using a project knowledge search tool **when it needs to**" 出自 `RAG`（另一个产品），我无法在 `OFFICIAL` 里逐字核到；但不必靠它了，①那一句比它强，而且在对的文档里。

顺带把你们 §8 那条取证加强：`OFFICIAL` 整页逐字 grep 的结果是 `RAG` **0 次**、`retrieval` **0 次**、`project knowledge` **0 次**、**`knowledge` 本身也是 0 次**、`/mnt/project-files` 1 次。你们报的是三个 0，实际是四个——Code Projects 连「知识」这个词都不用，只有「挂载给线程读的文件」和「线程自己记的 memory 文件」。

### ③ 所以判断 H 第 1 条要改：不是「清单」，是「索引」

| | 判断 H 第 1 条 | 官方 | 差别 |
| --- | --- | --- | --- |
| 进 charter 的 | 路径**清单** | **索引**（标识 + 规模） | 只给路径，模型得先 `ls`／先读一遍才知道哪份相关；给索引，等价于官方的 `MEMORY.md` |
| 正文 | 按需读 | 按需读 | 同 |

**已按这一条实现**（commit `9c7ef10`）：charter 里每份已索引文档一行「路径 — 字符数」。字符数是让模型能**选**的那个信息——「读那份 2 KB 的决策记录」和「读那份 400 KB 的转录」是两个不同的决定，纯路径清单分不出来。

### ④ 一个你们没有的硬数字：16,000 字符

`OFFICIAL` L292，逐字：

> **Project instructions** | Text sent to each new thread and to Claude in the project conversation, **up to 16,000 characters**

这是官方对「每个线程开局都带上的那段常驻文本」唯一的明文预算。它替换掉第一轮回执给你们推的那套（`min(协调者窗口, 线程窗口) × 25%~30% + hysteresis`）——那是推的，这是写明的，而且小两个数量级。

**已实现**：`MAX_INSTRUCTIONS_CHARS = 16_000` + `instructionsOverBudget()`，**报警不截断**。静默截断用户的 brief 是把一个静默失败（陈旧知识）换成另一个。

同时，`inlineKnowledgeMaxChars` 这个旋钮**没有加**：正文不进 prompt 之后它只剩「小项目的 prefix cache 优化」这一个用途，而那是优化不是机制，默认 0 等于不存在。要加随时可加，但别把它当成 paths-first 的一部分。

### ⑤ 收集上限也有明文，而且是条目数不是字符数

`OFFICIAL` L339：

> **Folders**: when you add a folder from either place, the project receives a copy of its **first 100 files up to 200 MB**, without any files **over 30 MB**, hidden files, or `node_modules`.

**已实现**：`MAX_KNOWLEDGE_FILES = 100` + `MAX_KNOWLEDGE_INDEX_CHARS`，`collectKnowledge` 新增 `maxFiles`，触到任一上限时 warning **指名是哪一个**（「停止收集」而不说是哪条线，用户只能猜该拆文件还是该减文件）。单文件仍 2 MB，比官方的 30 MB 严，注释里写明这是我们的收紧而不是官方的数。

---

## 顺带回答判断 I 的那个 ❓（我有原文，而且答案对你们有利）

你们问：官方的 `/mnt/project-files` 与线程自己的仓库 checkout 是不是两套独立路径？我们「让线程去读项目根的绝对路径」等价吗？还是该把知识复制／软链到每个 worktree？

**是两套独立路径，原文在同一行**（`OFFICIAL` L293）：

> The **repositories every cloud thread clones**, the **folders and files it can read under `/mnt/project-files`**, and the cloud environment it runs in

仓库是 clone，项目文件是挂载，两者并列且分开。而且挂载是**一份共享的**，不是每线程一份副本。

→ **你们「读项目根的绝对路径」更贴近官方，不要往每个 worktree 复制。** 复制会引入你们自己列的那两个代价（磁盘 × 线程数、同步），而官方模型里根本没有这两个问题，因为挂载只有一份。

判断 I 的结论（路径必须锚定项目根）**成立且重要**，但**这一条我没有实现** —— 见下面的「这一轮代码做了什么、没做什么」。

---

## 一条取证错误：「记忆进 prompt 槽位」不是有据的基线

`REVIEW-REQUEST` §1 与更早的 §2 把「记忆放在 system prompt 固定槽位以命中缓存」当成已对上官方，引的是（`OFFICIAL` L22，逐字无误）：

> **Set context once**: every new thread starts with the project's **instructions**, so a rule you state once… reaches all of them

引文对，但它讲的是 **instructions**，不是 **memory**。官方的 memory 是问题二 ① 那一句：**文件 + `MEMORY.md` 索引 + 线程开局读**。

**为什么这条要紧**：它和 paths-first 是同一个问题的两半。**官方对记忆和对知识，用的是同一套 paths-first。** 判断 H 只把**知识**改成了 paths-first，**记忆**还整段渲进 charter（`renderMemoryPrefix`），两半不一致。

⚠️ 我**不建议**现在就把记忆也改成文件 + 索引：记忆是**决策**而不是**文档**，每条都短、每条都该被读到，lazy 读取反而会让线程漏掉约束；而且 16,000 字符的预算对它绰绰有余。建议的是**显式记账**——把它从「有据的基线」改成「我们相对官方的取舍」，并用同一把尺子给记忆段也设一个报警阈值。已作为新条目记进 `GAPS.md`。

---

## 这一轮代码做了什么、没做什么

commit `9c7ef10`，`npm run verify` 全绿，285 项测试（新增 24 项）。

**`GAP-01` 全局配额 —— ✅ 完整关闭。** 四条验收标准全部有测试。两层语义分清了：用户级账本是硬限（「The enforced limit is 200 new threads per day **across your projects**」），项目级 `dailyThreadQuotaMax` 是偏好（「a limit you ask for is a **preference rather than a cap**」，同一句）。顺带关闭 `BOUND-3`。

**`GAP-22` 知识 paths-first —— ⚠️ 只做完了减法那一半。**

| `GAP-22` 做法 | 状态 |
| --- | --- |
| 1 charter 只渲染清单，不注入正文 | ✅ 并且升级成**索引**（见问题二 ③） |
| 5 删除阈值／模式／容量 | ✅ `grep` 为空 |
| 6 重写模块注释 | ✅ |
| 7 `inlineKnowledgeMaxChars` 默认 0 | ✅ 等效（整个注入路径删掉了），但**没有加这个旋钮** |
| **2 路径锚定项目根**（判断 I） | ❌ **未做** |
| **3 `tree` / `read` 两个动作** | ❌ 未做 |
| **4 索引查询时按需重建** | ❌ 未做，仍需显式 rebuild |

**第 2 条是其中唯一会出错的**，而且我的改动**没有改善它**：索引渲染的是 `doc.path`（相对项目 root），线程的 cwd 是自己的 worktree，所以 charter 给出的路径在线程里解析不到——正是判断 I 描述的那个陷阱。把它单独标成 `GAP-22a` 并留在第一批的收尾里，不要和 3/4 混在一起：3/4 是能力增强，2 是正确性。

---

## 不受这一轮影响的

- 判断 G（状态是生命周期位置，`Waiting on you` 是注意力收口）：✅ 成立。它正是第一轮用 `Idle` 那句否掉「轮到谁」二元轴之后剩下的那个读法。
- 判断 J（拆解模型优先 + Suggested threads 同批）：✅ 成立，没找到反证。
- 判断 K（审批改译为「根会话问人、线程执行」）：⚠️ 我没有核 DSH 的 Host 契约，无法裁定改译是否必要。但要提醒一句：官方把审批做成**线程内阻塞**，并明说「Telling Claude in the project conversation to go ahead **doesn't reach it**」。你们的改译把收件人换成了根会话，**正是官方说不行的那个方向**——所以改译之后必须保证「根会话答完 → 线程真的继续」这条链路有测试，否则会退化成「人答了、线程没动」。
- 判断 M（项目内不实现 Scheduled tasks）：✅ 官方把它列为 Overview 的一个独立标签页，确实可以不做。
