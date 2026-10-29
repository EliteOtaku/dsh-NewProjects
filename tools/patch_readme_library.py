import io

NL = chr(10)
p = 'README.md'
s = io.open(p, encoding='utf-8').read()


def replace_once(text, old, new):
    assert text.count(old) == 1, (text.count(old), old[:60])
    return text.replace(old, new)


# capability table: add a row for Library + PR tabs after Overview
old_row = "| **Overview 面板** | 官方六分组（`Ready for review` / `Waiting on you` / `Working` / `Landing` / `Idle` / `Resolved`）+ 当日配额 + 知识状态；写入后自动把快照 append 进协调者会话，面板是**事件折叠**而非轮询。`project_overview` 工具与 `/project` 命令提供同样的数据。 |\n"
new_row = old_row + (
    "| **Library 与 Pull requests** | `Library` 是**清单 + 按需读取**，不是存储层：`deliverThread` 记下 `git diff --name-status <base>..<branch>`（`--no-renames`，重命名显示为删除+新增），worktree 回收后清单仍在，`read` 现读现取；文件不在了就如实报不可读，绝不返回空内容。`Pull requests` 从各线程最后一次观察快照按状态分组（open/draft/merged/closed/unknown）并统计 checks 与未消费评论数——面板自己不查 GitHub，那是自愈巡检的活。两者都没有内容时**整个字段不出现**，不返回空数组。 |\n"
)
s = replace_once(s, old_row, new_row)

s = replace_once(s, "## 五块能力", "## 六块能力")

# commands block
old_cmd = "```\n/project knowledge rebuild    # 重新扫描（改了被绑定的文件之后）\n```"
new_cmd = "```\n/project knowledge rebuild    # 重新扫描（改了被绑定的文件之后）\n/project library              # 线程产出的文件清单\n/project library read <path>  # 读其中一个（按需，从产出它的 worktree）\n```"
assert s.count(old_cmd) == 1
s = s.replace(old_cmd, new_cmd, 1)

old_count = "```\n/project knowledge rebuild    # 重新扫描（改了被绑定的文件之后）\n"
# nothing else

# tools list
old_tools = "模型侧对应六个工具：`project_coordinate`、`project_memory_sync`、\n`project_thread_manage`、`project_overview`、`project_knowledge_search`、\n`project_knowledge`。"
new_tools = "模型侧对应七个工具：`project_coordinate`、`project_memory_sync`、\n`project_thread_manage`、`project_overview`、`project_knowledge_search`、\n`project_knowledge`、`project_library`。"
s = replace_once(s, old_tools, new_tools)

# test count
s = replace_once(s, "共 **341 项测试**", "共 **375 项测试**")

# unimplemented list
old_todo = "相对官方 Claude Code Projects 还有若干未实现的能力（goal 持久化、Library、PR 聚合、Pause/Archive、审批改译等）"
new_todo = "相对官方 Claude Code Projects 还有若干未实现的能力（goal 持久化、`Merge it` 等卡片动作、Pause/Archive、审批改译、Usage 统计等）"
s = replace_once(s, old_todo, new_todo)

io.open(p, 'w', encoding='utf-8', newline=NL).write(s)
print('readme updated')
