# AGENTS.md

本文件给在本仓库工作的编码 agent 提供约定。面向人类的使用说明见 [README.md](./README.md)。

## Agent skills

### Issue tracker

Issue 与规格都存在本仓库的 GitHub Issues（`EliteOtaku/dsh-NewProjects`），操作走 `gh` CLI。见 `docs/agents/issue-tracker.md`。

### Triage labels

沿用默认五档词汇：`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`，均已在 GitHub 上建好。见 `docs/agents/triage-labels.md`。

### Domain docs

单 context 布局：根目录一份 `GLOSSARY.md` + `docs/adr/`。见 `docs/agents/domain.md`。

## 构建与验证

```bash
npm install
npm run verify     # typecheck + build + test，共 341 项测试
npm test           # 只跑测试
npm run build      # 只编译到 lib/
```

**提交前必须 `npm run verify` 全绿。** `lib/` 是提交进仓库的构建产物（插件从 git 安装时没有构建步骤），所以改完 `src/` 一定要重新 `npm run build`，否则运行时加载的是旧代码。

## 硬性约束

- **`src/core/` 不 import 任何 `@deepseek-ai/dsh-*`**。外部插件解析不到 Host 内部包，引入即加载失败。Host 的形状声明全部集中在 `src/host/hostTypes.ts`。
- **git 与 `gh` 一律走 `CommandRunner` 端口**，不用 `node:child_process`。命令必须落在 Host 所在的机器上；SSH / 容器部署时用后者会在错误的主机上执行。测试里可以真跑 git（`test/integration/`），源码里不行。
- **`subprocess` 是唯一硬依赖**（写在 `inject` 里）。其余服务（tools / commands / systemPrompt / timer + subagents）全部走 `ctx.inject` 延迟注册——`ctx.get` 只在激活那一刻采样注册表，晚挂载的服务会永久错过。
- **纯逻辑与 Host 解耦**：`ProjectEngine` 只依赖 `CommandRunner` 与 `ThreadRuntime` 两个端口，所有协调策略都能用内存 fake 单测。
- **子线程没有人类应答者**。`userQuestions.ask` 对 owned agent 抛 `DELEGATED_CALLER`，`approval.request` 只服务单次工具调用且要求 open turn。任何「停下来问人」的设计必须走「根会话问人、线程执行」的形态，不能在线程里阻塞等人。见 `docs/GAPS.md` 的 `GAP-18`。

## 复刻边界（判断「缺不缺」之前必读）

本项目**复刻的是 Claude Code 新版 Projects (Beta) 这个功能本身**（概念、行为、状态语义、交互契约），交付形态是 **DSH 本地插件**。规格来源只有 <https://code.claude.com/docs/en/claude-projects> 一份（[`.md` 版](https://code.claude.com/docs/en/claude-projects.md)）。

宿主能力以 **DSH 源码**为准：<https://github.com/deepseek-ai/deepseek-harness>。「在 DSH 上做不到」这类判断（`BOUND` 段、审批改译）的依据在那里，不在官方文档里。

**不是**重建 Anthropic 的云产品。云端 sandbox、GitHub App、账号 connectors、cloud environment、跨设备续跑都不做。

判断一项「缺不缺」看的是**功能语义有没有**（用户能不能做到这件事），不是**云端的实现载体有没有**。凡是「官方用 A 载体实现 X，我们用 B 载体实现了 X」的（云端 sandbox → 本地 worktree、云端持久化会话 → DSH 子会话、GitHub App → `gh` CLI），记在登记簿的 `ARCH` 段，**不是缺陷、不排期**。

`support.claude.com` 的 RAG 专文讲的是**另一个产品**（claude.ai chat 的旧版 Projects，无 threads、无 coordinator），**不构成本项目规格**。曾经的错误结论与证据见 `docs/GAPS.md` 的「依据来源」与「已修正的错误判断」。

## 写测试时的注意点

