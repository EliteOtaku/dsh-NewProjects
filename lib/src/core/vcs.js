/**
 * Git isolation and GitHub delivery.
 *
 * Every function here is a thin, testable wrapper over the {@link CommandRunner}
 * port. Two isolation tiers exist and both are first class:
 *
 * - **worktree**: a real `git worktree` on its own branch, giving each thread an
 *   independent checkout. Chosen whenever the Host's `worktrees` service is
 *   available and the project root is a clean-enough git repository.
 * - **scope**: no checkout at all; the thread is told which paths it owns and the
 *   coordinator trusts path discipline. This is the fallback, never a silent one —
 *   the descriptor records `branchOrScope` either way and the panel shows which.
 */
import { assertOk, runChecked, runProbe } from './exec.js';
import { parseNameStatus } from './library.js';
/** Read the repository facts once per coordination round. */
export async function inspectRepo(runner, rootDir, signalNote) {
    const gitDir = await runProbe(runner, { argv: ['git', 'rev-parse', '--git-dir'], cwd: rootDir });
    if (gitDir.exitCode !== 0) {
        return { isRepo: false, ghReady: false, ghProblem: signalNote ?? 'not a git repository' };
    }
    const top = await runProbe(runner, { argv: ['git', 'rev-parse', '--show-toplevel'], cwd: rootDir });
    const repositoryRoot = top.exitCode === 0 ? top.stdout.trim() : rootDir;
    const head = await runProbe(runner, { argv: ['git', 'rev-parse', 'HEAD'], cwd: rootDir });
    const headCommit = head.exitCode === 0 ? head.stdout.trim() : undefined;
    const branch = await runProbe(runner, { argv: ['git', 'rev-parse', '--abbrev-ref', 'HEAD'], cwd: rootDir });
    const branchName = branch.exitCode === 0 ? branch.stdout.trim() : '';
    const ghVersion = await runProbe(runner, { argv: ['gh', '--version'], cwd: rootDir });
    if (ghVersion.exitCode !== 0) {
        return {
            isRepo: true,
            repositoryRoot,
            ...(headCommit === undefined ? {} : { headCommit }),
            ...(branchName.length === 0 || branchName === 'HEAD' ? {} : { branch: branchName }),
            ghReady: false,
            ghProblem: 'gh CLI not available',
        };
    }
    const ghAuth = await runProbe(runner, { argv: ['gh', 'auth', 'status'], cwd: rootDir });
    const ghReady = ghAuth.exitCode === 0;
    return {
        isRepo: true,
        repositoryRoot,
        ...(headCommit === undefined ? {} : { headCommit }),
        ...(branchName.length === 0 || branchName === 'HEAD' ? {} : { branch: branchName }),
        ghReady,
        ...(ghReady ? {} : { ghProblem: 'gh CLI is not authenticated (run `gh auth login`)' }),
    };
}
/**
 * Create a branch for one thread.
 *
 * Uses `git branch` against the given base rather than checking out, so the parent
 * session's working tree never moves. When `worktreePath` is supplied the branch is
 * checked out there instead.
 */
