/**
 * Real-git integration for the VCS layer.
 *
 * Every other suite fakes the `CommandRunner`, which proves the *decisions* but not the
 * plumbing: quoting, exit codes, `--porcelain` output shapes, and whether `git worktree add`
 * leaves a usable checkout are all facts about real git. These tests run against actual
 * repositories in a temp directory, so a wrong flag fails here instead of in a user's repo.
 *
 * The runner is built on `node:child_process` on purpose: `src/` must never do that (the
 * plugin runs commands through the Host's `subprocess` service so they land on the right
 * machine), but a test harness may.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';

import type { CommandResult, CommandRunner, CommandSpec } from '../../src/core/exec.js';
import {
  commitAll,
  createBranch,
  ensureGitIdentity,
  inspectRepo,
  isWorktreeHealthy,
  pushBranch,
} from '../../src/core/vcs.js';

const run = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const cleanup of cleanups) await cleanup();
});

/** A runner that actually executes the command. */
class RealRunner implements CommandRunner {
  readonly cwds: string[] = [];

  async run(spec: CommandSpec): Promise<CommandResult> {
    this.cwds.push(spec.cwd);
    try {
      const { stdout, stderr } = await run(spec.argv[0] ?? '', spec.argv.slice(1), {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        timeout: spec.timeoutMs ?? 60_000,
      });
      return { exitCode: 0, stdout, stderr };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string; message?: string };
      // A missing binary is reported as ENOENT rather than an exit code; the port models
      // that as `spawnError` so callers can tell "not installed" from "ran and failed".
      if (typeof failure.code !== 'number') {
        return {
          exitCode: 127,
          stdout: '',
          stderr: failure.message ?? '',
          spawnError: failure.message ?? 'spawn failed',
        };
      }
      return { exitCode: failure.code, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
    }
  }
}

/** Make a fresh repository with one commit, configured to allow commits. */
async function freshRepo(): Promise<{ root: string; runner: RealRunner }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-project-git-'));
  cleanups.push(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const runner = new RealRunner();
  const git = (argv: string[]): Promise<CommandResult> => runner.run({ argv, cwd: root });
  await git(['git', 'init', '-b', 'main']);
  await git(['git', 'config', 'user.email', 'test@example.com']);
  await git(['git', 'config', 'user.name', 'Test']);
  await git(['git', 'config', 'commit.gpgsign', 'false']);
  await writeFile(join(root, 'README.md'), '# demo\n', 'utf8');
  await git(['git', 'add', '--all']);
  await git(['git', 'commit', '-m', 'init']);
  return { root, runner };
}

/** The commit the repository's HEAD points at. */
async function headOf(runner: RealRunner, root: string): Promise<string> {
  const head = await runner.run({ argv: ['git', 'rev-parse', 'HEAD'], cwd: root });
  return head.stdout.trim();
}

