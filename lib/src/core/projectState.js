/**
 * The project's state as it travels through a session's event stream.
 *
 * The overview panel is not a poller: it is a fold over events. So the projection needs
 * something durable to fold, and the manifest — which lives in a file — is not visible to a
 * reducer (reducers must be pure and cannot read the disk). This module defines the one
 * event type we append, the snapshot it carries, and the pure fold that rebuilds the view.
 *
 * Two rules keep this honest:
 *
 *   - `buildProjectState` is the only producer. It is called after a write, never during a
 *     render, so a panel that is never opened costs nothing.
 *   - `applyProjectState` is pure and total: same event sequence in, same state out, and an
 *     event we did not write is ignored rather than guessed at.
 */
/** Session event type carrying the latest project snapshot. */
export const PROJECT_STATE_EVENT = 'project-beta/state';
/** Projection key registered with the Host. */
export const PROJECT_STATE_KEY = 'projectBeta';
/** How many threads per bucket a snapshot carries. */
export const MAX_THREADS_PER_BUCKET = 20;
/** The empty fold: a session that has never driven a project. */
export function emptyProjectState() {
    return { snapshot: null };
}
/** Reduce one overdue list to the row shape the panel renders. */
function toThreadRow(thread) {
    const row = {
        threadId: thread.threadId,
        title: thread.title,
        status: thread.status,
    };
    if (thread.prOrDeliverableRef !== undefined)
        row.pr = thread.prOrDeliverableRef;
    const note = thread.feedbackPrompt ?? thread.lastError ?? thread.note;
    if (note !== undefined)
        row.note = note;
    return row;
}
/**
 * Build the snapshot for one overview.
 *
 * Truncation is reported rather than silent: a panel showing "19 threads" when there are 200
 * is worse than one that says 19 of 200.
 */
export function buildProjectState(overview, at, extra = {}) {
    const buckets = {};
    let truncated = 0;
    for (const [bucket, threads] of Object.entries(overview.buckets)) {
        const shown = threads.slice(0, MAX_THREADS_PER_BUCKET).map(toThreadRow);
        truncated += Math.max(0, threads.length - shown.length);
        buckets[bucket] = shown;
    }
    const snapshot = {
        projectId: overview.projectId,
        name: overview.name,
        revision: overview.revision,
        at,
        totals: overview.totals,
        buckets,
        truncated,
        quota: {
            day: overview.quota.day,
            used: overview.quota.created,
            max: overview.quota.max,
            ...(overview.quota.global === undefined
                ? {}
                : { globalUsed: overview.quota.global.created, globalMax: overview.quota.global.max }),
        },
        warnings: overview.warnings,
    };
    if (overview.suggested !== undefined) {
        snapshot.suggested = { count: overview.suggested.tasks.length, expired: overview.suggested.expired };
    }
    if (overview.paused !== undefined)
        snapshot.paused = overview.paused;
    if (overview.archived !== undefined)
        snapshot.archived = overview.archived;
    if (extra.knowledge !== undefined)
        snapshot.knowledge = extra.knowledge;
    return snapshot;
}
/**
 * Fold one session event into the projection state.
 *
 * Returns the *same* object when the event is not ours: reducers run for every event in the
 * session, so allocating on each one would churn the cache the Host keeps around them.
 */
export function applyProjectState(state, event) {
    if (event.type !== PROJECT_STATE_EVENT)
        return state;
    const payload = event.data;
    const snapshot = payload?.snapshot;
    if (snapshot === undefined || snapshot === null || typeof snapshot !== 'object')
        return state;
    return { snapshot };
}