export async function createBranch(runner, options) {
    const { repoRoot, branch, from, worktreePath } = options;
    const exists = await runProbe(runner, { argv: ['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], cwd: repoRoot });
    if (exists.exitCode === 0) {
        // Re-planning the same task must not fail; reuse the branch and report it.
        const head = await runProbe(runner, { argv: ['git', 'rev-parse', branch], cwd: repoRoot });
        return { branch, baseCommit: head.exitCode === 0 ? head.stdout.trim() : from, ...(worktreePath === undefined ? {} : { worktreePath }) };
    }
    if (worktreePath !== undefined) {
        await runChecked(runner, { argv: ['git', 'worktree', 'add', '-b', branch, worktreePath, from], cwd: repoRoot });
        const head = await runChecked(runner, { argv: ['git', 'rev-parse', 'HEAD'], cwd: worktreePath });
        return { branch, baseCommit: head.trim(), worktreePath };
    }
    await runChecked(runner, { argv: ['git', 'branch', branch, from], cwd: repoRoot });
    return { branch, baseCommit: from };
}
/**
 * Delete a thread's worktree, keeping its branch.
 *
 * Only ever called after the branch is pushed. An unpushed commit lives nowhere else once the
 * checkout is gone, which is why this is not wired into anything that runs before a push.
 *
 * `--force` is deliberate rather than careless: `git worktree remove` refuses a dirty tree, and
 * whatever is still uncommitted at that point was never part of the deliverable — the Library
 * already recorded what the branch changed. Refusing to clean up would leave a full checkout on
 * disk for every thread ever delivered.
 *
 * Returns a warning instead of throwing: a failed cleanup is housekeeping, not a delivery
 * failure, and the pull request is already open by the time this runs.
 */
export async function removeWorktree(runner, repoRoot, worktreePath) {
    const removal = await runProbe(runner, {
        argv: ['git', 'worktree', 'remove', '--force', worktreePath],
        cwd: repoRoot,
    });
    if (removal.exitCode === 0)
        return { removed: true };
    // The directory may already be gone (a user deleted it, or a previous pass half-finished)
    // while git still lists the registration. Prune reconciles that bookkeeping.
    await runProbe(runner, { argv: ['git', 'worktree', 'prune'], cwd: repoRoot });
    const still = await isWorktreeHealthy(runner, worktreePath);
    if (!still)
        return { removed: true };
    const detail = `${removal.stderr}`.trim().split('\n')[0] ?? '';
    return {
        removed: false,
        warning: `could not remove worktree ${worktreePath}${detail === '' ? '' : `: ${detail}`}`,
    };
}
/**
 * Put a thread's checkout back on disk after delivery reclaimed it.
 *
 * The branch is the durable record; the worktree is a cache of it. Restoring on demand is what
 * lets delivery delete the checkout without making a later heal turn land in a missing
 * directory — the child session's working directory *is* this path, so it has to exist again
 * before the thread is woken.
 */
export async function ensureWorktree(runner, repoRoot, branch, worktreePath) {
    if (await isWorktreeHealthy(runner, worktreePath))
        return { ok: true };
    const added = await runProbe(runner, {
        argv: ['git', 'worktree', 'add', worktreePath, branch],
        cwd: repoRoot,
    });
    if (added.exitCode === 0)
        return { ok: true };
    const detail = `${added.stderr}`.trim().split('\n')[0] ?? '';
    return {
        ok: false,
        message: `could not restore worktree ${worktreePath} for branch ${branch}${detail === '' ? '' : `: ${detail}`}`,
    };
}
/** Whether a path is a valid checkout of the given branch. */
export async function isWorktreeHealthy(runner, worktreePath) {
    const probe = await runProbe(runner, { argv: ['git', 'rev-parse', '--git-dir'], cwd: worktreePath });
    return probe.exitCode === 0;
}
/** One local commit made by a thread. */
export async function commitAll(runner, options) {
    const { cwd, message } = options;
    const status = await runChecked(runner, { argv: ['git', 'status', '--porcelain'], cwd });
    if (status.trim().length === 0)
        return { committed: false };
    await runChecked(runner, { argv: ['git', 'add', '--all'], cwd });
    const env = {};
    if (options.authorName !== undefined) {
        env['GIT_AUTHOR_NAME'] = options.authorName;
        env['GIT_COMMITTER_NAME'] = options.authorName;
    }
    if (options.authorEmail !== undefined) {
        env['GIT_AUTHOR_EMAIL'] = options.authorEmail;
        env['GIT_COMMITTER_EMAIL'] = options.authorEmail;
    }
    const commit = {
        argv: ['git', 'commit', '--no-verify', '-m', message],
        cwd,
        ...(Object.keys(env).length === 0 ? {} : { env }),
    };
    const result = await runner.run(commit);
    if (result.exitCode !== 0 && Object.keys(env).length === 0 && isMissingGitIdentity(result.stderr)) {
        // Only when git itself refuses: an identity it can find or derive is the user's and is kept.
        assertOk(commit, await runner.run({ ...commit, env: fallbackIdentityEnv() }));
    }
    else {
        assertOk(commit, result);
    }
    const head = await runChecked(runner, { argv: ['git', 'rev-parse', 'HEAD'], cwd });
    return { committed: true, commit: head.trim() };
}
/**
 * Files changed between two revisions, as the Library reports them.
 *
 * `--no-renames` is deliberate: a rename becomes a deletion plus an addition, which is
 * what the Library should say. Collapsing it into one `renamed` row hides the path a user
 * may still be looking for, and the panel renders paths one per row anyway.
 *
 * Returns `undefined` when git refuses the range (a thread that never committed, a base
 * commit that no longer exists). The caller treats that as "this thread produced nothing
 * we can describe", which is honest; an empty list would claim it produced nothing at all.
 */
export async function readChangedFiles(runner, cwd, from, to) {
    const probe = await runProbe(runner, {
        argv: ['git', 'diff', '--name-status', '--no-renames', `${from}..${to}`],
        cwd,
    });
    if (probe.exitCode !== 0)
        return undefined;
    return parseNameStatus(probe.stdout);
}
/** Push a branch to `origin`, setting upstream on first push. */
export async function pushBranch(runner, cwd, branch) {
    const result = await runProbe(runner, {
        argv: ['git', 'push', '--set-upstream', 'origin', branch],
        cwd,
        env: { GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' },
    });
    return result.exitCode === 0;
}
/** Read one PR by branch, or `undefined` when none exists yet. */
/**
 * The commit where `a` and `b` diverged, or `undefined` when git cannot tell.
 *
 * Conflict candidates are computed against this point rather than against the base branch
 * tip: files changed only on the base since the fork are not the thread's problem, and
 * reporting them would send the thread moving commits it never touched.
 */
export async function mergeBase(runner, cwd, a, b) {
    const result = await runProbe(runner, { argv: ['git', 'merge-base', a, b], cwd });
    if (result.exitCode !== 0)
        return undefined;
    const commit = result.stdout.trim();
    return commit.length === 0 ? undefined : commit;
}
/** The branch a pull request would merge into. */
export async function readPrBase(runner, cwd, prNumber) {
    const result = await runProbe(runner, {
        argv: ['gh', 'pr', 'view', String(prNumber), '--json', 'baseRefName'],
        cwd,
    });
    if (result.exitCode !== 0)
        return undefined;
    try {
        const parsed = JSON.parse(result.stdout);
        return typeof parsed.baseRefName === 'string' && parsed.baseRefName.length > 0
            ? parsed.baseRefName
            : undefined;
    }
    catch {
        return undefined;
    }
}
export async function findPullRequest(runner, cwd, branch) {
    const result = await runProbe(runner, {
        argv: ['gh', 'pr', 'view', branch, '--json', 'number,url,state,isDraft,headRefName,reviewDecision,mergeable'],
        cwd,
    });
    if (result.exitCode !== 0)
        return undefined;
    try {
        return JSON.parse(result.stdout);
    }
    catch {
        return undefined;
    }
}
/** Create a PR for `branch`; returns the PR facts, or an error string. */
export async function createPullRequest(runner, options) {
    const argv = ['gh', 'pr', 'create', '--head', options.branch, '--title', options.title, '--body', options.body];
    if (options.base !== undefined)
        argv.push('--base', options.base);
    if (options.draft === true)
        argv.push('--draft');
    const result = await runProbe(runner, { argv, cwd: options.cwd });
    if (result.exitCode !== 0) {
        return { ok: false, message: result.stderr.trim() || result.stdout.trim() || 'gh pr create failed' };
    }
    const pr = await findPullRequest(runner, options.cwd, options.branch);
    if (pr === undefined) {
        const url = result.stdout.trim().split(/\s+/).pop() ?? '';
        return { ok: false, message: `gh reported success but the PR could not be read back (${url})` };
    }
    return { ok: true, pr };
}
const BENIGN_FAILURES = ['no checks reported', 'no checks on this branch'];
const RETRYABLE_FAILURES = [
    'http 401',
    'http 403',
    'http 429',
    'http 5',
    'bad credentials',
    'rate limit',
    'abuse detection',
    'timeout',
    'timed out',
    'etimedout',
    'econnrefused',
    'econnreset',
    'enotfound',
    'network',
    'temporarily unavailable',
    'could not connect',
    'bad gateway',
    'server error',
];
const TERMINAL_FAILURES = [
    'no pull requests found',
    'could not resolve to a pullrequest',
    'could not resolve to a repository',
    'pull request not found',
    'http 404',
    'not found',
    'does not exist',
    'no commits between',
    'repository not found',
    'unknown revision',
    'no such remote',
    'couldn\'t find',
];
/** Classify one `gh` failure message. Unknown messages stay `retryable` on purpose. */
export function classifyGhFailure(message) {
    const value = message.trim().toLowerCase();
    if (value.length === 0)
        return 'benign';
    for (const marker of BENIGN_FAILURES)
        if (value.includes(marker))
            return 'benign';
    for (const marker of RETRYABLE_FAILURES)
        if (value.includes(marker))
            return 'retryable';
    for (const marker of TERMINAL_FAILURES)
        if (value.includes(marker))
            return 'terminal';
    // Default to retryable: an unclassified failure that quietly unsubscribed a thread
    // would stop monitoring on a message nobody has seen before, and stop permanently.
    return 'retryable';
}
/** Read the current check list for a PR. */
export async function readChecks(runner, cwd, branch) {
    const result = await runProbe(runner, {
        argv: ['gh', 'pr', 'checks', branch, '--json', 'name,state,link'],
        cwd,
    });
    // `gh pr checks` exits non-zero when checks are failing or pending; that is data.
    if (result.stdout.trim().length === 0) {
        return { checks: [], ...(result.exitCode === 0 ? {} : { error: result.stderr.trim() || 'no checks reported' }) };
    }
    try {
        return { checks: JSON.parse(result.stdout) };
    }
    catch {
        return { checks: [], error: 'unparseable `gh pr checks` output' };
    }
}
/** Read inline review comments for a PR. */
export async function readReviewComments(runner, cwd, prNumber) {
    const result = await runProbe(runner, {
        argv: ['gh', 'api', `repos/{owner}/{repo}/pulls/${prNumber}/comments`, '--paginate'],
        cwd,
    });
    if (result.exitCode !== 0)
        return { comments: [], error: result.stderr.trim() || 'gh api failed' };
    try {
        const parsed = JSON.parse(result.stdout);
        return { comments: Array.isArray(parsed) ? parsed : [] };
    }
    catch {
        return { comments: [], error: 'unparseable review-comment payload' };
    }
}
/** Read the PR-level review bodies (approve / request-changes verdicts). */
export async function readReviewVerdicts(runner, cwd, prNumber) {
    const result = await runProbe(runner, {
        argv: ['gh', 'api', `repos/{owner}/{repo}/pulls/${prNumber}/reviews`, '--paginate'],
        cwd,
    });
    if (result.exitCode !== 0)
        return { reviews: [], error: result.stderr.trim() || 'gh api failed' };
    try {
        const parsed = JSON.parse(result.stdout);
        return { reviews: Array.isArray(parsed) ? parsed : [] };
    }
    catch {
        return { reviews: [], error: 'unparseable review payload' };
    }
}
/** Read the failing-check log excerpt used to build a healing prompt. */
export async function readFailingLog(runner, cwd, branch, maxChars = 4000) {
    const runId = await runProbe(runner, { argv: ['gh', 'pr', 'checks', branch, '--json', 'name,state,link'], cwd });
    const spec = { argv: ['gh', 'run', 'list', '--branch', branch, '--limit', '1', '--json', 'databaseId,conclusion'], cwd };
    const list = await runProbe(runner, spec);
    if (list.exitCode !== 0)
        return runId.stdout.trim().slice(0, maxChars);
    let id;
    try {
        const rows = JSON.parse(list.stdout);
        id = rows[0]?.databaseId;
    }
    catch {
        return '';
    }
    if (id === undefined)
        return '';
    const log = await runProbe(runner, { argv: ['gh', 'run', 'view', String(id), '--log-failed'], cwd });
    const text = log.stdout.trim().length > 0 ? log.stdout : log.stderr;
    return tailLines(text, maxChars);
}
/** Keep the last N characters on line boundaries — CI logs fail at the end. */
export function tailLines(text, maxChars) {
    // A build log's signal is at the end, so keep the tail. Clipping from the front is the
    // whole point: the first half of a CI log is checkout and dependency noise.
    if (text.length <= maxChars)
        return text.trim();
    if (maxChars <= 0)
        return '';
    const clipped = text.slice(text.length - maxChars);
    const firstBreak = clipped.indexOf('\n');
    return (firstBreak >= 0 ? clipped.slice(firstBreak + 1) : clipped).trim();
}
/** Read the merge state of a PR as a single verb. */
export async function readPrState(runner, cwd, prNumber) {
    const result = await runProbe(runner, { argv: ['gh', 'pr', 'view', String(prNumber), '--json', 'state,isDraft'], cwd });
    if (result.exitCode !== 0)
        return undefined;
    try {
        const parsed = JSON.parse(result.stdout);
        if (parsed.state === undefined)
            return undefined;
        return parsed.isDraft === true && parsed.state === 'OPEN' ? 'draft' : parsed.state.toLowerCase();
    }
    catch {
        return undefined;
    }
}
/** The identity a commit falls back to when git has none to sign it with. */
export const FALLBACK_GIT_IDENTITY = { name: 'dsh-newprojects', email: 'dsh-newprojects@localhost' };
/** Whether git refused a commit because it has no author identity. */
export function isMissingGitIdentity(stderr) {
    return /Please tell me who you are|empty ident name|unable to auto-detect email address|no email was given/i.test(stderr);
}
/**
 * Keep commits working on a machine with no git identity, without writing one.
 *
 * This used to run `git config user.name` against the repository, which lands in the `.git`
 * every thread's worktree shares and outlives the project, the very write the thread prompts
 * forbid (`SHARED_GIT_CONFIG_RULE`). The environment carries the same identity for one
 * commit and leaves the user's configuration as it was.
 */
function fallbackIdentityEnv() {
    return {
        GIT_AUTHOR_NAME: FALLBACK_GIT_IDENTITY.name,
        GIT_COMMITTER_NAME: FALLBACK_GIT_IDENTITY.name,
        GIT_AUTHOR_EMAIL: FALLBACK_GIT_IDENTITY.email,
        GIT_COMMITTER_EMAIL: FALLBACK_GIT_IDENTITY.email,
    };
}
