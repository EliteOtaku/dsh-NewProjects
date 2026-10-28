/**
 * Coordinator decomposition.
 *
 * Two paths, in this order:
 *
 * 1. **The model's own plan.** The caller (the coordinating model) states the split and it
 *    is used as-is after validation. A coordinator that decides what becomes a thread is
 *    the whole point of the feature; a regex re-splitting a decided plan is strictly worse.
 * 2. **Deterministic text analysis (this file's `planTasks`).** A fallback, not the main
 *    path: it keeps coordination working when no model plan arrives, keeps the policy
 *    unit-testable, and never invents work the user did not ask for.
 *
 * The fallback is a *guess*, so callers must treat its output as a proposal rather than a
 * decision — see `PlanOrigin` in `../types.js`.
 *
 * When the goal already contains explicit parallel markers (`-`, `1.`, `a)`), the
 * fallback lifts those as task titles. Otherwise it emits a single task — splitting an
 * unmarked goal would fabricate structure.
 */

import type { PlannedTask } from '../types.js';

/** Hard cap on threads spawned from one coordination call. */
export const MAX_PLANNED_TASKS = 8;

/**
 * How long a proposed decomposition waits for a go-ahead.
 *
 * A plan is written against the tree as it stands. After a day the branches it names may no
 * longer apply, and a stale plan that still starts cleanly is worse than no plan at all — it
 * produces threads working on work that already happened.
 */
export const PLAN_TTL_MS = 24 * 60 * 60 * 1000;

