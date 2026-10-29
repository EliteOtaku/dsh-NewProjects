/**
 * Reads token spend out of each thread's own session log.
 *
 * The numbers are the provider's: every `assistant/message` event carries the `usage` block the
 * API returned. Nothing here estimates spend — `tokenMeter` is consulted for context pressure
 * only, because an estimate displayed next to real billed tokens is indistinguishable to the
 * reader and therefore worse than no number at all.
 *
 * A session the Host no longer holds yields `undefined`, which the engine turns into a per-thread
 * "unavailable" line rather than a zero.
 */
/** Reads a number field off an unknown record, or returns 0. */
function num(source, key) {
    if (typeof source !== 'object' || source === null)
        return 0;
    const value = source[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
/** Reads a string field off an unknown record, or returns undefined. */
function str(source, key) {
    if (typeof source !== 'object' || source === null)
        return undefined;
    const value = source[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
/**
 * Pulls provider and model off an assistant message.
 *
 * Both live on `message.source`, which is the only place that records *which* route answered —
 * the request header changes over a thread's life, so reading the current route would attribute
 * every earlier call to whatever model is configured now.
 */
function routeOf(event) {
    const message = event.data?.message;
    const source = message?.source;
    const provider = str(source, 'provider');
    const model = str(source, 'model');
    if (provider === undefined || model === undefined)
        return undefined;
    return { provider, model };
}
/** Accumulates one session's assistant messages into a usage row. */
export function summariseSession(events) {
    let calls = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    const models = new Map();
    for (const event of events) {
        if (event.type !== 'assistant/message')
            continue;
        calls += 1;
        const usage = event.data?.usage;
        const input = num(usage, 'inputTokens');
        const output = num(usage, 'outputTokens');
        const cacheRead = num(usage, 'cacheReadTokens');
        const cacheWrite = num(usage, 'cacheWriteTokens');
        inputTokens += input;
        outputTokens += output;
        cacheReadTokens += cacheRead;
        cacheWriteTokens += cacheWrite;
        const route = routeOf(event);
        if (route === undefined)
            continue;
        const key = `${route.provider}/${route.model}`;
        const row = models.get(key) ?? { ...route, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
        row.calls += 1;
        row.inputTokens += input;
        row.outputTokens += output;
        row.cacheReadTokens += cacheRead;
        row.cacheWriteTokens += cacheWrite;
        models.set(key, row);
    }
    return {
        calls,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        models: [...models.values()],
    };
}
/**
 * Builds the port over the Host `sessions` service.
 *
 * `meter` is optional: without it the panel loses the "in context" column but keeps the spend
 * numbers, which are the part the official Usage tab reports.
 */
export function createUsagePort(sessions, meter) {
    return {
        async measure(childSessionId) {
            const session = sessions.get(childSessionId);
            if (session === undefined)
                return undefined;
            const row = summariseSession(session.ownEvents());
            if (meter === undefined)
                return row;
            try {
                const pressure = meter.measure(session).totalTokens;
                return pressure === undefined || !Number.isFinite(pressure) ? row : { ...row, pressureTokens: pressure };
            }
            catch {
                // Pressure is a nice-to-have; a meter that throws must not hide the spend numbers.
                return row;
            }
        },
    };
}
/**
 * Wraps a port that may not exist yet.
 *
 * `sessions` arrives after `apply`, and engines are created lazily per project root, so the port
 * cannot be built once at activation: it resolves on each measurement and degrades to "no session
 * log" until the service appears.
 */
export function createLazyUsagePort(resolve) {
    return {
        async measure(childSessionId) {
            const port = resolve();
            if (port === undefined)
                return undefined;
            return port.measure(childSessionId);
        },
    };
}
