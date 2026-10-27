/**
 * End-to-end flow of the Projects (Beta) loop, in the order the spec states it:
 *
 *   1. hand the coordinator a high-level goal
 *   2. it plans tasks and starts one thread per task on its own branch
 *   3. write one global decision into shared memory
 *   4. running threads receive it, future threads inherit it in their startup prefix
 *   5. a thread delivers, CI fails, the sweep wakes it to fix, then the PR waits for review
 *   6. the overview reflects every stage
 *
 * The git half is real (real repositories, real branches, real pushes to a bare remote), so a
 * wrong flag fails here rather than in a user's repository. Only the two ports that cannot run
 * headless — the subagent runtime and `gh` — are faked; `gh` is faked because opening a real
 * pull request needs a network identity, and its output shape is already pinned by the unit
 * tests for `readChecks`/`readReviewComments`.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';

import type { CommandResult, CommandRunner, CommandSpec } from '../../src/core/exec.js';
import { ProjectEngine } from '../../src/core/engine.js';
import { renderOverviewMarkdown } from '../../src/core/overview.js';
import { fixedClock, sequentialIds } from '../helpers.js';
import { FakeThreads } from '../helpers.js';

const run = promisify(execFile);

const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const cleanup of cleanups) await cleanup();
});

/** Executes git for real; answers `gh` from a script so PR state can be driven per stage. */
class HybridRunner implements CommandRunner {
  /** What the fake `gh` should report next. */
  prState: 'open' | 'merged' | 'closed' = 'open';
  /** Branches that actually opened a pull request. */
  readonly prBranches = new Set<string>();
  checks: Array<{ name: string; state: string; link?: string }> = [];
  comments: Array<{ id: number; user: { login: string }; body: string; path?: string; line?: number; created_at: string }> = [];

  async run(spec: CommandSpec): Promise<CommandResult> {
    if (spec.argv[0] === 'gh') return this.gh(spec);
    try {
      const { stdout, stderr } = await run(spec.argv[0] ?? '', spec.argv.slice(1), {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        timeout: 60_000,
      });
      return { exitCode: 0, stdout, stderr };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string; message?: string };
      if (typeof failure.code !== 'number') {
        return { exitCode: 127, stdout: '', stderr: failure.message ?? '', spawnError: failure.message ?? 'spawn failed' };
      }
      return { exitCode: failure.code, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
    }
  }

  private gh(spec: CommandSpec): CommandResult {
    const argv = spec.argv.join(' ');
    const ok = (stdout: string): CommandResult => ({ exitCode: 0, stdout, stderr: '' });
    if (argv.startsWith('gh --version')) return ok('gh version 2.0.0\n');
    if (argv.startsWith('gh auth status')) return ok('Logged in to github.com as tester\n');
    if (argv.startsWith('gh pr create')) {
      const head = spec.argv[spec.argv.indexOf('--head') + 1] ?? 'main';
      this.prBranches.add(head);
      return ok('https://github.com/example/demo/pull/7\n');
    }
    if (argv.startsWith('gh pr view')) {
      const target = spec.argv[3] ?? 'main';
      // `gh pr view` is called two ways: by branch (to find the PR) and by number (to read its
      // state). Only the by-branch form depends on a PR existing.
      if (!/^\d+$/.test(target)) {
        if (!this.prBranches.has(target)) {
          return { exitCode: 1, stdout: '', stderr: `no pull requests found for branch ${target}` };
        }
        return ok(
          JSON.stringify({
            number: 7,
            url: 'https://github.com/example/demo/pull/7',
            state: this.prState.toUpperCase(),
            isDraft: false,
            headRefName: target,
          }),
        );
      }
      return ok(JSON.stringify({ state: this.prState.toUpperCase(), isDraft: false }));
    }
    if (argv.startsWith('gh pr checks')) {
      // Only a branch with a PR has checks; the others must report an error, or every
      // running thread inherits the one PR's failure and the sweep wakes all of them.
      const branch = spec.argv[3] ?? 'main';
      if (!this.prBranches.has(branch)) {
        return { exitCode: 1, stdout: '', stderr: `no pull requests found for branch ${branch}` };
      }
      // The real command exits non-zero when checks fail while still printing JSON; `readChecks`
      // is written to cope with that, and mimicking it here keeps the test honest.
      const failing = this.checks.some((c) => c.state === 'FAILURE');
      return { exitCode: failing ? 1 : 0, stdout: JSON.stringify(this.checks), stderr: '' };
    }
    if (argv.includes('/pulls/7/comments')) return ok(JSON.stringify(this.comments));
    if (argv.includes('/pulls/7/reviews')) return ok('[]');
    if (argv.startsWith('gh run list')) return ok('[]');
    if (argv.startsWith('gh run view')) return ok('build failed: expected 1 to equal 2\n');
    return { exitCode: 1, stdout: '', stderr: `unrouted gh call: ${argv}` };
  }
}

