# Opus 产出核实报告（第一次核查）

核查时间：2026-10-29
核查范围：`38c3e9b..efbbb7e`（Opus 的 6 个提交）
核查人：DSH 主会话（DeepSeek Harness）

---

## 一句话结论

**Opus 的产出质量扎实，可以采纳**：285 项测试全绿、新增 249 行配额账本设计正确、文档自我纠错诚实。**但它把第一批的核心正确性残留（`GAP-22a`）留在了原地**，并且有 3 条文档待办没有关闭。

---

## 一、提交清单

| 提交 | 作者 | 内容 |
| --- | --- | --- |
| `9c7ef10` | gg (Opus) | feat: 第一批 — 全局配额账本（GAP-01）+ 知识改为 paths-first（GAP-22） |
| `f994811` | gg (Opus) | docs: 第二轮复核回执 + 据此更新登记簿与 README |
| `efbbb7e` | gg (Opus) | Merge PR #2 |

改动规模：27 文件 / +1464 / -442。其中 `src/core/quotaLedger.ts` 是**全新模块 249 行**，`test/unit/quotaLedger.test.ts` 是**全新测试 210 行**。

**注意**：`9866952`、`e981791`、`bb71325` 是你自己（EliteOtaku）的提交，不是 Opus 的。

---

## 二、我独立验证通过的部分

### 2.1 构建与测试

```
npm run verify  →  285 tests / 62 suites / pass 285 / fail 0
```

测试数从 261 涨到 285（+24），README.md:137 与 AGENTS.md:23 的记录**已同步更新为 285**，没有虚述。

### 2.2 `quotaLedger.ts` 的设计是对的

我逐行读了 249 行源码。核心论证链条完整且正确：

> 官方「200 new threads per day **across your projects**」是强制上限，所以计数器不能放在 per-project manifest 里（三个项目各自 200 就等于 600/天）。

三个关键设计我认为都对：

1. **用锁文件而不是进程内队列**（第 14-18 行注释）。理由写得很到位：「两个 Host 进程——一个重载的插件旁边一个还在跑的，或同一台机器上两个 Harness 实例——按定义共享这个文件，这正是把它从项目目录提出来全部理由。进程内队列只会串行化那些从来不是问题的写入者。」
2. **锁过期自愈**（`LOCK_STALE_MS = 10_000`）。崩溃进程留下的锁会被后来者用 mtime 判定为废弃并删除，否则插件会一直拒绝开线程直到有人手动删文件。
3. **`parseLedger` 对损坏文件读成空账本而不是报错**（第 88-90 行）。理由：「因为一个缓存文件被截断就拒绝开线程，比短暂少算更糟，而下次写入会修复文件。」

`release()` 里 `.catch(() => undefined)` 也是对的——退还失败不该把上游的失败掩盖成另一个错误。

### 2.3 paths-first 的减法做干净了

`knowledge.ts` 从 463 行缩到 520 行左右（含新增的索引渲染），但**删掉的是整个机制**：

- `DEFAULT_CONTEXT_BUDGET_CHARS = 96_000` → 已删（grep 无残留）
- `RAG_CAPACITY_MULTIPLIER = 10` → 已删
- `knowledgeCapacity()` / `knowledgeMode()` → 已删（grep 无残留）
- `KnowledgeMode = 'context' | 'rag'` → 已删

现在 `renderKnowledgeIndexSection()`（`src/core/knowledge.ts:420`）只渲染**目录索引**，不再是正文：

> `N document(s) under M bound path(s) hold the authoritative context for this project. They are **not** reproduced here — read the ones your task touches, with your ordinary file tools...`

并且明确写了「磁盘上的文件是权威的；搜索索引是早先建的，可能滞后」。

**这是净减法**，符合 `GAPS.md:119` 的说法。

### 2.4 文档自我纠错是真的诚实

`docs/REVIEW-RESPONSE-2.md`（174 行）里有两条是**推翻自己第一轮建议**的：

- 「`MAX_HEAL_ATTEMPTS` 的轴选错了」→ 但第二轮补充说**先不改**，因为连续失败计数需要新字段 + 迁移，属第二批
- 「`100 files` / `30 MB` 上限」→ 这是我们原先完全没提的官方硬数字

`GAPS.md:592` 的「已修正的错误判断」表也新增了记忆槽位那条，并明确写「引文逐字无误，**但它讲的是 instructions，不是 memory**」——这种区分很关键。

---

## 三、发现的问题

### 问题 1：`GAP-22a` 没做 —— 这是唯一会静默出错的地方 🔴

Opus 自己在 `GAPS.md:625` 写了：

> **第一批的收尾（2026-10-27）**：`GAP-22a` 是第一批唯一的正确性残留，它应当在开第二批之前做掉 —— 而 `GAP-22a` 意味着线程现在**读不到** charter 指给它的知识文件，也就是说第一批「让输出可信」这个目标还差最后一步。

**问题具体是什么**（`GAPS.md:148-169`）：