/** Markers that mean "these lines are separate work items". */
const BULLET = /^\s*(?:[-*+]|\d+[.)]|[a-z][.)])\s+(.*\S)\s*$/i;
/** A scope hint: backticked path or a trailing "in <path>" clause. */
const BACKTICK_PATH = /`([^`\s]+\/[^`\s]*)`/;
const IN_PATH = /\bin\s+((?:[\w.@-]+\/)+[\w.@-]*)/i;

/** Strip a `Title: body` prefix when the author used one. */
function splitTitle(line: string): { title: string; body: string } {
  const match = /^(.*?)[:—–-]\s+(.+)$/.exec(line);
  if (match === null) return { title: line, body: line };
  const title = (match[1] ?? '').trim();
  const body = (match[2] ?? '').trim();
  if (title.length < 3 || title.length > 80) return { title: line, body: line };
  return { title, body };
}

/** Keep only a filesystem-looking path from a candidate scope hint. */
function normaliseScopeHint(candidate: string | undefined): string | undefined {
  if (candidate === undefined) return undefined;
  const trimmed = candidate.trim().replace(/^["'`]|["'`]$/g, '').replace(/\/+$/, '');
  if (trimmed.length === 0) return undefined;
  if (/^[a-z]+:\/\//i.test(trimmed)) return undefined;
  if (!/[\\/]/.test(trimmed) && !/\.[a-z0-9]+$/i.test(trimmed)) return undefined;
  return trimmed;
}

/** Extract a scope hint from one task line, if it names a path. */
function scopeHintOf(text: string): string | undefined {
  const backtick = BACKTICK_PATH.exec(text);
  if (backtick?.[1] !== undefined) return normaliseScopeHint(backtick[1]);
  const inPath = IN_PATH.exec(text);
  if (inPath?.[1] !== undefined) return normaliseScopeHint(inPath[1]);
  return undefined;
}

/** Bound and de-duplicate the plan, preserving authoring order. */
function finalise(tasks: PlannedTask[]): PlannedTask[] {
  const seen = new Set<string>();
  const out: PlannedTask[] = [];
  for (const task of tasks) {
    const objective = task.objective.trim();
    if (objective.length === 0) continue;
    const key = `${task.title}\u0000${objective}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...task, title: task.title.trim(), objective });
    if (out.length >= MAX_PLANNED_TASKS) break;
  }
  return out;
}

/**
 * Validate and bound a plan the calling model authored.
 *
 * Untrusted input: the tasks arrive as tool arguments, so anything may be missing, empty,
 * over-long or duplicated. Each task needs a title; a missing objective falls back to the
 * title rather than dropping the task, because dropping silently loses work the model asked
 * for, while an over-long objective is truncated by the thread prompt budget anyway.
 *
 * @returns the accepted tasks; empty means the caller supplied nothing usable.
 */
export function normaliseTasks(raw: unknown): PlannedTask[] {
  if (!Array.isArray(raw)) return [];
  const candidates: PlannedTask[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const title = typeof record['title'] === 'string' ? record['title'].trim() : '';
    const objective = typeof record['objective'] === 'string' ? record['objective'].trim() : '';
    if (title.length === 0 && objective.length === 0) continue;
    const resolvedTitle = title.length > 0 ? title : objective.slice(0, 80);
    const scopeHint = typeof record['scopeHint'] === 'string' ? normaliseScopeHint(record['scopeHint']) : undefined;
    candidates.push({
      title: resolvedTitle.slice(0, 80),
      // A bare title is a complete instruction; inventing a longer objective would be worse.
      objective: objective.length > 0 ? objective : resolvedTitle,
      ...(scopeHint === undefined ? {} : { scopeHint }),
    });
  }
  return finalise(candidates);
}

/**
 * Decompose one goal into parallel tasks.
 *
 * @param goal - the user's high-level objective, possibly with a marked-up list.
 * @param fallbackTitle - title used when the goal is a single unmarked statement.
 */
export function planTasks(goal: string, fallbackTitle?: string): PlannedTask[] {
  const text = goal.trim();
  if (text.length === 0) return [];
  const lines = text.split(/\r?\n/);
  const bullets: string[] = [];
  let inFence = false;
  for (const line of lines) {
    // Fenced code carries `-` lines that are shell flags or YAML keys, not work items.
    // Reading them as tasks is how a goal ends up with a thread called "not a task".
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = BULLET.exec(line);
    if (match?.[1] !== undefined) bullets.push(match[1]);
  }

  if (bullets.length < 2) {
    const { title } = splitTitle(text.replace(/\s+/g, ' '));
    const scopeHint = scopeHintOf(text);
    return finalise([
      {
        title: (fallbackTitle ?? title).slice(0, 80),
        objective: text,
        ...(scopeHint === undefined ? {} : { scopeHint }),
      },
    ]);
  }

  return finalise(
    bullets.map((bullet) => {
      const { title, body } = splitTitle(bullet);
      const scopeHint = scopeHintOf(bullet);
      return {
        title: title.slice(0, 80),
        objective: body,
        ...(scopeHint === undefined ? {} : { scopeHint }),
      };
    }),
  );
}

/**
 * Derive a git-branch-safe name for one planned task.
 *
 * Deterministic from the task title, so a re-planned identical task lands on the same
 * branch name instead of leaking a second branch per attempt. The ordinal is part of the
 * name because sibling tasks legitimately share titles in practice (`- add tests` beside
 * `- add tests`, or two tasks whose titles both truncate to the same slug); without it the
 * second `git branch` would find the first branch already exists and silently reuse it,
 * putting two threads on one branch — the exact isolation failure this module exists to
 * prevent.
 */
export function branchNameFor(projectSlug: string, task: PlannedTask, ordinal: number): string {
  const slug = task.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // Keep the whole ref under ~80 characters, which is what keeps
  // `git log --oneline --decorate` readable in a narrow terminal. Budget the title slug
  // from the fixed pieces: "project/" (8) + slug + "/" + ordinal + "-" + slug.
  const fixed = 'project/'.length + projectSlug.length + 1 + String(ordinal + 1).length + 1;
  const budget = Math.max(8, 80 - fixed);
  const suffix = slug.length > 0 ? slug.slice(0, budget).replace(/-+$/, '') : 'task';
  return `project/${projectSlug}/${ordinal + 1}-${suffix}`;
}
