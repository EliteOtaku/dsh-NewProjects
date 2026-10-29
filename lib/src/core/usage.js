/**
 * Token usage accounting for a project's threads.
 *
 * The official product shows a Usage tab in project settings: "token use by thread and by model".
 * The numbers themselves come from the provider — the Host stores them on each assistant message —
 * so everything here is aggregation and rendering, never estimation dressed up as measurement.
 *
 * Two rules shaped this module:
 *
 * 1. **Unavailable is a first-class answer.** A project whose threads ran in a Host that keeps no
 *    session log cannot report per-thread spend. Reporting 0 there would read as "you spent
 *    nothing", which is worse than an honest gap, so absence is carried as text, not as zero.
 * 2. **A missing thread is not a zero-cost thread.** Threads outlive the Host process; a
 *    descriptor whose session is gone still appears, marked, so the total never silently shrinks.
 */
/**
 * Adds one thread's rows into a per-model accumulator.
 *
 * Keyed by `provider/model` because two threads on different providers can both be "the same
 * model name"; keying by model alone would merge them and make the breakdown lie.
 */
export function addModelUsage(target, row) {
    const key = `${row.provider}/${row.model}`;
    const current = target.get(key);
    if (current === undefined) {
        target.set(key, { ...row });
        return;
    }
    current.calls += row.calls;
    current.inputTokens += row.inputTokens;
    current.outputTokens += row.outputTokens;
    current.cacheReadTokens += row.cacheReadTokens;
    current.cacheWriteTokens += row.cacheWriteTokens;
}
/**
 * Builds the project view from per-thread measurements.
 *
 * `measured` maps thread id → raw usage. Threads missing from the map are reported as unavailable
 * *individually*: one lost session must not turn the whole project's total into "unknown".
 */
export function buildUsage(threads, measured, observedAt, fallbackReason) {
    const rows = [];
    const byModel = new Map();
    const totals = { threads: threads.length, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const gaps = [];
    // A reason that applies to the entire project is stated once, so the notice does not repeat
    // one sentence per thread.
    if (fallbackReason !== undefined)
        gaps.push(fallbackReason);
    for (const thread of threads) {
        const raw = measured.get(thread.threadId);
        if (raw === undefined) {
            const why = fallbackReason ?? 'the Host has no usage record for this thread';
            rows.push({
                threadId: thread.threadId,
                title: thread.title,
                status: thread.status,
                calls: 0,
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                models: [],
                unavailable: why,
            });
            if (fallbackReason === undefined)
                gaps.push(`${thread.title}: ${why}`);
            continue;
        }
        rows.push({
            threadId: thread.threadId,
            title: thread.title,
            status: thread.status,
            calls: raw.calls,
            inputTokens: raw.inputTokens,
            outputTokens: raw.outputTokens,
            cacheReadTokens: raw.cacheReadTokens,
            cacheWriteTokens: raw.cacheWriteTokens,
            models: [...raw.models],
            ...(raw.pressureTokens === undefined ? {} : { pressureTokens: raw.pressureTokens }),
            ...(raw.unavailable === undefined ? {} : { unavailable: raw.unavailable }),
        });
        if (raw.unavailable !== undefined)
            gaps.push(`${thread.title}: ${raw.unavailable}`);
        for (const model of raw.models)
            addModelUsage(byModel, model);
        totals.calls += raw.calls;
        totals.inputTokens += raw.inputTokens;
        totals.outputTokens += raw.outputTokens;
        totals.cacheReadTokens += raw.cacheReadTokens;
        totals.cacheWriteTokens += raw.cacheWriteTokens;
    }
    return {
        available: gaps.length === 0,
        ...(gaps.length === 0 ? {} : { unavailable: gaps.join('; ') }),
        threads: rows.sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)),
        totals,
        byModel: [...byModel.values()].sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)),
        observedAt,
    };
}
/** Compacts token counts for a panel: 12_345 → `12.3k`. */
export function formatTokens(value) {
    if (!Number.isFinite(value) || value <= 0)
        return '0';
    if (value < 1_000)
        return String(Math.round(value));
    if (value < 1_000_000)
        return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
    return `${(value / 1_000_000).toFixed(1)}M`;
}
/**
 * Renders the usage panel.
 *
 * The unavailable notice leads when present: a table of zeros followed by a footnote gets read as
 * "free", and the reader has to notice the footnote to learn otherwise.
 */
export function renderUsageMarkdown(usage) {
    const lines = ['## Usage'];
    if (usage.unavailable !== undefined) {
        lines.push(`- not reported: ${usage.unavailable}`);
    }
    if (usage.totals.calls === 0 && usage.unavailable !== undefined) {
        lines.push('');
        lines.push('No thread in this project has reported token use, so there is nothing to break down.');
        return lines.join('\n');
    }
    lines.push(`- total: ${formatTokens(usage.totals.inputTokens)} in / ${formatTokens(usage.totals.outputTokens)} out across ${usage.totals.calls} call(s)`);
    if (usage.totals.cacheReadTokens > 0) {
        lines.push(`- cache: ${formatTokens(usage.totals.cacheReadTokens)} read / ${formatTokens(usage.totals.cacheWriteTokens)} written`);
    }
    lines.push('');
    for (const thread of usage.threads) {
        if (thread.unavailable !== undefined) {
            lines.push(`- **${thread.title}** (${thread.status}): usage unavailable — ${thread.unavailable}`);
            continue;
        }
        const parts = [`${formatTokens(thread.inputTokens)} in`, `${formatTokens(thread.outputTokens)} out`];
        if (thread.cacheReadTokens > 0)
            parts.push(`${formatTokens(thread.cacheReadTokens)} cached`);
        if (thread.pressureTokens !== undefined)
            parts.push(`${formatTokens(thread.pressureTokens)} in context`);
        lines.push(`- **${thread.title}** (${thread.status}): ${parts.join(' / ')} over ${thread.calls} call(s)`);
    }
    if (usage.byModel.length > 0) {
        lines.push('');
        lines.push('By model:');
        for (const model of usage.byModel) {
            lines.push(`- ${model.provider}/${model.model}: ${formatTokens(model.inputTokens)} in / ${formatTokens(model.outputTokens)} out`);
        }
    }
    return lines.join('\n');
}
