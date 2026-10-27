# Domain Docs

工程技能探索代码库时，如何消费本仓库的领域文档。

## 探索之前先读这些

- 仓库根目录的 **`GLOSSARY.md`**，或
- 仓库根目录的 **`GLOSSARY-MAP.md`**（若存在）：它指向每个 context 各一份 `GLOSSARY.md`。把与当前主题相关的都读一遍。
- **`docs/adr/`**：读与即将改动的区域相关的 ADR。多 context 仓库里还要看 `src/<context>/docs/adr/` 下的 context 级决策。

这些文件若不存在，**静默继续**。不要提示缺失，也不要在开工前建议先创建它们。`/domain-modeling` 技能（经由 `/grill-with-docs` 与 `/improve-codebase-architecture` 触达）会在术语或决策真正被确定时按需创建。

## 文件结构

本仓库为**单 context**（无 `pnpm-workspace.yaml`、无 `workspaces`、无 `packages/`）：

```
/
├── GLOSSARY.md
├── docs/adr/
│   ├── 0001-....md
│   └── 0002-....md
└── src/
    ├── core/     纯逻辑（不 import 任何 @deepseek-ai/dsh-*）
    └── host/     Host 适配层
```

若日后演化成多 context（根目录出现 `GLOSSARY-MAP.md`），结构为：

```
/
├── GLOSSARY-MAP.md
├── docs/adr/                          ← 系统级决策
└── src/
    ├── <context>/
    │   ├── GLOSSARY.md
    │   └── docs/adr/                  ← context 级决策
    └── ...
```

## 用 glossary 的词汇

输出里提到领域概念时（issue 标题、重构提案、假设、测试名），用 `GLOSSARY.md` 定义的术语，不要漂移到它明确回避的同义词。

需要的概念若还没进 glossary，那是个信号：要么你在发明项目不用的语言（重新考虑），要么确有空白（记下来交给 `/domain-modeling`）。

## 与 ADR 冲突时要显式提出

输出与既有 ADR 矛盾时，明确指出来，不要静默覆盖：

> _与 ADR-0007（event-sourced orders）冲突，但值得重开，因为…_
