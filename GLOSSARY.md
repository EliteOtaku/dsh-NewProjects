# 术语表

本仓库单 context。术语按「在本项目里是什么意思」定义，官方同名但语义不同的会注明差异。加了 **（官方）** 的是直接沿用 Claude Code Projects 文档的用法。

## 参与方

| 术语 | 含义 |
| --- | --- |
| **项目 / project** | 一份 `.dsh-project/manifest.json` 加它描述的工作。不是一个会话、不是一个目录绑定，任何会话进来都能从 manifest 恢复上下文。 |
| **协调者 / coordinator** | 调用本插件工具的那个根会话。**不是**插件里另起的一个模型：拆解由协调者给出（`project_coordinate` 的 `tasks`），插件只做校验。 |
| **线程 / thread** | 一个 `subagents` 子会话 + 一个 git 分支 + 一个私有 worktree + 一条 `ProjectThreadDescriptor`。四者同生，但**会话可以比进程活得久**，所以描述符与分支才是持久的那一半。 |
| **descriptor** | `ProjectManifest.threads[id]` 那一条。是线程的持久记录，也是面板的唯一数据来源。 |
| **共享记忆 / memory** | 项目级决策条目（`ProjectMemoryEntry`），按 key 索引、自带 revision。写进所有线程共享的 system prompt 前缀，因此**内容决定字节，时间戳不得进入**。 |
| **worktree** | 线程的私有检出，路径 `.dsh-project/worktrees/<threadId>`。交付后回收，唤醒前重建（见 ADR 0001）。 |

## 状态

官方六个分组是**人视角**的「轮到谁」投影，不是两套模型。我方状态机按同一轴分层，`bucketOf()` 是唯一投影函数。

| 我方状态 | 官方分组 | 轮到谁 |
| --- | --- | --- |
| `queued` / `running` / `ci_fixing` | **Working** | AI |
| `awaiting_review` | **Ready for review** | 人（看 PR） |
| `landing` | **Landing** | AI（已批准，等落地） |
| `needs_feedback` / `failed` | **Waiting on you** | 人（回一句或批准） |
| `completed` | **Idle** | 没人（做完且不欠什么） |
| `resolved` | **Resolved** | 无人（已关闭，可 reopen） |

- **`needs_feedback` 不是错误**：线程跑完但没交出可评审的东西（没有 PR 链接），或撞上需要签字的动作。它与 `failed` 同在「Waiting on you」，但**原因不同、允许的动作也不同**。
- **一轮结束 ≠ 已交付**：`stopReason: 'completed'` 只说明这轮该模型说完了。只有拿到 PR 引用才进 `awaiting_review`。
- **`resolved` 是终态且可逆**：由人关闭，或 `completed` 静置一周自动归入。
- **`paused` / `archived` 不是状态**：它们是项目级时间戳，与线程状态正交。

## 动作

| 术语 | 含义 |
| --- | --- |
| **deliver** | commit → push → 开 PR，然后回收 worktree。没东西可提交时如实报 `nothing to commit`。 |
| **heal** | 读 CI / review 判定要修，把失败信息发给线程让它自己修。宿主**不代跑**修复。 |
| **settle** | PR 已合并或已关闭，线程不再需要盯它：退订并落到终态。 |
| **approve** | 对 `requireApprovalFor` 列出的不可逆动作签发许可，**一次性**消耗。 |
| **pause / resume** | 项目级停止：不启动、不巡检、不交付，活跃线程被中断。 |
| **suggest / start / drop** | 拆解的三段：先提议（`planOnly`）、再启动（`start`）、或丢弃（`drop`）。猜出来的拆解**必须**先提议。 |

## 数据与边界

| 术语 | 含义 |
| --- | --- |
| **quota（配额）** | 每日新建线程上限 200，**按用户跨项目合计**（`~/.dsh/dsh-newprojects/quota.json`）。`manifest.dailyThreadQuotaMax` 是偏好，不是硬限。 |
| **prefix / charter** | 所有线程与协调者共享的 system prompt 段。**字节稳定**是它的全部意义：任何时间戳、线程 id、计数器都会让 provider 端的 prefix cache 失效。 |
| **memory watermark** | 每个子会话已投递到的记忆 revision。广播只推 `busy` 的会话，因为给 idle 子会话发消息会**新起一轮**。 |
| **library** | 线程产出的文件清单（`git diff --name-status`），不是内容存储。worktree 回收后清单仍在，`read` 现读现取。 |
| **usage** | token 花费，取会话日志里 provider 原文的 `usage`。`tokenMeter` 只报当前上下文占用，**与花费分列、绝不相加**。 |
| **BOUND** | Host 安全模型决定改不动的限制（见 `docs/GAPS.md`），不是待办。 |
| **ARCH** | 载体差异（云端 sandbox → 本地 worktree 等），不是缺陷、不排期。 |
