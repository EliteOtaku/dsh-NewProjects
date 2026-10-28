# dsh-newprojects

Claude Code **Projects (Beta)** 式的动态协作中枢，作为 DeepSeek Harness 插件运行。

把一个高层目标拆成互不阻塞的子任务，每个子任务交给一个**独立 git 分支上的后台线程**去干；
线程跨轮次持续运行、跨线程共享同一份项目决策记忆、CI 失败或 PR 收到审查意见时自动唤醒修复。

```
                 ┌──────────── 共享记忆（.dsh-project/manifest.json）────────────┐
                 │  跨线程决策 · CAS 写入 · 稳定前缀注入 system prompt              │
                 └───────┬─────────────────────┬─────────────────────┬──────────┘
  /project coordinate ──▶│ coordinator         │                     │
                         ▼                     ▼                     ▼
                   thread A (branch 1)   thread B (branch 2)   thread C (branch 3)
                         │                     │                     │
                    push + PR            push + PR              push + PR
                         ▼                     ▼                     ▼
                    ┌────────── /project heal：CI 失败 / Review 评论 → 唤醒对应线程 ──────┐
```

## 五块能力

| 能力 | 实现 |
| --- | --- |
| **Coordinator + 并行 Threads** | `project_coordinate` 工具把目标按 bullet 确定性拆解（不调模型），每个任务一个 `subagents` 子会话 + 独立 `git branch` + 私有 worktree。每日配额默认 200，全有或全无地预留，启动失败自动退还。（**配额目前按项目独立计数，未做到跨项目合计**——见 [`docs/GAPS.md`](docs/GAPS.md) 的 `GAP-01`。） |
| **跨线程共享记忆** | `project_memory_sync` 写入决策后广播到所有**正在运行**的线程；新线程启动前缀自动带上全量记忆。记忆渲染成字节稳定的 system prompt 段，命中 provider 端 prefix cache。 |
| **项目知识（RAG）** | 绑定文件或目录后自动切分、建索引（BM25）。小项目把知识**全文**放进 system prompt；超过预算自动切换到**检索模式**，只留工具说明，由 `project_knowledge_search` 按需取回。判定看当前体积，不存 flag。 |
| **自动执行与 CI/PR 自愈** | 线程自己跑测试、commit、push、开 PR。`/project heal` 与后台巡检读 `gh pr checks` / review comments，判定 `heal` / `wait` / `escalate` / `transition`，最多自动修 3 轮。 |
| **Overview 面板** | `project_overview` 工具与 `/project` 命令输出五类状态桶（完成 / 待审 PR / 等反馈 / 运行中 / 失败）+ 当日配额 + 知识模式。**尚未接入会话投影**，面板不会随会话事件自动刷新——见 [`docs/GAPS.md`](docs/GAPS.md) 的 `GAP-03`。 |


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
/project                      # 总览：四类状态 + 当日配额
/project init [name]          # 为当前工作区建项目记录
/project memory               # 列出共享决策
/project memory stack = TypeScript on Node   # 写一条决策并广播
/project memory rm stack      # 删一条
/project threads              # 所有线程及其状态
/project thread <id> steer|respond|retry|interrupt|close|deliver [text]
/project heal                 # 手动跑一次 CI/PR 巡检
/project coordinate <goal>    # 拆解并启动线程（确定性；批量场景优先用工具）
/project knowledge            # 知识层状态：模式、文档数、字符数、绑定路径
/project knowledge add <path> [path...]   # 绑定文件或目录并重建索引
/project knowledge rm <path>  # 解绑
/project knowledge rebuild    # 重新扫描（改了被绑定的文件之后）
```

模型侧对应六个工具：`project_coordinate`、`project_memory_sync`、
`project_thread_manage`、`project_overview`、`project_knowledge_search`、
`project_knowledge`。

### 项目知识：什么时候是全文、什么时候是检索

| 模式 | 触发条件 | system prompt 里有什么 |
| --- | --- | --- |
| `context` | 知识总字符数 ≤ 预算（默认 96 000 字符 ≈ 24k tokens） | **全部文档正文**，按路径排序 |
| `rag` | 超过预算 | 只有检索工具说明与来源清单，**不含正文** |

模式由当前体积派生，不存成 flag：知识增删后重建索引即自动切换，缩回预算以下会切回全文。
容量上限是预算的 10 倍（对应官方的「最多扩展 10 倍」），超出部分在收集阶段截断并记 warning。

检索是 BM25，中文按重叠 bigram 切词（`项目知识` → `项目` / `目知` / `知识`），
所以中文查询不需要分词器也能命中。结果按 `path:起止行` 引用，排序稳定（同分按路径与行号），
两次相同查询结果完全一致——否则 prompt 前缀缓存会失效。

### 线程的六种状态

| 状态 | 含义 | 谁会推进 |
| --- | --- | --- |
| `queued` | 已排队或中断待恢复 | `/project thread <id> retry` |
| `running` | 正在跑 | 线程自身 |
| `ci_fixing` | 收到 CI 失败或被要求改，正在修 | 线程自身（+ 巡检） |
| `awaiting_review` | 已开 PR，等人工评审 | 评审人 / `heal` 的 merged 检测 |
| `needs_feedback` | 需要人拍板（含"跑完了但没交付"） | `/project thread <id> respond <text>` |
| `completed` / `failed` | 收尾 | — |

## 目录布局

```
src/core/          纯逻辑：manifest / quota / memory / planner / healing / overview / vcs /
                   knowledge（切分·BM25·模式判定）/ knowledgeSource（唯一碰文件） / engine
