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
