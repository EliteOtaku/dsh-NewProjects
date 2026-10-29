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

import type { OverviewBucket, ProjectOverview } from '../types.js';

/** Session event type carrying the latest project snapshot. */
export const PROJECT_STATE_EVENT = 'project-beta/state';

/** Projection key registered with the Host. */
export const PROJECT_STATE_KEY = 'projectBeta';

/** How many threads per bucket a snapshot carries. */
export const MAX_THREADS_PER_BUCKET = 20;

/** One thread, reduced to what a panel row shows. */
export interface ProjectStateThread {
  threadId: string;
  title: string;
  status: string;
  /** Pull request URL or other deliverable reference, when there is one. */
  pr?: string;
  /** Why the thread is where it is: the pending question, the error, the closing note. */
  note?: string;
}

/**
 * One immutable view of a project at a moment in time.
 *
 * Deliberately smaller than `ProjectOverview`: this object is copied into session storage on
 * every state change, and a panel row needs a title and a status, not the whole descriptor.
 */
export interface ProjectStateSnapshot {
  projectId: string;
  name: string;
  /** Manifest revision the snapshot was built from; lets a reader spot a stale view. */
  revision: number;
  /** Wall-clock time of the build, for "as of" rendering. */
  at: number;
  totals: ProjectOverview['totals'];
  buckets: Record<OverviewBucket, ProjectStateThread[]>;
  /** Threads per bucket that did not fit in the snapshot. */
  truncated: number;
  quota: { day: string; used: number; max: number; globalUsed?: number; globalMax?: number };
  suggested?: { count: number; expired: boolean };
  /** Present only while the project is paused. */
  paused?: { since: number; reason?: string };
  knowledge?: { docs: number; summary: string };
  warnings: string[];
}

/** Fold state stored per session. */
export interface ProjectStateFold {
  /** Latest snapshot, or `null` before the project's first write. */
  snapshot: ProjectStateSnapshot | null;
}

/** The empty fold: a session that has never driven a project. */
export function emptyProjectState(): ProjectStateFold {
  return { snapshot: null };
}

/** Reduce one overdue list to the row shape the panel renders. */
function toThreadRow(thread: ProjectOverview['buckets'][OverviewBucket][number]): ProjectStateThread {
  const row: ProjectStateThread = {
    threadId: thread.threadId,
    title: thread.title,
    status: thread.status,
  };
  if (thread.prOrDeliverableRef !== undefined) row.pr = thread.prOrDeliverableRef;
  const note = thread.feedbackPrompt ?? thread.lastError ?? thread.note;
  if (note !== undefined) row.note = note;
  return row;
}

/**
 * Build the snapshot for one overview.
 *
 * Truncation is reported rather than silent: a panel showing "19 threads" when there are 200
 * is worse than one that says 19 of 200.
 */
export function buildProjectState(
  overview: ProjectOverview,
  at: number,
  extra: { knowledge?: { docs: number; summary: string } } = {},
): ProjectStateSnapshot {
  const buckets = {} as Record<OverviewBucket, ProjectStateThread[]>;
  let truncated = 0;
  for (const [bucket, threads] of Object.entries(overview.buckets) as Array<
    [OverviewBucket, ProjectOverview['buckets'][OverviewBucket]]
  >) {
    const shown = threads.slice(0, MAX_THREADS_PER_BUCKET).map(toThreadRow);
    truncated += Math.max(0, threads.length - shown.length);
    buckets[bucket] = shown;
  }

  const snapshot: ProjectStateSnapshot = {
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
  if (overview.paused !== undefined) snapshot.paused = overview.paused;
  if (extra.knowledge !== undefined) snapshot.knowledge = extra.knowledge;
  return snapshot;
}

/** The event payload we append. */
export interface ProjectStateEvent {
  type: typeof PROJECT_STATE_EVENT;
  data: { snapshot: ProjectStateSnapshot };
}

/**
 * Fold one session event into the projection state.
 *
 * Returns the *same* object when the event is not ours: reducers run for every event in the
 * session, so allocating on each one would churn the cache the Host keeps around them.
 */
export function applyProjectState(state: ProjectStateFold, event: { type: string; data?: unknown }): ProjectStateFold {
  if (event.type !== PROJECT_STATE_EVENT) return state;
  const payload = event.data as { snapshot?: unknown } | undefined;
  const snapshot = payload?.snapshot as ProjectStateSnapshot | undefined;
  if (snapshot === undefined || snapshot === null || typeof snapshot !== 'object') return state;
  return { snapshot };
}
