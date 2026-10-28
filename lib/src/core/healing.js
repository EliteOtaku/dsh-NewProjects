/**
 * CI / review self-healing state machine.
 *
 * Pure decision logic: given a thread's last observed review snapshot and the newly
 * polled facts, decide what to do next. No IO happens here, which is what makes the
 * "does it heal or escalate?" question testable without a repository or a network.
 *
 * The policy is deliberately conservative:
 *
 * - Failing checks or unaddressed review comments -> heal (bounded retries).
 * - The same failure surviving several rounds in a row -> escalate to `needs_feedback`
 *   instead of guessing. A wrong autonomous fix is worse than a question.
 * - A request that needs a product decision -> escalate rather than invent an answer.
 * - Merged PR -> `completed`. Closed PR -> `failed`.
 *
 * The retry budget counts *consecutive rounds against the same failure signature*, not
 * rounds over the thread's lifetime. A pull request under review for two weeks collects
 * four rounds of genuinely new comments; a lifetime counter would have escalated on the
 * fourth and reported "repair failed three times" when no repair had ever failed twice.
 * The counter resets whenever the failure set changes or new review comments arrive,
 * because at that point the previous round did make progress.
 */
/** Consecutive rounds against an unchanged failure signature before escalating. */
export const MAX_HEAL_ATTEMPTS = 3;
/** Conclusion words that mean "this check failed". */
const FAIL_CONCLUSIONS = new Set(['failure', 'failed', 'fail', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'error']);
/** Conclusion words that mean "this check has not finished". */
const PENDING_CONCLUSIONS = new Set(['pending', 'queued', 'in_progress', 'waiting', 'requested', 'expected']);
/** Normalise one raw CI verb into a stable bucket word. */
export function normaliseConclusion(raw) {
    const value = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (FAIL_CONCLUSIONS.has(value))
        return 'fail';
    if (PENDING_CONCLUSIONS.has(value))
        return 'pending';
    if (value === 'neutral' || value === 'skipped')
        return 'skipped';
    if (value === 'success' || value === 'passed' || value === 'pass')
        return 'pass';
    // An unrecognised verb maps to `pending`, not to itself. Passing it through would make
    // the check invisible to both the failure filter and the pending filter, and a PR whose
    // only check is in a new GitHub spelling would then be reported as "all checks passed" —
    // a false green, which is the one outcome a self-healer must never produce.
    return 'pending';
}
/** Build a check list from `gh pr checks` rows. */
export function toCheckStates(rows) {
    // Duplicates are preserved rather than collapsed by name. `gh pr checks` reports the
    // checks that exist now, so two rows with one name mean two genuinely separate runs
    // (a re-run that has not replaced the original, or two matrix legs sharing a job name).
    // Collapsing them would let a fresh green mask a live red, which is exactly the
    // failure a self-healer must not have.
    return rows.map((row) => ({
        name: row.name,
        conclusion: normaliseConclusion(row.state),
        ...(row.link === undefined ? {} : { detailsUrl: row.link }),
    }));
}
/** Build a comment list from REST review comments. */
export function toReviewComments(rows) {
    const out = [];
    for (const row of rows) {
        const body = (row.body ?? '').trim();
        // An empty-bodied comment carries no instruction to act on. Keeping it would spend a
        // heal attempt asking the thread to address a blank, and the attempt budget is the
        // only thing standing between a loop and a working fix.
        if (body.length === 0)
            continue;
        const line = row.line ?? row.original_line ?? undefined;
        out.push({
            id: String(row.id),
            author: row.user?.login ?? 'unknown',
            body,
            ...(row.path === undefined ? {} : { path: row.path }),
            ...(line === undefined || line === null ? {} : { line }),
            createdAt: row.created_at === undefined ? 0 : Date.parse(row.created_at) || 0,
        });
    }
    return out;
}
/**
 * Stable identity of "which checks are failing right now".
 *
 * Consecutive-failure counting needs to tell "the thread failed to fix the build three
 * times" apart from "the build, then a lint rule, then a flaky test failed in turn". The
 * signature covers the failing names only, sorted, so a run that adds a new failing check
 * counts as a different problem — and so the same set reported in a different order does
 * not. Empty means nothing is failing, which is the reset signal.
 */
