/**
 * How many threads one round may start.
 *
 * The official spec is explicit that there is no fixed concurrency number and that a limit a
 * user asks for is "a preference rather than a cap": Claude starts as many threads as the work
 * calls for, and later honours what the user asked for. This module is the local reading of
 * that sentence.
 *
 * Why we do anything at all: the cloud's marginal cost of one more thread is tokens, while ours
 * is tokens **plus** a disk checkout, a host process and CPU on the same machine. So the number
 * matters here more than it does upstream, and it should be expressible once instead of being
 * repeated in every `coordinate` call.
 *
 * Why it is not a hard gate: a preference that can refuse the work a user explicitly asked for
 * is a cap, and the spec says it is not one. `roundBudget` therefore never returns zero.
 */

import { ProjectError } from './errors.js';
import { isActiveStatus } from './overview.js';
import type { ConcurrencyDecision, ProjectManifest, ProjectThreadDescriptor } from '../types.js';

/**
 * Largest preference we accept.
 *
 * Not a policy about how many threads are wise — a day's quota is 200 new threads, so a
 * preference above that can never be reached and is almost certainly a typo.
 */
export const CONCURRENCY_CEILING = 200;

/** Smallest preference we accept: a preference of zero would stop all work. */
export const CONCURRENCY_MIN = 1;

/** Validate a user-supplied concurrency preference. */
export function normaliseConcurrencyPreference(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ProjectError('INVALID_INPUT', `a concurrency preference must be a whole number, got ${String(value)}`);
  }
  if (value < CONCURRENCY_MIN) {
    throw new ProjectError(
      'INVALID_INPUT',
      `a concurrency preference must be at least ${CONCURRENCY_MIN}; use \`/project concurrent off\` to remove it`,
    );
  }
  if (value > CONCURRENCY_CEILING) {
    throw new ProjectError(
      'INVALID_INPUT',
      `a concurrency preference of ${value} is above the daily thread quota (${CONCURRENCY_CEILING}); no project can reach it`,
    );
  }
  return value;
}

/** Threads still owned by us — the ones a new round would be running alongside. */
export function activeThreadCount(threads: Iterable<ProjectThreadDescriptor>): number {
  let count = 0;
  for (const thread of threads) if (isActiveStatus(thread.status)) count += 1;
  return count;
}

/** The preference in force on a manifest, if any. */
export function concurrencyPreference(manifest: ProjectManifest): number | undefined {
  return manifest.maxConcurrentThreads;
}

/** Inputs to {@link roundBudget}. */
export interface RoundBudgetInput {
  /** `manifest.maxConcurrentThreads`, when set. */
  preference: number | undefined;
  /** Threads already active when the round begins. */
  active: number;
  /** How many tasks the round was asked to start. */
  planned: number;
  /** A per-call `limit`, which may only make the round smaller. */
  requested?: number;
}

/** What one round is allowed to do. */
export interface RoundBudget {
  /** Tasks this round may start. Never zero for a non-empty round. */
  allowed: number;
  /** Tasks held back for the next round. */
  deferred: number;
  /** Present only when a preference is set; goes into the result verbatim. */
  decision?: ConcurrencyDecision;
}

/**
 * Decide this round's starting budget.
 *
 * `requested` can only lower the number: a per-call limit is a narrowing instruction, while the
 * preference is what the user asked to be remembered. A larger explicit limit is nearly always
 * the coordinating model echoing "start them all" rather than a human overriding their own
 * setting, and honouring it would make the preference meaningless.
 */
export function roundBudget(input: RoundBudgetInput): RoundBudget {
  const planned = Math.max(0, Math.floor(input.planned));
  // A round that was asked for tasks always starts at least one: `limit: 0` is a nonsense
  // request, and the previous behaviour clamped it the same way.
  const narrowed =
    planned === 0 ? 0 : Math.max(1, Math.min(planned, Math.floor(input.requested ?? planned)));
  const preference = input.preference;
  if (preference === undefined) {
    return { allowed: narrowed, deferred: planned - narrowed };
  }

  const active = Math.max(0, Math.floor(input.active));
  // Never zero: see the module comment. One thread at a time is the smallest thing that is
  // still "work happening", and refusing everything would be a cap.
  const free = Math.max(1, preference - active);
  const allowed = Math.max(0, Math.min(narrowed, free));
  const deferred = planned - allowed;

  const decision: ConcurrencyDecision = { preference, active, allowed };
  if (allowed < planned) {
    decision.note =
      free === 1 && preference - active < 1
        ? `your concurrency preference is ${preference} and ${active} thread(s) are already active, ` +
          'so this round started one anyway — it is a preference, not a cap. Raise it with ' +
          '`/project concurrent <n>` if you want more at once.'
        : `your concurrency preference is ${preference} and ${active} thread(s) are already active, ` +
          `so ${allowed} of ${planned} started this round; run \`coordinate\` again for the rest, ` +
          'or raise the preference with `/project concurrent <n>`.';
  }
  return { allowed, deferred, decision };
}