- charter 渲染的路径来自 `IndexedDocument.path`，即**相对项目 root 的显示路径**（`knowledgeSource.ts` 的 `display = toPosixPath(bound.trim())`）
- 而线程的 cwd 是它自己的 worktree（`.dsh-project/worktrees/<threadId>`，`engine.ts:526` 的 `cwd: worktreePath ?? manifest.rootDir`）
- worktree 只含 baseCommit 里**已提交**的文件

于是有两个后果：

1. **相对路径在线程里解析不到**——它会相对自己的 worktree 去解
2. **根检出里未提交的知识文件，线程无论怎么解析都读不到**

**我额外验证的一点**（Opus 漏了）：我 grep 了全部测试，`test/knowledge.test.ts`、`test/unit/knowledgeSource.test.ts` 里**没有任何 worktree 相关断言**。也就是说这个缺陷目前没有测试覆盖，回归了也不会被发现。

`GAPS.md:170` 给的验收标准里明确要求「单测覆盖『worktree cwd + charter 路径 → 命中项目根文件』」——这条也没做。

### 问题 2：`REVIEW-REQUEST.md` 的待办已过期（Opus 自己记错了）🟡

`GAPS.md:554` 留了一条待办：

> 别再把它当「有据的基线」（**`REVIEW-REQUEST` §1 那一行应改掉**）

我核实了：**这一行早在 `bb71325` 就已经没了**。

- `8dad36c`（第一轮送审版）确实有：`docs/REVIEW-REQUEST.md:48`「记忆放在 system prompt 固定槽位以命中缓存 | "**Set context once**...」`
- `9866952`（第二轮送审版，326 行）grep `槽位|固定位置|system prompt|缓存` → **零命中**

所以这是一条**指向已消失内容的待办**。留着会误导下一轮复核者去找一个不存在的问题。

### 问题 3：记忆段预算报警没做 🟡

`GAPS.md:554` 的同一条待办后半句：

> 并用 `MAX_INSTRUCTIONS_CHARS` 同一把尺子给记忆段也设一个报警阈值。

现状：`MAX_INSTRUCTIONS_CHARS = 16_000` 已实现（`src/core/prompt.ts:36`），`instructionsOverBudget()` 也有（`:39`），但**记忆段没有任何对应的预算检查**——grep `memoryOverBudget|memoryBudget` 零命中。

这是 `BOUND-5` 的收尾项，优先级低但属于「登记了没做」。

### 问题 4：`PROJECT_BETA_SPEC.md:49` 仍把记忆槽位当「优化目标」🟡

这句话在 `bb71325` 之后就没动过：

> - **KV Cache 优化**：固定共享记忆在 System Prompt 中的挂载槽位，利用 DeepSeek-V4.1-Flash 的高压缩 KV Cache 实现跨轮次前缀高命中率。

按 `BOUND-5` 的新裁定，这已经不是「对上官方」而是「**我们的取舍**」，措辞应该改成「我们的取舍」而非陈述句。改动很小，但 SPEC 是给复核者看的第一手材料。

---

## 四、Opus 取证的可靠性

我逐条核了它引用的官方原文（spill 全文在 `C:\Users\Administrator\AppData\Local\Temp\dsh-spill-OEA0Ah\session-aead5a70c9e4\f2e10411f9f0-web_fetch.txt`，62983 字节）：

| Opus 的主张 | 我的核实 |
| --- | --- |
| `knowledge` 出现 0 次（第四个 0） | ✅ 确认，我原先只报了三个 |
| `MEMORY.md` 4 次 | ✅ 确认 |
| `16,000 characters` 1 次 | ✅ 确认，在 L296 |
| `100 files` 2 次 | ✅ 确认，在 L343 |
| `30 MB` 2 次 | ✅ 确认 |
| L253 审批原文 | ✅ 确认 |
| L197 圆点原文 | ✅ 确认 |
| L291 官方记忆是 paths-first | ✅ 确认 |

**结论：Opus 的取证主张成立**，它「逐字核过所以敢推翻自己」的自述可信。这轮它没有编造引文。

---

## 五、我的建议

1. **先做 `GAP-22a`**（唯一会静默出错的地方，且第一批「让输出可信」的目标要靠它收尾）
2. **顺手关掉问题 2、3、4 三条文档待办**（都只是文字，改动小）
3. 之后再进第二批（`GAP-26` 拆解模型优先）

需要你决定的是：`GAP-22a` 的路径锚定采用哪种形式？

- **方案 A（`GAPS.md:157` 推荐）**：渲染一次「项目根 = `<绝对路径>`」+ 用相对路径列文档 → 变动的只有一行，兼顾 prefix cache
- **方案 B**：每行都写绝对路径 → 最直观，但 charter 字节随机器变，跨机器缓存全废

我倾向 **方案 A**，理由和 `GAPS.md:157` 写的一致：「读不到文件是**错误**，缓存未命中只是**成本**」，但两害相权时能兼顾就兼顾。