- 新测试放对目录决定 import 深度：`test/*.ts` 用 `../src/...`，`test/unit/*.ts` 与 `test/integration/*.ts` 用 `../../src/...`。
- 测试文件名不能和已有文件重名（tsc 输出到同一 `build/test/` 前缀，会互相覆盖）。
- 断言失败时先分清是**测试写错**还是**实现写错**：读实现确认契约，再决定改哪边。
- `FakeRunner` 无匹配路由会抛错——这是故意的，静默空结果会让坏测试看起来通过。
- 改路由表时注意 `gh pr view` 有**两种调用形态**：按分支（`argv[3]` 是分支名）与按编号（`argv[3]` 是数字，用于查 state/isDraft）。fake 必须按 `/^\d+$/` 分流。
- 涉及 turn-end 的断言没有 promise 可 await（listener → 异步 store 落盘），用轮询式 `eventually()`，不要用一次 `setImmediate` 掩盖路由 bug。

## 设计取舍（改代码前先读）

记录在 [README.md 的「设计取舍」](./README.md#设计取舍) 一节，包括：每个线程一个私有 worktree、一律走 `CommandRunner`、一轮结束不等于已交付、广播只推正在跑的线程、未知 CI 状态算 `pending`、不可逆动作与它的防护同批、`subprocess` 唯一硬依赖。

> ✅ **拆解已改为模型优先（`GAP-26` 2026-10-29 关闭）**，但落法是「计划从参数进来」而不是工具内调模型——协调者本身就是那个模型，工具只校验 `tasks`。
> 新代码不要退回「拿正则当主路径」：正则只做 fallback，且**猜出来的拆解必须先提议、不直接启动**（`planOrigin: 'fallback'` → `planOnly`）。

## 未实现部分与已知缺陷（动手前必读）

[docs/GAPS.md](./docs/GAPS.md) 是**实现差距登记簿**：相对官方 Code Projects 的每一处未实现、缺陷、有意边界，都带**代码证据（文件:行号）、依据来源、验收标准**。它是判断「某个能力到底有没有」的**唯一依据**。

规则：

- **别凭记忆判断「这个还没做」或「这个已经做了」**——先查登记簿。已经踩过多次，全部记在「已修正的错误判断」表里，最近一轮包括：把「并发度控制」误判为缺口（官方明确说它不是硬上限）、把「review verdicts 未接入」误判为缺（实际已接入）、「投影必须晚于状态模型」（约束不成立）、「改状态模型是破坏性改动」（实际约一百二十行，仍是加法）、「项目要绑定长期会话」（框架错了）、「知识两模式已对上官方」（抄错了产品）。
- **按 `## 分批计划` 推进**，不要跨批混做。批内条目有依赖（例如 worktree 回收依赖 Library 先有产出清单），拆开做会返工。
- **优先级看两件事**：①会不会**安静地**出错（会静默产错答案的最前，只影响磁盘或观感的最后）；②**它是不是后续批次的输入**。上一轮的教训是只看第一条，把「错得不安静」的拆解质量过滤到了最后，等于给错的输入抛光。
- **`ARCH` 与 `BOUND` 两节不是待办**。前者是载体差异，后者是 Host 安全模型决定改不动的限制；重新分析它们等于浪费一轮。
- **证据行号会漂移**。改动相关代码后回来更新行号；行号失效时按**符号名**搜索（函数名、常量名是稳定契约）。
- 条目完工后：勾掉状态、更新行号、同步 `README.md` / `PROJECT_BETA_SPEC.md` 里因此变化的事实陈述（README 曾有过虚述，见 `GAP-03`）。

## 文档地图

| 文件 | 作用 |
| --- | --- |
| `PROJECT_BETA_SPEC.md` | **目标规范**（要做什么），功能语义以官方文档为准 |
| `docs/GAPS.md` | **差距登记簿**（做到哪了）—— 判断「有没有」的唯一依据 |
| `docs/REVIEW-REQUEST.md` | 给外部复核者的判断与疑问（我方立场） |
| `docs/REVIEW-RESPONSE.md` | 外部复核回执（对方观点，含逐条证据） |
| `README.md` | 面向人类的使用说明 |

改任何一份之前先看 `docs/GAPS.md`：那里的条目都带代码证据与验收标准，是判断现状的基准。
