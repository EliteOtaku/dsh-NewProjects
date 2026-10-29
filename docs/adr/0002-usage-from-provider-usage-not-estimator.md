# 0002 token 花费取 provider 原文，估算只报上下文占用

- 状态：已采纳（2026-10-29）
- 影响：`src/core/usage.ts`、`src/host/usage.ts`、`ProjectEngine.usageSummary`、`/project usage`

## 背景

官方 Usage 面板要「按线程、按模型看 token 使用」。DSH 的 `tokenMeter` 看似就是这个接口，实际不是：

`tokenMeter.measure(session)` 返回 `TokenMeasurement`，其 `totalTokens` 是**这一次请求要发多少 token**（当前压强），不是已经花了多少。按它累加会把「上下文大小」当成「账单」，而且随对话压缩而减少——数字会往回走。

真正的账单数字在会话日志里：每条 `assistant/message` 事件带 `usage: TokenUsage`，那是 provider 返回的原文。

## 决定

1. **花费**只从 `assistant/message.usage` 累加（`inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens`）。
2. `tokenMeter` 只用于「当前上下文占用」一列，字段名 `pressureTokens`，**与花费分列、不相加、不混入总数**。
3. 归因按 `message.source` 的 `provider` + `model`，不按当前配置路由：同一线程可能中途换模型，读当前路由会把历史调用全记到现在的模型上。聚合键用 `provider/model`，只按 model 名合并会让两个 provider 的同名模型混成一行。
4. **不可用是一等答案**。整机没有会话日志、或某个子会话已不在，都让 `available: false` 并把原因留成文字；行仍然出现。一屏 0 加一条脚注会被读成「免费」。
5. 花费按需计算（`overviewJson({ includeUsage: true })`）：面板会轮询 overview，而 usage 要为每个线程读一遍会话日志。

## 后果

- 线程比 Host 进程活得久，所以「这个线程没有数据」是常态而非异常；总数因此**只会偏小，不会偏大**，并把原因写在面板顶部。
- 未来若 Host 提供真正的账单聚合，`UsagePort` 是唯一需要改的地方。
