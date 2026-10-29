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
import type { CommandRunner } from './exec.js';
import { parseNameStatus } from './library.js';
import type { ProjectOutputFile } from '../types.js';

/** Resolved git facts about the project root. */
export interface RepoFacts {
  isRepo: boolean;
  repositoryRoot?: string;
  /** Current `HEAD` commit, when the repository has one. */
  headCommit?: string;
  /** Current branch name; `undefined` on a detached head. */
  branch?: string;
  /** Whether `gh` is installed and authenticated. */
  ghReady: boolean;
  /** Why gh is unavailable, for the panel warning. */
  ghProblem?: string;
}

/** Read the repository facts once per coordination round. */
export async function inspectRepo(runner: CommandRunner, rootDir: string, signalNote?: string): Promise<RepoFacts> {
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

/** Result of creating a scope-only or branch-only isolation unit. */
export interface BranchIsolation {
  branch: string;
  baseCommit?: string;
  /** Present only when a real worktree was created. */
  worktreePath?: string;
}

/**
 * Create a branch for one thread.
 *
 * Uses `git branch` against the given base rather than checking out, so the parent
 * session's working tree never moves. When `worktreePath` is supplied the branch is
 * checked out there instead.
 */
export async function createBranch(
  runner: CommandRunner,
  options: { repoRoot: string; branch: string; from: string; worktreePath?: string },
): Promise<BranchIsolation> {
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

/** Whether a path is a valid checkout of the given branch. */
export async function isWorktreeHealthy(runner: CommandRunner, worktreePath: string): Promise<boolean> {
  const probe = await runProbe(runner, { argv: ['git', 'rev-parse', '--git-dir'], cwd: worktreePath });
  return probe.exitCode === 0;
}

/** One local commit made by a thread. */
export async function commitAll(
  runner: CommandRunner,
  options: { cwd: string; message: string; authorName?: string; authorEmail?: string },
): Promise<{ committed: boolean; commit?: string }> {
  const { cwd, message } = options;
  const status = await runChecked(runner, { argv: ['git', 'status', '--porcelain'], cwd });
  if (status.trim().length === 0) return { committed: false };
  await runChecked(runner, { argv: ['git', 'add', '--all'], cwd });
  const env: Record<string, string> = {};
  if (options.authorName !== undefined) {
    env['GIT_AUTHOR_NAME'] = options.authorName;
    env['GIT_COMMITTER_NAME'] = options.authorName;
  }
  if (options.authorEmail !== undefined) {
    env['GIT_AUTHOR_EMAIL'] = options.authorEmail;
    env['GIT_COMMITTER_EMAIL'] = options.authorEmail;
  }
  await runChecked(runner, {
    argv: ['git', 'commit', '--no-verify', '-m', message],
    cwd,
    ...(Object.keys(env).length === 0 ? {} : { env }),
  });
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
export async function readChangedFiles(
  runner: CommandRunner,
  cwd: string,
  from: string,
  to: string,
): Promise<ProjectOutputFile[] | undefined> {
  const probe = await runProbe(runner, {
    argv: ['git', 'diff', '--name-status', '--no-renames', `${from}..${to}`],
    cwd,
  });
  if (probe.exitCode !== 0) return undefined;
  return parseNameStatus(probe.stdout);
}

/** Push a branch to `origin`, setting upstream on first push. */
export async function pushBranch(runner: CommandRunner, cwd: string, branch: string): Promise<boolean> {
  const result = await runProbe(runner, {
    argv: ['git', 'push', '--set-upstream', 'origin', branch],
    cwd,
    env: { GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' },
  });
  return result.exitCode === 0;
}

/** A pull request as reported by `gh pr view --json`. */
export interface PullRequestFacts {
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
  headRefName: string;
  reviewDecision?: string;
  mergeable?: string;
}

/** Read one PR by branch, or `undefined` when none exists yet. */
/**
 * The commit where `a` and `b` diverged, or `undefined` when git cannot tell.
 *
 * Conflict candidates are computed against this point rather than against the base branch
 * tip: files changed only on the base since the fork are not the thread's problem, and
 * reporting them would send the thread moving commits it never touched.
 */
export async function mergeBase(
  runner: CommandRunner,
  cwd: string,
  a: string,
  b: string,
): Promise<string | undefined> {
  const result = await runProbe(runner, { argv: ['git', 'merge-base', a, b], cwd });
  if (result.exitCode !== 0) return undefined;
  const commit = result.stdout.trim();
  return commit.length === 0 ? undefined : commit;
}

/** The branch a pull request would merge into. */
export async function readPrBase(
  runner: CommandRunner,
  cwd: string,
  prNumber: number,
): Promise<string | undefined> {
  const result = await runProbe(runner, {
    argv: ['gh', 'pr', 'view', String(prNumber), '--json', 'baseRefName'],
    cwd,
  });
  if (result.exitCode !== 0) return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as { baseRefName?: unknown };
    return typeof parsed.baseRefName === 'string' && parsed.baseRefName.length > 0
      ? parsed.baseRefName
      : undefined;
  } catch {
    return undefined;
  }
}

export async function findPullRequest(runner: CommandRunner, cwd: string, branch: string): Promise<PullRequestFacts | undefined> {
  const result = await runProbe(runner, {
    argv: ['gh', 'pr', 'view', branch, '--json', 'number,url,state,isDraft,headRefName,reviewDecision,mergeable'],
    cwd,
  });
  if (result.exitCode !== 0) return undefined;
  try {
    return JSON.parse(result.stdout) as PullRequestFacts;
  } catch {
    return undefined;
  }
}

/** Create a PR for `branch`; returns the PR facts, or an error string. */
export async function createPullRequest(
  runner: CommandRunner,
  options: { cwd: string; branch: string; title: string; body: string; base?: string; draft?: boolean },
): Promise<{ ok: true; pr: PullRequestFacts } | { ok: false; message: string }> {
  const argv = ['gh', 'pr', 'create', '--head', options.branch, '--title', options.title, '--body', options.body];
  if (options.base !== undefined) argv.push('--base', options.base);
  if (options.draft === true) argv.push('--draft');
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

/** One CI check from `gh pr checks --json`. */
/**
 * Meaning of a `gh` failure for the polling loop.
 *
 * The distinction exists because the two kinds must not share a code path: a merged pull
 * request whose branch was deleted answers "no pull requests found", which is the *end*
 * of monitoring and should settle the thread, while an expired token answers the same
 * way to a naive caller and must not settle anything. Reporting both as one error list
 * (the earlier behaviour) leaves a finished thread stuck in `awaiting_review` forever and
 * tells the user nothing about either case.
 *
 * - `benign`: not a failure — no CI is configured, nothing has run yet.
 * - `retryable`: network, auth expiry, rate limiting, unknown. Keep polling, and surface
 *   the message so a broken token does not look like a quiet pull request.
 * - `terminal`: the pull request or branch is gone. Stop polling this thread.
 */
export type GhFailureKind = 'benign' | 'retryable' | 'terminal';

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
export function classifyGhFailure(message: string): GhFailureKind {
  const value = message.trim().toLowerCase();
  if (value.length === 0) return 'benign';
  for (const marker of BENIGN_FAILURES) if (value.includes(marker)) return 'benign';
  for (const marker of RETRYABLE_FAILURES) if (value.includes(marker)) return 'retryable';
  for (const marker of TERMINAL_FAILURES) if (value.includes(marker)) return 'terminal';
  // Default to retryable: an unclassified failure that quietly unsubscribed a thread
  // would stop monitoring on a message nobody has seen before, and stop permanently.
  return 'retryable';
}

export interface RawCheck {
  name: string;
  state: string;
  link?: string;
}

/** Read the current check list for a PR. */
export async function readChecks(runner: CommandRunner, cwd: string, branch: string): Promise<{ checks: RawCheck[]; error?: string }> {
  const result = await runProbe(runner, {
    argv: ['gh', 'pr', 'checks', branch, '--json', 'name,state,link'],
    cwd,
  });
  // `gh pr checks` exits non-zero when checks are failing or pending; that is data.
  if (result.stdout.trim().length === 0) {
    return { checks: [], ...(result.exitCode === 0 ? {} : { error: result.stderr.trim() || 'no checks reported' }) };
  }
  try {
    return { checks: JSON.parse(result.stdout) as RawCheck[] };
  } catch {
    return { checks: [], error: 'unparseable `gh pr checks` output' };
  }
}

/** One review comment from the REST API. */
export interface RawComment {
  id: number | string;
  user?: { login?: string };
  body?: string;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  created_at?: string;
}

/** Read inline review comments for a PR. */
export async function readReviewComments(
  runner: CommandRunner,
  cwd: string,
  prNumber: number,
): Promise<{ comments: RawComment[]; error?: string }> {
  const result = await runProbe(runner, {
    argv: ['gh', 'api', `repos/{owner}/{repo}/pulls/${prNumber}/comments`, '--paginate'],
    cwd,
  });
  if (result.exitCode !== 0) return { comments: [], error: result.stderr.trim() || 'gh api failed' };
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    return { comments: Array.isArray(parsed) ? (parsed as RawComment[]) : [] };
  } catch {
    return { comments: [], error: 'unparseable review-comment payload' };
  }
}

/** Read the PR-level review bodies (approve / request-changes verdicts). */
export async function readReviewVerdicts(
  runner: CommandRunner,
  cwd: string,
  prNumber: number,
): Promise<{ reviews: Array<{ id: number | string; user?: { login?: string }; state?: string; body?: string }>; error?: string }> {
  const result = await runProbe(runner, {
    argv: ['gh', 'api', `repos/{owner}/{repo}/pulls/${prNumber}/reviews`, '--paginate'],
    cwd,
  });
  if (result.exitCode !== 0) return { reviews: [], error: result.stderr.trim() || 'gh api failed' };
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    return { reviews: Array.isArray(parsed) ? (parsed as Array<{ id: number | string; user?: { login?: string }; state?: string; body?: string }>) : [] };
  } catch {
    return { reviews: [], error: 'unparseable review payload' };
  }
}

/** Read the failing-check log excerpt used to build a healing prompt. */
export async function readFailingLog(
  runner: CommandRunner,
  cwd: string,
  branch: string,
  maxChars = 4000,
): Promise<string> {
  const runId = await runProbe(runner, { argv: ['gh', 'pr', 'checks', branch, '--json', 'name,state,link'], cwd });
  const spec = { argv: ['gh', 'run', 'list', '--branch', branch, '--limit', '1', '--json', 'databaseId,conclusion'], cwd };
  const list = await runProbe(runner, spec);
  if (list.exitCode !== 0) return runId.stdout.trim().slice(0, maxChars);
  let id: number | undefined;
  try {
    const rows = JSON.parse(list.stdout) as Array<{ databaseId?: number }>;
    id = rows[0]?.databaseId;
  } catch {
    return '';
  }
  if (id === undefined) return '';
  const log = await runProbe(runner, { argv: ['gh', 'run', 'view', String(id), '--log-failed'], cwd });
  const text = log.stdout.trim().length > 0 ? log.stdout : log.stderr;
  return tailLines(text, maxChars);
}

/** Keep the last N characters on line boundaries — CI logs fail at the end. */
export function tailLines(text: string, maxChars: number): string {
  // A build log's signal is at the end, so keep the tail. Clipping from the front is the
  // whole point: the first half of a CI log is checkout and dependency noise.
  if (text.length <= maxChars) return text.trim();
  if (maxChars <= 0) return '';
  const clipped = text.slice(text.length - maxChars);
  const firstBreak = clipped.indexOf('\n');
  return (firstBreak >= 0 ? clipped.slice(firstBreak + 1) : clipped).trim();
}

/** Read the merge state of a PR as a single verb. */
export async function readPrState(runner: CommandRunner, cwd: string, prNumber: number): Promise<string | undefined> {
  const result = await runProbe(runner, { argv: ['gh', 'pr', 'view', String(prNumber), '--json', 'state,isDraft'], cwd });
  if (result.exitCode !== 0) return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as { state?: string; isDraft?: boolean };
    if (parsed.state === undefined) return undefined;
    return parsed.isDraft === true && parsed.state === 'OPEN' ? 'draft' : parsed.state.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Ensure the git identity exists so commits never fail on a fresh machine. */
export async function ensureGitIdentity(runner: CommandRunner, repoRoot: string): Promise<void> {
  const name = await runProbe(runner, { argv: ['git', 'config', 'user.name'], cwd: repoRoot });
  if (name.exitCode === 0 && name.stdout.trim().length > 0) return;
  assertOk(
    { argv: ['git', 'config', 'user.name', 'dsh-newprojects'], cwd: repoRoot },
    await runner.run({ argv: ['git', 'config', 'user.name', 'dsh-newprojects'], cwd: repoRoot }),
  );
}
