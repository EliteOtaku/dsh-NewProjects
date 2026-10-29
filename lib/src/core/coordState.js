/**
 * Coordination state that outlives a single conversation.
 *
 * The official coordinator does not keep its full history: it "works from recent messages,
 * recent threads, and project memory". Threads and memory we already persist; this module adds
 * the third piece — the last few coordinator messages — plus the one-line project goal.
 *
 * Both live in the manifest, so any session that opens the project can reconstruct "what is
 * being worked toward, what was just decided, and what is still in flight" without asking the
 * user to repeat themselves.
 */
/**
 * How many coordinator messages survive.
 *
 * A ring buffer, not a log: the point is to answer "what were we just doing", and a longer
 * tail only costs tokens in every overview without making that answer better. The official
 * behaviour is the same shape — "recent messages", not history.
 */
export const RECENT_MESSAGE_LIMIT = 20;
/** Per-message cap. One long paste should not crowd out the other nineteen. */
export const MAX_RECENT_MESSAGE_CHARS = 400;
/** Longest accepted goal, matching the official "one line of what you're trying to get done". */
export const MAX_GOAL_CHARS = 280;
/** Trim a goal to one line and the documented budget; empty means "no goal". */
export function normaliseGoal(raw) {
    if (raw === undefined)
        return undefined;
    const oneLine = raw.replace(/\s+/g, ' ').trim();
    if (oneLine.length === 0)
        return undefined;
    return oneLine.slice(0, MAX_GOAL_CHARS);
}
/**
 * Append one message to the ring.
 *
 * Returns a new array so callers can drop it straight into a manifest draft without aliasing
 * the previous snapshot — the store serialises writes, and a shared array would make two
 * concurrent mutators silently overwrite each other's tail.
 */
export function appendRecent(existing, message) {
    const text = message.text.replace(/\s+/g, ' ').trim().slice(0, MAX_RECENT_MESSAGE_CHARS);
    if (text.length === 0)
        return [...(existing ?? [])];
    const next = [...(existing ?? []), { at: message.at, role: message.role, text }];
    return next.slice(Math.max(0, next.length - RECENT_MESSAGE_LIMIT));
}
/** Most recent first is what a reader wants; the stored order stays chronological. */
export function newestFirst(messages) {
    return [...(messages ?? [])].reverse();
}
/** Render the goal block for the charter; absent goal renders nothing at all. */
export function renderGoalSection(goal) {
    // Normalised, not just length-checked: a goal stored as spaces would otherwise emit a heading
    // with a blank body, and the panel would report a goal the project cannot state.
    const oneLine = normaliseGoal(goal);
    if (oneLine === undefined)
        return '';
    return ['## Project goal', '', oneLine].join('\n');
}
/** One-line summary for the panel, or `undefined` when the project has no goal. */
export function describeGoal(manifest) {
    return normaliseGoal(manifest.goal);
}
/**
 * Render recent coordinator messages as a markdown section.
 *
 * Deliberately **not** part of the shared charter: the charter is the byte-identical prefix
 * every thread and the coordinator share, and messages change constantly. Putting them there
 * would invalidate the prompt cache on every turn and hand threads context they never asked
 * for. The coordinator reads this through the overview / `/project log` instead.
 */
export function renderRecentMessages(messages, limit = 5) {
    const recent = newestFirst(messages).slice(0, limit);
    if (recent.length === 0)
        return '';
    const lines = ['## Recent coordinator messages', ''];
    for (const message of recent) {
        lines.push(`- \`${new Date(message.at).toISOString()}\` **${message.role}**: ${message.text}`);
    }
    return lines.join('\n');
}
