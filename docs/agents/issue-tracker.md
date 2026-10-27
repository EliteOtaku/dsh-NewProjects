# Issue 追踪：GitHub

本仓库的 issue 与规格都放在 GitHub Issues（`EliteOtaku/dsh-NewProjects`）。所有操作走 `gh` CLI。

## 约定

- **建 issue**：`gh issue create --title "..." --body "..."`。多行正文用 heredoc。
- **读 issue**：`gh issue view <number> --json number,title,body,labels,comments`。
- **列 issue**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，配合 `--label` 与 `--state` 过滤。
- **设为某个父 issue 的子 issue**：`gh issue create --parent <parent> ...`，或事后 `gh issue edit <parent> --add-sub-issue <child>`（gh 2.94+）。旧版 gh：`gh api --method POST repos/<owner>/<repo>/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>`（要数据库 id，不是 `#number`）。环境不支持 sub-issue 时，在子 issue 正文顶部写 `Part of #<parent>`。
- **评论**：`gh issue comment <number> --body "..."`
- **加/去标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **关闭**：`gh issue close <number> --comment "..."`

仓库从 `git remote -v` 推断；在 clone 里运行 `gh` 会自动识别。

## PR 是否作为需求来源

**PR as a request surface: no。**（若本仓库把外部 PR 当作功能请求，改成 `yes`；`/triage` 会读这个标志。）

设为 `yes` 时，PR 与 issue 走同一套标签与状态，命令换成 `gh pr` 对应项：

- **读 PR**：`gh pr view <number> --comments`；看 diff 用 `gh pr diff <number>`。
- **列出待 triage 的外部 PR**：`gh api --paginate 'repos/{owner}/{repo}/pulls?state=open' --jq '.[] | select(.author_association | IN("OWNER","MEMBER","COLLABORATOR") | not) | {number, title, author: .user.login, author_association, labels: [.labels[].name]}'`。
- **评论 / 打标签 / 关闭**：`gh pr comment`、`gh pr edit --add-label`/`--remove-label`、`gh pr close`。

GitHub 的 issue 与 PR 共用一个编号空间，裸写的 `#42` 可能是任一者：先用 `gh pr view 42` 判断，失败再 `gh issue view 42`。

## 当技能说「发布到 issue tracker」

建一条 GitHub issue。

## 当技能说「取出对应的 ticket」

按上文 **读 issue** 读取。

## Wayfinding 操作

供 `/wayfinder` 使用。**地图**是一个 issue，**子 issue** 是 ticket。

- **地图**：带 `wayfinder:map` 标签的单条 issue，正文存 Notes / Decisions-so-far / Fog。`gh issue create --label wayfinder:map`。
- **子 ticket**：作为地图的 GitHub sub-issue 关联（见上）。不支持 sub-issue 时，把子 ticket 加进地图正文的 task list，并在子 ticket 正文顶部写 `Part of #<map>`。标签用 `wayfinder:<type>`（`research`/`prototype`/`grilling`/`task`）。认领后指派给推动者。
- **阻塞关系**：用 GitHub **原生 issue 依赖**（UI 可见，是权威表示）。加边：`gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`，其中 `<blocker-db-id>` 是阻塞者的数字**数据库 id**（`gh api repos/<owner>/<repo>/issues/<n> --jq .id`），不是 `#number` 或 `node_id`。GitHub 用 `issue_dependencies_summary.blocked_by` 报告未关闭的阻塞者（实时闸门）。不支持依赖时回退到子 issue 正文顶部写 `Blocked by: #<n>, #<n>`。所有阻塞者关闭后该 ticket 解除阻塞。
- **前沿查询**：列出地图下未关闭的子 issue（`gh issue list --state open`，范围限定在地图的 sub-issue / task list），剔除有未关闭阻塞者（`issue_dependencies_summary.blocked_by > 0`，或 `Blocked by` 行里有未关闭 issue）或已有 assignee 的，按地图顺序取第一个。
- **认领**：`gh issue edit <n> --add-assignee @me`，这是本 session 的第一次写入。
- **解决**：`gh issue comment <n> --body "<answer>"`，然后 `gh issue close <n>`，再把上下文指针（gist + 链接）追加到地图的 Decisions-so-far。
