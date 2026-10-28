/**
 * Overview projection.
 *
 * Folds the durable project record into the four buckets the panel shows. Kept as a
 * pure function of the manifest so the panel, the tool result, and any test always
 * agree — there is no second source of truth for "which bucket is this thread in".
 */

import { memoryPrefixFingerprint } from './memory.js';
import { PLAN_TTL_MS } from './planner.js';
import { quotaState } from './quota.js';
import type {
  OverviewBucket,
  ProjectManifest,
  ProjectOverview,
  ProjectThreadDescriptor,
  ThreadStatus,
} from '../types.js';

/**
 * The display order of buckets on the panel, matching the official Threads tab:
 * Ready for review / Waiting on you / Working / Landing / Idle / Resolved.
 */
export const BUCKET_ORDER: readonly OverviewBucket[] = [
  'ready_for_review',
  'waiting_on_you',
  'working',
  'landing',
  'idle',
  'resolved',
];

/** Bucket titles used by the panel and the tool renderer. */
export const BUCKET_LABELS: Record<OverviewBucket, string> = {
  ready_for_review: 'Ready for review',
  waiting_on_you: 'Waiting on you',
  working: 'Working',
  landing: 'Landing',
  idle: 'Idle',
  resolved: 'Resolved',
};

/** Statuses that count as "still working" (keeps the thread alive in the panel). */
const ACTIVE_STATUSES: readonly ThreadStatus[] = ['queued', 'running', 'ci_fixing'];

/**
 * Map one thread status onto its panel bucket.
 *
 * Written as an ordered decision rather than a flat lookup, because two of the official
 * definitions can be true of the same thread and the panel has to break the tie:
 *
 *   1. human-blocking (`needs_feedback`, `failed`) — the user must act, so the panel's
 *      attention dot must light up. The official `Waiting on you` definition explicitly
 *      includes "or that failed", and the dot is defined as "shows a dot when a thread is
 *      waiting on you". A thread stuck on an approval inside its thread can also have a PR
 *      open; if it were filed under `Ready for review` nothing would point at the thing
 *      that is actually stuck, and in-thread approvals cannot be answered from the project
 *      conversation.
 *   2. PR lifecycle (`landing` > `ready_for_review`).
 *   3. running work.
 *   4. terminal states (`idle` > `resolved`).
 *
 * The `landing` > `ready_for_review` tie (one reviewer approved, another has not) is our
 * call, not the official text: the thread has left our hands either way.
 */
export function bucketOf(status: ThreadStatus): OverviewBucket {
  switch (status) {
    // 1. Human-blocking first.
    case 'needs_feedback':
    case 'failed':
      return 'waiting_on_you';
    // 2. PR lifecycle.
    case 'landing':
      return 'landing';
    case 'awaiting_review':
      return 'ready_for_review';
    // 3. Work in flight.
    case 'queued':
    case 'running':
    case 'ci_fixing':
      return 'working';
    // 4. Terminal states.
    case 'completed':
      return 'idle';
    case 'resolved':
      return 'resolved';
  }
}

