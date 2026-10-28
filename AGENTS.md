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
npm run verify     # typecheck + build + test，共 261 项测试
npm test           # 只跑测试
npm run build      # 只编译到 lib/
```

**提交前必须 `npm run verify` 全绿。** `lib/` 是提交进仓库的构建产物（插件从 git 安装时没有构建步骤），所以改完 `src/` 一定要重新 `npm run build`，否则运行时加载的是旧代码。

## 硬性约束

- **`src/core/` 不 import 任何 `@deepseek-ai/dsh-*`**。外部插件解析不到 Host 内部包，引入即加载失败。Host 的形状声明全部集中在 `src/host/hostTypes.ts`。
- **git 与 `gh` 一律走 `CommandRunner` 端口**，不用 `node:child_process`。命令必须落在 Host 所在的机器上；SSH / 容器部署时用后者会在错误的主机上执行。测试里可以真跑 git（`test/integration/`），源码里不行。
- **`subprocess` 是唯一硬依赖**（写在 `inject` 里）。其余服务（tools / commands / systemPrompt / timer + subagents）全部走 `ctx.inject` 延迟注册——`ctx.get` 只在激活那一刻采样注册表，晚挂载的服务会永久错过。
- **纯逻辑与 Host 解耦**：`ProjectEngine` 只依赖 `CommandRunner` 与 `ThreadRuntime` 两个端口，所有协调策略都能用内存 fake 单测。

## 写测试时的注意点

- 新测试放对目录决定 import 深度：`test/*.ts` 用 `../src/...`，`test/unit/*.ts` 与 `test/integration/*.ts` 用 `../../src/...`。
- 测试文件名不能和已有文件重名（tsc 输出到同一 `build/test/` 前缀，会互相覆盖）。
- 断言失败时先分清是**测试写错**还是**实现写错**：读实现确认契约，再决定改哪边。
- `FakeRunner` 无匹配路由会抛错——这是故意的，静默空结果会让坏测试看起来通过。

## 设计取舍（改代码前先读）

记录在 [README.md 的「设计取舍」](./README.md#设计取舍) 一节，包括：拆解不调模型、每个线程一个私有 worktree、一轮结束不等于已交付、广播只推正在跑的线程、未知 CI 状态算 `pending`、知识模式由体积派生不存 flag。

## 未实现部分与已知缺陷（动手前必读）

[docs/GAPS.md](./docs/GAPS.md) 是**实现差距登记簿**：相对官方 Claude Code Projects 与 `PROJECT_BETA_SPEC.md` 的每一处未实现、缺陷、有意边界，都带**代码证据（文件:行号）、依据来源、验收标准**。

规则：

- **别凭记忆判断"这个还没做"或"这个已经做了"**——先查登记簿。已经踩过两次：把「并发度控制」误判为缺口（官方明确说它不是硬上限）、把「review verdicts 未接入」误判为缺（实际已接入，`src/core/engine.ts:806`）。两处都记在登记簿的「已修正的错误判断」表里。
- **按 `## 分批计划` 推进**，不要跨批混做。批内条目有依赖（例如六分组必须等会话投影先做），拆开做会返工。
- **优先级按「会不会安静地出错」排**：会静默产出错误结果的（配额口径、知识陈旧）在前，只影响磁盘或观感的（worktree 回收、purge）在后。
- **`ARCH` 与 `BOUND` 两节不是待办**。前者是产品定位差异，后者是 Host 安全模型决定改不动的限制；重新分析它们等于浪费一轮。
- 条目完工后：勾掉状态、更新行号、同步 `README.md` 里因此变化的事实陈述（README 曾有虚述，见 `GAP-03`）。