export function failureSignature(checks) {
    return checks
        .filter((check) => check.conclusion === 'fail')
        .map((check) => check.name)
        .sort()
        .join('|');
}
/** Render the healing prompt for one round from the observed failure evidence. */
export function buildHealPrompt(input, failures, comments, logExcerpt) {
    const blocks = [];
    blocks.push(`Your pull request ${input.prRef} (${input.threadTitle}) needs another pass before it can merge.`);
    blocks.push('');
    if (failures.length > 0) {
        blocks.push('## Failing CI checks');
        for (const check of failures) {
            const link = check.detailsUrl === undefined ? '' : ` — ${check.detailsUrl}`;
            blocks.push(`- ${check.name}: ${check.conclusion}${link}`);
        }
        blocks.push('');
    }
    if (comments.length > 0) {
        blocks.push('## Unaddressed review comments');
        for (const comment of comments) {
            const where = comment.path === undefined ? '' : ` at ${comment.path}${comment.line === undefined ? '' : `:${String(comment.line)}`}`;
            blocks.push(`- ${comment.author}${where}: ${comment.body}`);
        }
        blocks.push('');
    }
    if (logExcerpt !== undefined && logExcerpt.trim().length > 0) {
        blocks.push('## Failing log excerpt');
        blocks.push('```');
        blocks.push(logExcerpt.trim());
        blocks.push('```');
        blocks.push('');
    }
    blocks.push('## What to do');
    blocks.push('1. Reproduce the failure locally in your checkout; do not guess from the log text alone.');
    blocks.push('2. Fix the root cause. Do not weaken, skip, or delete the failing assertion to make it pass.');
    blocks.push('3. Re-run the affected tests and confirm they pass.');
    blocks.push(`4. Commit and push to your existing branch (${input.prRef} head). Do not open a second pull request: the review history on the same branch is what carries this change to merge.`);
    blocks.push('5. If the requested change contradicts a shared project memory entry or needs a product decision you cannot make, stop and say exactly what needs deciding — do not implement a guess.');
    return blocks.join('\n');
}
/**
 * Decide the next move for one thread.
 *
 * Order matters: a merged/closed PR settles the thread before any check noise is
 * considered, and a pending check outranks healing so we never "fix" a run that is
 * still going.
 */
export function decideHealAction(input) {
    if (input.prState === 'merged') {
        return { kind: 'transition', status: 'completed', reason: 'pull request merged' };
    }
    if (input.prState === 'closed') {
        return { kind: 'transition', status: 'failed', reason: 'pull request closed without merging' };
    }
    const failures = input.checks.filter((check) => check.conclusion === 'fail');
    const pending = input.checks.filter((check) => check.conclusion === 'pending');
    const consumed = new Set(input.consumedCommentIds);
    const fresh = input.comments.filter((comment) => !consumed.has(comment.id));
    if (failures.length === 0 && fresh.length === 0) {
        if (pending.length > 0) {
            return { kind: 'wait', reason: `${String(pending.length)} check(s) still running` };
        }
        if (input.checks.length === 0) {
            return { kind: 'none', reason: 'no checks reported yet' };
        }
        if (input.prState === 'draft') {
            return { kind: 'none', reason: 'pull request is still a draft; all checks passed' };
        }
        return { kind: 'none', reason: 'all checks passed; waiting for human review' };
    }
    // A pending check outranks healing even when something else has already failed: the
    // pending run may be the retry that supersedes the failure, and waking the thread now
    // spends one of only three attempts on a race that would have settled itself.
    if (pending.length > 0) {
        return {
            kind: 'wait',
            reason: `${String(pending.length)} check(s) still running; deferring the fix until they finish`,
        };
    }
    if (input.consecutiveFails >= MAX_HEAL_ATTEMPTS) {
        const parts = [];
        if (failures.length > 0)
            parts.push(`${String(failures.length)} check(s) still failing: ${failures.map((check) => check.name).join(', ')}`);
        if (fresh.length > 0)
            parts.push(`${String(fresh.length)} unaddressed review comment(s)`);
        return {
            kind: 'escalate',
            reason: `the same failure survived ${String(input.consecutiveFails)} healing round(s)`,
            question: `${input.threadTitle}: ${parts.join('; ')}. ${String(input.consecutiveFails)} automatic repairs in a row left the same failure in place (${String(input.healAttempts)} round(s) total). How should this be resolved?`,
        };
    }
    const parts = [];
    if (failures.length > 0)
        parts.push(`${String(failures.length)} failing check(s)`);
    if (fresh.length > 0)
        parts.push(`${String(fresh.length)} review comment(s)`);
    return { kind: 'heal', reason: parts.join(' and '), prompt: buildHealPrompt(input, failures, fresh) };
}
/** Merge a poll result into a stored snapshot, preserving consumed comment ids. */
export function mergeSnapshot(previous, next) {
    return {
        prRef: next.prRef,
        ...(next.prUrl === undefined ? {} : { prUrl: next.prUrl }),
        state: next.state,
        checks: next.checks,
        comments: next.comments,
        consumedCommentIds: previous?.consumedCommentIds ?? [],
        observedAt: next.now,
    };
}
/** Mark the comments a healing round consumed, keeping order stable and deduped. */
export function consumeComments(snapshot, comments) {
    const merged = new Set([...snapshot.consumedCommentIds, ...comments.map((comment) => comment.id)]);
    return [...merged];
}
/** True when a snapshot has any signal worth waking the thread for. */
export function hasActionableSignal(snapshot) {
    return (snapshot.checks.some((check) => check.conclusion === 'fail') ||
        snapshot.comments.some((comment) => !snapshot.consumedCommentIds.includes(comment.id)));
}