/** A repository with one commit and a bare remote, so pushes really succeed. */
async function freshRepo(): Promise<{ root: string; remote: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-project-e2e-'));
  const remote = await mkdtemp(join(tmpdir(), 'dsh-project-e2e-remote-'));
  cleanups.push(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
  });
  const git = async (argv: string[], cwd = root): Promise<void> => {
    await run(argv[0] ?? 'git', argv.slice(1), { cwd });
  };
  await git(['git', 'init', '-b', 'main']);
  await git(['git', 'config', 'user.email', 'test@example.com']);
  await git(['git', 'config', 'user.name', 'Test']);
  await git(['git', 'config', 'commit.gpgsign', 'false']);
  await writeFile(join(root, 'README.md'), '# demo\n', 'utf8');
  await git(['git', 'add', '--all']);
  await git(['git', 'commit', '-m', 'init']);
  await git(['git', 'init', '--bare', '-b', 'main'], remote);
  await git(['git', 'remote', 'add', 'origin', remote]);
  await git(['git', 'push', '-u', 'origin', 'main']);
  return { root, remote };
}

describe('end-to-end project lifecycle', () => {
  let gitAvailable = true;
  before(async () => {
    try {
      await run('git', ['--version']);
    } catch {
      gitAvailable = false;
    }
  });

  it('runs goal -> threads -> shared memory -> CI heal -> review -> overview', async (t) => {
    if (!gitAvailable) return t.skip('git is not installed');
    const { root, remote } = await freshRepo();
    const runner = new HybridRunner();
    const threads = new FakeThreads();
    const clock = fixedClock();
    const engine = new ProjectEngine(root, { runner, threads, clock, ids: sequentialIds() });
    const detach = engine.attach();
    cleanups.push(async () => {
      detach();
    });
    const parent = { id: 'parent-session' };

    // ---- stage 1: a project record exists ------------------------------------------------
    await engine.init({ name: 'demo' });

    // ---- stage 2: the goal is split and one real branch per task ------------------------
    const goal = [
      'Ship the settings page',
      '- add the form',
      '- add validation',
    ].join('\n');
    const coordinated = await engine.coordinate(parent, goal, { limit: 4 });
    assert.equal(coordinated.started.length, 2, 'one thread per bullet');
    assert.equal(threads.launches.length, 2);
    // Each thread runs on its own branch, created in the real repository.
    const branches = await run('git', ['branch', '--list'], { cwd: root });
    for (const thread of coordinated.started) {
      assert.ok(thread.branch !== undefined, 'every thread records its branch');
      assert.match(branches.stdout, new RegExp(`${thread.branch}`.replace(/[/\\]/g, '\\$&')));
    }
    // The two branches are actually distinct — a shared branch is the failure this guards.
    assert.notEqual(coordinated.started[0]?.branch, coordinated.started[1]?.branch);
    // Every thread is told how to hand its work back.
    assert.ok(
      threads.launches.every(
        (launch) =>
          launch.prompt.includes('How to finish') && launch.prompt.includes('gh pr create'),
      ),
      'each thread is told to push and open a pull request',
    );

    // ---- stage 3: one global decision ---------------------------------------------------
    const written = await engine.setMemory(parent, {
      key: 'release-train',
      decision: 'Cut releases every second Tuesday; no hotfixes on Fridays.',
      rationale: 'Support is staffed thinly at the weekend.',
    });
    assert.equal(written.entry.revision, 1);
    // Both threads are still running, so both receive it immediately.
    assert.equal(written.broadcast.delivered.length, 2);
    assert.equal(threads.steers.length, 2);
    assert.ok(threads.steers.every((steer) => steer.text.includes('no hotfixes on Fridays')));

    // ---- stage 4: a future thread inherits it in its startup prefix ---------------------
    // Inheritance runs through the system-prompt charter, not the per-thread task message:
    // the charter is the byte-stable prefix every session shares, which is what lets the
    // provider reuse its KV cache across threads.
    const charter = await engine.renderCharter();
    assert.ok(charter.text.includes('release-train'), 'the charter carries the decision');
    assert.ok(charter.text.includes('no hotfixes on Fridays'));
    const later = await engine.coordinate(parent, '- add tests', { limit: 1 });
    assert.equal(later.started.length, 1);
    // A thread started after the decision still shares the same stable prefix.
    assert.equal((await engine.renderCharter()).text, charter.text, 'the prefix stayed stable');

    // ---- stage 5: thread finishes, delivers, CI fails, sweep heals ---------------------
    const first = coordinated.started[0];
    assert.ok(first !== undefined);
    assert.ok(first.worktreePath !== undefined, 'the thread got its own checkout');
    // Write into the thread's worktree, not the parent checkout: sharing one tree is exactly
    // the failure the isolation exists to prevent.
    await writeFile(join(first.worktreePath, 'form.ts'), 'export const form = 1;\n', 'utf8');
    // Hand the work back the way a thread would: commit, push, open the PR.
    const delivered = await engine.deliverThread(first.threadId, { message: 'feat: add the form' });
    assert.ok(delivered.prRef !== undefined);
    assert.equal((await engine.requireThread(first.threadId))?.status, 'awaiting_review');
    // The push really landed on the remote.
    const branch = first.branch;
    assert.ok(branch !== undefined);
    const remoteAfterDeliver = await run('git', ['branch', '--list'], { cwd: remote });
    assert.match(remoteAfterDeliver.stdout, new RegExp(branch.replace(/\//g, '\\/')));
    // And the parent checkout stayed on its own branch: delivering must not move it.
    const parentBranch = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root });
    assert.equal(parentBranch.stdout.trim(), 'main');

    threads.wake(first.childSessionId);
    threads.finish(first.childSessionId, {
      stopReason: 'completed',
      text: `Done. Opened ${delivered.prRef} for review.`,
    });
    await waitFor(async () => (await engine.requireThread(first.threadId))?.status === 'awaiting_review');

    // CI reports a failure on that PR.
    runner.checks = [{ name: 'test', state: 'FAILURE', link: 'https://ci/1' }];
    const healed = await engine.healSweep(parent);
    assert.equal(healed.healed.length, 1, 'the failing PR woke its thread');
    assert.equal(threads.resumes.length, 1);
    assert.ok(threads.resumes[0]?.text.includes('test'), 'the fix prompt names the failing check');
    assert.equal((await engine.requireThread(first.threadId))?.status, 'ci_fixing');

    // The thread pushes a fix and reports the same PR, so it goes back to awaiting review
    // and stays a heal candidate.
    threads.wake(first.childSessionId);
    threads.finish(first.childSessionId, {
      stopReason: 'completed',
      text: 'Fixed the assertion. Pushed to https://github.com/example/demo/pull/7.',
    });
    await waitFor(async () => (await engine.requireThread(first.threadId))?.status === 'awaiting_review');

    // ---- stage 6: a review comment wakes it again, then the PR merges ------------------
    runner.checks = [];
    runner.comments = [
      {
        id: 11,
        user: { login: 'reviewer' },
        body: 'Please rename this helper.',
        path: 'form.ts',
        line: 1,
        created_at: '2026-01-02T04:00:00Z',
      },
    ];
    const reviewed = await engine.healSweep(parent);
    assert.equal(reviewed.healed.length, 1, 'an unconsumed review comment wakes the thread');
    assert.ok(threads.resumes.length >= 2);
    assert.ok((await engine.requireThread(first.threadId))?.review?.consumedCommentIds.includes('11'));

    // A second sweep with nothing new must not wake anyone again.
    const idle = await engine.healSweep(parent);
    assert.equal(idle.healed.length, 0);

    runner.prState = 'merged';
    await engine.healSweep(parent);
    assert.equal((await engine.requireThread(first.threadId))?.status, 'completed');

    // ---- stage 7: the overview reports every bucket ------------------------------------
    const overview = await engine.overview();
    const json = await engine.overviewJson();
    assert.equal(json['quota'] ? true : false, true);
    const all = Object.values(overview.buckets).flat();
    assert.equal(all.length, coordinated.started.length + later.started.length);
    const markdown = renderOverviewMarkdown(overview);
    assert.match(markdown, new RegExp(`${overview.quota.created}/${overview.quota.max}`));
    // The completed thread is listed, and no child session id leaks into the human view.
    assert.match(markdown, /Ship the settings page|add the form/);
    for (const thread of all) {
      assert.ok(!markdown.includes(thread.childSessionId), 'session ids stay out of the panel');
    }

    // The real remote received the branches that were actually delivered.
    const remoteRefs = await run('git', ['branch', '--list'], { cwd: remote });
    assert.match(remoteRefs.stdout, /project\/demo/);
  });
});

/**
 * Poll until `predicate` is satisfied.
 *
 * Turn-end routing is driven by a listener that writes through an async store, so there is no
 * promise to await. Polling is the honest option: it either observes the write or fails, rather
 * than papering over a routing bug with a single `setImmediate`.
 */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('condition was never met');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