src/host/          Host 适配：subprocess 命令行、subagents 线程、tools、commands、类型声明
test/unit/         纯逻辑单测（内存 fake）
test/engine.test.ts 全链路：真实临时目录 + fake git / fake 线程
test/knowledge.test.ts 知识层接入：真实文件、真实索引文件、模式切换
test/integration/  真实 git 集成：真仓库、真 worktree、真 push（无 git 时自动 skip）
test/commands|tools|index.test.ts  适配层与插件入口
```

共 **261 项测试**（`node:test`）。除集成测试外全部跑在内存 fake 上，不需要 git 或真实子会话。

`src/core/` **不 import 任何 `@deepseek-ai/dsh-*`**：外部插件解析不到 Host 内部包。
Git 与 `gh` 一律经 `CommandRunner` 端口调用，因此 SSH / 容器部署时命令在正确机器上执行。

## 开发

```bash
npm install
npm run verify     # typecheck + build + test
npm test           # 只跑测试
```

## 设计取舍

- **拆解不调模型**：`planTasks` 是确定性文本分析。协调必须在委派模型不可用时仍能工作，必须可单测，且不得凭空发明用户没要求的工作。
- **每个线程一个私有 worktree**：只建分支不算隔离——线程仍在父检出里跑，并发时互相看见对方的改动，提交还会落到父会话当前分支上。worktree 建在 `.dsh-project/worktrees/<threadId>`（已 gitignore），父检出永不移动。建不出来时降级为纯 scope 隔离并在状态里说明，而不是假装隔离了。
- **一律走 `CommandRunner` 而非 `node:child_process`**：命令必须落在 Host 所在的机器上，SSH / 容器部署时后者会在错误的主机上执行。
- **一轮结束 ≠ 已交付**：线程收尾消息里没有 PR 链接时进入 `needs_feedback`，而不是给一个声称产物存在的 `completed` 徽章。
- **广播只推正在跑的线程**：给 idle 子会话发消息会新起一轮，把所有已完成线程都唤醒会白烧 token。
- **未知 CI 状态算 `pending`，不算通过**：假绿是自愈器绝不能产生的输出。
- **知识模式由体积派生，不存 flag**：官方语义要求「知识缩回阈值以下时自动切回上下文模式」。任何持久化的 mode 字段都会让这条路径无法成立——切回需要有人主动清标记，而现实中没有人会。
- **检索工具始终注册，不按模式增删**：项目随时可能跨过预算线，工具列表来回变会让 provider 的 prompt 缓存失效，且没有任何收益。
- **索引是派生状态**：`.dsh-project/KNOWLEDGE_INDEX.json` 已 gitignore，随时可从绑定的文件重建；坏索引被当作「没有索引」而不是致命错误。
- **`subprocess` 是唯一硬依赖**：其余能力（tools / commands / systemPrompt / timer + subagents）全部走 `ctx.inject` 延迟注册。`ctx.get` 只在激活那一刻采样注册表，晚挂载的服务会永久错过。

## 已知未实现部分

相对官方 Claude Code Projects 还有若干未实现的能力（会话投影、六分组 Overview、goal 持久化、Library、Pause/Archive、全局配额等）与若干有意为之的边界（重启后后台自愈停摆、云端 sandbox 差异等）。

完整清单、代码证据、依据来源与验收标准见 **[docs/GAPS.md](./docs/GAPS.md)**，按批次推进。那份文档是判断「某个能力到底有没有」的唯一依据——不要凭本文件的段落推断。

## 许可证

[MIT](./LICENSE)