/** Whether a status means the thread still owns live work. */
export function isActiveStatus(status: ThreadStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

/**
 * A week without a single recorded event, after which a thread is marked done.
 *
 * Every turn counts as activity, and so does a PR event (a failing check or a new comment
 * wakes the thread for a turn). So no special case is needed for "PR still open": a pull
 * request nobody has touched for a week is exactly what this is for.
 */
export const RESOLVE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** Whether this thread has been silent long enough to be resolved automatically. */
export function dueForResolve(thread: ProjectThreadDescriptor, nowMs: number): boolean {
  if (thread.status === 'resolved') return false;
  return nowMs - thread.updatedAt >= RESOLVE_AFTER_MS;
}

/** Sort threads newest-first within a bucket, so the panel shows recent work. */
function byRecency(a: ProjectThreadDescriptor, b: ProjectThreadDescriptor): number {
  return b.updatedAt - a.updatedAt;
}

/** Build the structured overview for one project. */
export function buildOverview(
  manifest: ProjectManifest,
  nowMs: number,
  warnings: string[] = [],
  options: { includeResolved?: boolean } = {},
): ProjectOverview {
  const buckets: Record<OverviewBucket, ProjectThreadDescriptor[]> = {
    ready_for_review: [],
    waiting_on_you: [],
    working: [],
    landing: [],
    idle: [],
    resolved: [],
  };
  const all = Object.values(manifest.threads);
  // Resolved threads stay in the manifest — they are the record of what happened — but a
  // panel that lists every thread ever finished is a log, not an overview. `/project threads
  // --all` and the `includeResolved` option are the way back to the full list.
  const threads = options.includeResolved === true ? all : all.filter((thread) => thread.status !== 'resolved');
  for (const thread of threads) buckets[bucketOf(thread.status)].push(thread);
  for (const bucket of BUCKET_ORDER) buckets[bucket].sort(byRecency);

  return {
    projectId: manifest.projectId,
    name: manifest.name,
    rootDir: manifest.rootDir,
    revision: manifest.revision,
    quota: quotaState(manifest, nowMs),
    buckets,
    memories: Object.values(manifest.memories).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    prefixFingerprint: memoryPrefixFingerprint(manifest),
    // An expired plan is still reported: dropping it is a write, and the panel is a reader.
    // It is marked stale so the panel cannot offer threads that will refuse to start.
    ...(manifest.plan === undefined
      ? {}
      : {
          suggested: {
            plannedAt: manifest.plan.plannedAt,
            origin: manifest.plan.origin,
            ...(manifest.plan.note === undefined ? {} : { note: manifest.plan.note }),
            expired: nowMs - manifest.plan.plannedAt > PLAN_TTL_MS,
            tasks: manifest.plan.tasks,
          },
        }),
    totals: {
      threads: threads.length,
      active: threads.filter((thread) => isActiveStatus(thread.status)).length,
      waitingOnYou: buckets.waiting_on_you.length,
      // Counted over every thread, including the ones the panel is hiding: the number is
      // what `/project threads` reports as hidden, so it must match the store, not the view.
      resolved: all.filter((thread) => thread.status === 'resolved').length,
      needsAttention: buckets.waiting_on_you.length > 0,
    },
    warnings,
  };
}

/**
 * Render the overview as compact markdown for the `/project` command.
 *
 * The command bypasses the model, so this string is what the user actually reads.
 */
export function renderOverviewMarkdown(overview: ProjectOverview): string {
  const lines: string[] = [];
  lines.push(`# ${overview.name}`, '');
  lines.push(`- project: \`${overview.projectId}\` (r${overview.revision})`);
  lines.push(`- root: \`${overview.rootDir}\``);
  lines.push(`- quota: ${overview.quota.created}/${overview.quota.max} threads from this project on ${overview.quota.day}`);
  if (overview.quota.global !== undefined) {
    lines.push(`- quota (enforced, all projects): ${overview.quota.global.created}/${overview.quota.global.max}`);
  }
  lines.push(`- memory: ${overview.memories.length} decisions, prefix \`${overview.prefixFingerprint}\``);
  lines.push(
    `- threads: ${overview.totals.threads} shown, ${overview.totals.active} active, ` +
      `${overview.totals.waitingOnYou} waiting on you`,
  );
  if (overview.totals.resolved > 0) {
    const hidden = overview.totals.resolved - overview.buckets.resolved.length;
    if (hidden > 0) lines.push(`- resolved: ${overview.totals.resolved} (${hidden} hidden; \`/project threads --all\`)`);
  }
  for (const warning of overview.warnings) lines.push(`- WARNING: ${warning}`);
  const suggested = overview.suggested;
  if (suggested !== undefined) {
    lines.push(`- suggested: ${suggested.tasks.length} waiting for a go-ahead (${suggested.origin} plan)`);
  }
  lines.push('');

  if (suggested !== undefined) {
    lines.push(suggested.expired ? '## Suggested threads (stale, dropped on next run)' : '## Suggested threads (not started)', '');
    if (suggested.note !== undefined) lines.push(`> ${suggested.note}`, '');
    for (const [ordinal, task] of suggested.tasks.entries()) {
      lines.push(`${ordinal + 1}. **${task.title}** — ${task.objective}`);
    }
    lines.push('');
    lines.push(
      suggested.expired
        ? '_Older than a day: run `coordinate` again to re-propose._'
        : '_Start all with `/project start`, some with `/project start 1 3`, or discard with `/project drop`._',
      '',
    );
  }

  let empty = true;
  for (const bucket of BUCKET_ORDER) {
    const threads = overview.buckets[bucket];
    if (threads.length === 0) continue;
    empty = false;
    lines.push(`## ${BUCKET_LABELS[bucket]} (${threads.length})`, '');
    for (const thread of threads) {
      const bits = [`\`${thread.threadId}\``, thread.title, `— ${thread.status}`];
      if (thread.branch !== undefined) bits.push(`on \`${thread.branch}\``);
      else if (thread.branchOrScope.length > 0) bits.push(`scope \`${thread.branchOrScope}\``);
      if (thread.prOrDeliverableRef !== undefined) bits.push(`(${thread.prOrDeliverableRef})`);
      lines.push(`- ${bits.join(' ')}`);
      if (thread.feedbackPrompt !== undefined) lines.push(`  - needs: ${thread.feedbackPrompt}`);
      if (thread.lastError !== undefined) lines.push(`  - error: ${thread.lastError}`);
      const failing = thread.review?.checks.filter((check) => check.conclusion === 'fail') ?? [];
      if (failing.length > 0) lines.push(`  - failing checks: ${failing.map((check) => check.name).join(', ')}`);
    }
    lines.push('');
  }
  if (empty) lines.push('_No threads yet. Use `project_coordinate` to start parallel work._', '');
  return lines.join('\n');
}

export { quotaState };