describe('real git integration', () => {
  let gitAvailable = true;
  before(async () => {
    try {
      await run('git', ['--version']);
    } catch {
      gitAvailable = false;
    }
  });

  it('detects a repository and its head', async (t) => {
    if (!gitAvailable) return t.skip('git is not installed');
    const { root, runner } = await freshRepo();
    const facts = await inspectRepo(runner, root);
    assert.equal(facts.isRepo, true);
    assert.equal(facts.branch, 'main');
    assert.match(facts.headCommit ?? '', /^[0-9a-f]{7,}$/);
    // A temp repo has no remote, so only the git half is asserted here.
  });

  it('reports a plain directory as not a repository without throwing', async (t) => {
    if (!gitAvailable) return t.skip('git is not installed');
    const { runner } = await freshRepo();
    const plain = await mkdtemp(join(tmpdir(), 'dsh-project-plain-'));
    cleanups.push(async () => {
      await rm(plain, { recursive: true, force: true });
    });
    const facts = await inspectRepo(runner, plain);
    assert.equal(facts.isRepo, false);
    assert.equal(facts.ghReady, false);
  });

  it('creates a branch without touching the working tree', async (t) => {
    if (!gitAvailable) return t.skip('git is not installed');
    const { root, runner } = await freshRepo();
    const base = await headOf(runner, root);
    const isolation = await createBranch(runner, {
      repoRoot: root,
      branch: 'project/demo/1-first',
      from: base,
    });
    assert.equal(isolation.branch, 'project/demo/1-first');
    // `git branch` creates the ref but must NOT check it out: the parent session keeps
    // working on its own branch while threads run on theirs.
    const status = await runner.run({
      argv: ['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
      cwd: root,
    });
    assert.equal(status.stdout.trim(), 'main');
    const refs = await runner.run({
      argv: ['git', 'branch', '--list', 'project/demo/1-first'],
      cwd: root,
    });
    assert.match(refs.stdout, /project\/demo\/1-first/);
  });

  it('reuses an existing branch instead of failing', async (t) => {
    if (!gitAvailable) return t.skip('git is not installed');
    const { root, runner } = await freshRepo();
    const base = await headOf(runner, root);
    await createBranch(runner, { repoRoot: root, branch: 'project/demo/1-first', from: base });
    // A retried thread must land on the branch it already owns, not die on "already exists".
    const again = await createBranch(runner, {
      repoRoot: root,
      branch: 'project/demo/1-first',
      from: base,
    });
    assert.equal(again.branch, 'project/demo/1-first');
  });

  it('creates a worktree that exists on disk and carries a clean checkout', async (t) => {
    if (!gitAvailable) return t.skip('git is not installed');
    const { root, runner } = await freshRepo();
    const base = await headOf(runner, root);
    const path = join(root, '..', `${root.split(/[\\/]/).pop() ?? 'repo'}-wt`);
    cleanups.push(async () => {
      await rm(path, { recursive: true, force: true });
    });
    const isolation = await createBranch(runner, {
      repoRoot: root,
      branch: 'project/demo/2-second',
      from: base,
      worktreePath: path,
    });
    assert.equal(isolation.worktreePath, path);
    assert.equal(await isWorktreeHealthy(runner, path), true);
    // The worktree is a real checkout: files from the base commit are present.
    // Normalise line endings: Windows checkouts may apply `core.autocrlf`, and that is a
    // property of git's checkout policy, not of whether the worktree works.
    const readme = await readFile(join(path, 'README.md'), 'utf8');
    assert.equal(readme.replace(/\r\n/g, '\n'), '# demo\n');
  });

  it('reports a missing worktree as unhealthy rather than throwing', async (t) => {
    if (!gitAvailable) return t.skip('git is not installed');
    const { root, runner } = await freshRepo();
    assert.equal(await isWorktreeHealthy(runner, join(root, 'nope')), false);
  });

  it('treats a clean tree as nothing to commit', async (t) => {
    if (!gitAvailable) return t.skip('git is not installed');
    const { root, runner } = await freshRepo();
    const outcome = await commitAll(runner, { cwd: root, message: 'chore: nothing' });
    // Reporting `committed:false` is what stops `deliver` from opening an empty PR.
    assert.equal(outcome.committed, false);
  });

  it('commits dirty work with an explicit identity', async (t) => {
    if (!gitAvailable) return t.skip('git is not installed');
    const { root, runner } = await freshRepo();
    await writeFile(join(root, 'feature.txt'), 'work\n', 'utf8');
    const outcome = await commitAll(runner, {
      cwd: root,
      message: 'feat: add feature',
      authorName: 'Thread Bot',
      authorEmail: 'thread@example.com',
    });
    assert.equal(outcome.committed, true);
    assert.match(outcome.commit ?? '', /^[0-9a-f]{7,}$/);
    const log = await runner.run({ argv: ['git', 'log', '-1', '--format=%s|%an'], cwd: root });
    assert.equal(log.stdout.trim(), 'feat: add feature|Thread Bot');
  });

  it('reports a failing push instead of pretending it worked', async (t) => {
    if (!gitAvailable) return t.skip('git is not installed');
    const { root, runner } = await freshRepo();
    const base = await headOf(runner, root);
    await createBranch(runner, { repoRoot: root, branch: 'project/demo/3-third', from: base });
    // No remote configured: the push must surface the failure, because `deliver` promises a
    // reviewable branch and a silent success would leave the thread unable to open a PR.
    const ok = await pushBranch(runner, root, 'project/demo/3-third');
    assert.equal(ok, false);
  });

  it('pushes a real branch to a local remote', async (t) => {
    if (!gitAvailable) return t.skip('git is not installed');
    const { root, runner } = await freshRepo();
    const remote = await mkdtemp(join(tmpdir(), 'dsh-project-remote-'));
    cleanups.push(async () => {
      await rm(remote, { recursive: true, force: true });
    });
    // A bare local remote exercises the success path without touching the network.
    await runner.run({ argv: ['git', 'init', '--bare', '-b', 'main'], cwd: remote });
    await runner.run({ argv: ['git', 'remote', 'add', 'origin', remote], cwd: root });
    const base = await headOf(runner, root);
    await createBranch(runner, { repoRoot: root, branch: 'project/demo/4-fourth', from: base });
    const ok = await pushBranch(runner, root, 'project/demo/4-fourth');
    assert.equal(ok, true);
    const refs = await runner.run({
      argv: ['git', 'branch', '--list', 'project/demo/4-fourth'],
      cwd: remote,
    });
    assert.match(refs.stdout, /project\/demo\/4-fourth/);
  });

  it('leaves an existing identity alone', async (t) => {
    if (!gitAvailable) return t.skip('git is not installed');
    const { root, runner } = await freshRepo();
    await ensureGitIdentity(runner, root);
    const email = await runner.run({ argv: ['git', 'config', 'user.email'], cwd: root });
    // The configured address must survive: rewriting a user's identity would misattribute
    // every later commit in the repository.
    assert.equal(email.stdout.trim(), 'test@example.com');
  });

  it('runs every command in the requested directory, not the process one', async (t) => {
    if (!gitAvailable) return t.skip('git is not installed');
    const { root, runner } = await freshRepo();
    await inspectRepo(runner, root);
    // The port exists so commands can run on a different machine than the Host; if the cwd
    // were ignored every call would silently inspect the wrong repository.
    assert.ok(runner.cwds.length > 0);
    assert.ok(
      runner.cwds.every((cwd) => cwd === root),
      'every command used the requested cwd',
    );
  });
});
