# Triage 标签

上游工程技能用五个固定角色说话（`needs-triage` 等）。本文件把角色映射到本仓库 issue tracker 里**实际使用的标签字符串**。

| 上游技能里的标签 | 本仓库 tracker 里的标签 | 含义 |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | 维护者需要评估这条 issue |
| `needs-info` | `needs-info` | 等报告者补充信息 |
| `ready-for-agent` | `ready-for-agent` | 规格完整，可交给 AFK agent 独立实现 |
| `ready-for-human` | `ready-for-human` | 需要人类实现 |
| `wontfix` | `wontfix` | 不会处理 |

本仓库沿用默认词汇，五个标签已在 GitHub 上建好（`wontfix` 为仓库原有的通用标签，语义与本角色的"不会处理"一致，故复用不重建）。

当技能提到某个角色（例如"打上 AFK-ready 的 triage 标签"），就从本表取对应的标签字符串。

若日后本仓库改用别的命名（例如 `bug:triage` 对应 `needs-triage`），改"本仓库 tracker 里的标签"一列即可；`triage` 技能会按本表套用现有标签，不会创建重复标签。
