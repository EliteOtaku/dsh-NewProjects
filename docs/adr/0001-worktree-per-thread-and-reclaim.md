# 0001 线程隔离用私有 worktree，交付后回收、唤醒前重建

- 状态：已采纳（2026-10-29）
- 影响：`src/core/engine.ts` 的 `prepareIsolation` / `checkoutFor` / `deliverThread`、`src/core/vcs.ts` 的 `createBranch` / `removeWorktree` / `ensureWorktree`

## 背景

线程在子会话里跑，子会话的 cwd 就是它动手的目录。最初只建 `git branch` 不建 worktree，理由是 `worktrees.create` 会切换父会话当前目录、属副作用。

全链路测试暴露了真实后果：线程仍跑在父检出里，并发时互相看见未提交改动；更糟的是 `deliverThread` 的提交落在父会话当前分支，却推送仍停在基线的线程分支——**隔离是名义上的**。

## 决定

1. 每个线程一个私有 worktree：`.dsh-project/worktrees/<threadId>`，由 `git worktree add -b <branch> <path> <base>` 建立。`git branch` 单独使用不再是隔离手段。
2. worktree 建失败（`git` 不支持、路径冲突）降级为「有分支、无 worktree」，并如实记在 descriptor 上，不假装隔离成功。
3. **交付即回收**：PR 建好后 `git worktree remove --force`。理由是分支才是真相，长期留着的检出只会占盘并且误导人以为那里还有活的上下文。
4. **唤醒前重建**：子会话的 cwd 就是 worktree 路径，`respond` / `retry` / `merge` / `conflicts` 前先 `ensureWorktree`，不存在则 `git worktree add <path> <branch>`。没有这一步，「交付即回收」会把握手言欢的唤醒变成 `ENOENT`。

## 后果

- 交付后 `library read` 仍可用：清单存在 descriptor 上，读盘失败时如实报「worktree 已回收，文件在分支 X 上，合并后才可读」。
- `.dsh-project/` 自身必须进 git ignore，否则 worktree 里的检出会把索引文件当成改动。
- 得到一个可复用的结论：任何「让子会话在某目录干活」的设计，都要区分**目录的生命周期**与**会话的生命周期**，两者不同步。
