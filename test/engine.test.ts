/**
 * Integration tests for the orchestration engine.
 *
 * These drive the real `ProjectEngine` over a real temporary directory, with the two
 * ports (`CommandRunner`, `ThreadRuntime`) faked. That combination is deliberate: the
 * manifest store's atomic rename and CAS loop only mean something on a real filesystem,
 * while git and subagents are exactly the parts that cannot run in a unit test.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

const test = it;

import type { ApprovalAction } from '../src/types.js';
import { ProjectEngine } from '../src/core/engine.js';
import { isProjectError } from '../src/core/errors.js';
import { RECENT_MESSAGE_LIMIT } from '../src/core/coordState.js';
import { renderOverviewMarkdown } from '../src/core/overview.js';
import { PROJECT_DIR } from '../src/core/manifest.js';
import { dayKey } from '../src/core/util.js';
import type { ProjectManifest } from '../src/types.js';
import { FakeRunner, FakeThreads, fixedClock, sequentialIds } from './helpers.js';

/** A parent stand-in; the engine only forwards it to the port. */
const PARENT = { id: 'parent-session' };

const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const cleanup of cleanups) await cleanup();
});

/** A temp directory removed after the suite. */
async function freshRoot(): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'dsh-project-engine-'));
  cleanups.push(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

/** Build an engine over a fresh temp root. */
async function harness(extra: { requireApprovalFor?: ApprovalAction[] } = {}): Promise<{
  engine: ProjectEngine;
  runner: FakeRunner;
  threads: FakeThreads;
  root: string;
  clock: ReturnType<typeof fixedClock>;
}> {
  const root = await freshRoot();
  const runner = new FakeRunner();
  const threads = new FakeThreads();
  const clock = fixedClock();
  const engine = new ProjectEngine(root, {
    runner,
    threads,
    clock,
    ids: sequentialIds(),
    quotaLedgerPath: join(root, 'quota-ledger.json'),
    ...(extra.requireApprovalFor === undefined ? {} : { requireApprovalFor: extra.requireApprovalFor }),
  });
  return { engine, runner, threads, root, clock };
}

/** A git repo that is authenticated to gh, so isolation takes the branch path. */
function repoReady(runner: FakeRunner): void {
  runner.on('git rev-parse --git-dir', { stdout: '.git\n' });
  runner.on('git rev-parse --show-toplevel', { stdout: '/tmp/demo\n' });
  runner.on('git rev-parse HEAD', { stdout: 'deadbeefcafe\n' });
  runner.on('git rev-parse --abbrev-ref', { stdout: 'main\n' });
  // Exit 1 = the branch does not exist yet, which is what `createBranch` probes for.
  // Answering 0 here would send it down the "reuse the existing branch" path and the
  // threads would silently share one branch instead of getting one each.
  runner.on('git rev-parse --verify', { exitCode: 1 });
  runner.on('gh --version', { stdout: 'gh version 2.40.0\n' });
  runner.on('gh auth status', { stdout: 'Logged in to github.com\n' });
  runner.on('git branch', { exitCode: 0 });
  runner.on('git status --porcelain', { stdout: '' });
  runner.on('git add', { exitCode: 0 });
  runner.on('git commit', { exitCode: 0 });
  runner.on('git push', { exitCode: 0 });
  runner.on('git worktree', { exitCode: 0 });
  // Diff for the Library: the branches these fixtures model changed nothing on their own.
  runner.on('git diff', { stdout: '' });
}

describe('init / deinit', () => {
  it('writes a manifest that a second engine can read back', async () => {
    const { engine, root } = await harness();
    const created = await engine.init({ name: 'demo' });
    assert.equal(created.name, 'demo');
    // `create` stamps revision 1: a freshly written record is version 1, not 0, so a
    // writer that reads it has a non-zero expectation to compare against.
    assert.equal(created.revision, 1);
    assert.equal(created.dailyThreadsCreated, 0);
    // Derived, not hard-coded: `dayKey` is a *local* calendar day, and the fixture clock
    // (2026-01-02T03:04:05Z) falls on 2026-01-01 anywhere behind UTC by more than three
    // hours. A literal here passes in Europe and fails in California.
    assert.equal(created.quotaDay, dayKey(fixedClock().now()));

    const reopened = new ProjectEngine(root, { runner: new FakeRunner(), threads: new FakeThreads(), clock: fixedClock(), quotaLedgerPath: join(root, 'quota-ledger.json') });
    const read = await reopened.requireManifest();
    assert.equal(read.projectId, created.projectId);
    assert.equal(read.name, 'demo');
  });

  it('refuses to overwrite an existing project', async () => {
    const { engine } = await harness();
    await engine.init();
    await assert.rejects(
      () => engine.init(),
      (error: unknown) => isProjectError(error) && error.code === 'INVALID_INPUT',
    );
  });

  it('reports NOT_INITIALIZED before init and after deinit', async () => {
    const { engine } = await harness();
    await assert.rejects(
      () => engine.requireManifest(),
      (error: unknown) => isProjectError(error) && error.code === 'PROJECT_NOT_INITIALIZED',
    );
    assert.equal(await engine.isInitialised(), false);
    await engine.init();
    assert.equal(await engine.isInitialised(), true);
    await engine.deinit();
    assert.equal(await engine.isInitialised(), false);
  });

  it('writes the shared-memory mirror so the project is readable without the plugin', async () => {
    const { engine, root } = await harness();
    await engine.init({ name: 'demo' });
    await engine.setMemory(undefined, { key: 'db', decision: 'use postgres' });
    const mirror = await readFile(`${root}/${PROJECT_DIR}/SHARED_MEMORY.md`, 'utf8');
    assert.match(mirror, /use postgres/);
  });

  it('keeps .dsh-project out of git by default', async () => {
    // The manifest is per-machine runtime state; committing it would hand every clone a
    // stale quota ledger and a set of thread descriptors pointing at sessions it does not have.
    const { engine, root } = await harness();
    await engine.init();
    const ignore = await readFile(`${root}/${PROJECT_DIR}/.gitignore`, 'utf8');
    assert.match(ignore, /manifest\.json/);
    assert.match(ignore, /SHARED_MEMORY\.md/);
  });
});

describe('setMemory / removeMemory', () => {
  it('bumps prefixVersion but not the store revision', async () => {
    const { engine } = await harness();
    await engine.init();
    const before = await engine.requireManifest();
    const { entry } = await engine.setMemory(undefined, { key: 'db', decision: 'postgres' });
    const after = await engine.requireManifest();
    assert.equal(entry.revision, 1);
    assert.equal(after.prefixVersion, before.prefixVersion + 1);
  });

  it('reports whether a removal actually removed something', async () => {
    const { engine } = await harness();
    await engine.init();
    await engine.setMemory(undefined, { key: 'db', decision: 'postgres' });
    assert.equal((await engine.removeMemory(undefined, 'db')).removed, true);
    assert.equal((await engine.removeMemory(undefined, 'db')).removed, false);
  });

  it('broadcasts to no one when the caller has no live threads', async () => {
    const { engine, threads } = await harness();
    await engine.init();
    const { broadcast } = await engine.setMemory(PARENT, { key: 'db', decision: 'postgres' });
    assert.deepEqual(broadcast, { delivered: [], skipped: [], failed: [] });
    assert.equal(threads.steers.length, 0);
  });
});

describe('coordinate', () => {
  it('starts one thread per planned task and persists a descriptor for each', async () => {
    const { engine, runner, threads } = await harness();
    await engine.init({ name: 'demo' });
    repoReady(runner);

    const result = await engine.coordinate(PARENT, '- add the form\n- wire persistence', { planOnly: false });
    assert.equal(result.started.length, 2);
    assert.equal(result.skipped.length, 0);
    assert.equal(threads.launches.length, 2);

    const manifest = await engine.requireManifest();
    assert.equal(Object.keys(manifest.threads).length, 2);
    for (const thread of result.started) {
      assert.equal(thread.status, 'running');
      assert.ok(thread.branch?.startsWith('project/demo/'));
      assert.ok(thread.childSessionId.length > 0);
    }
  });

  it('spends quota once per started thread', async () => {
    const { engine, runner } = await harness();
    await engine.init({ name: 'demo' });
    repoReady(runner);
    await engine.coordinate(PARENT, '- one\n- two\n- three', { planOnly: false });
    const manifest = await engine.requireManifest();
    assert.equal(manifest.dailyThreadsCreated, 3);
  });

  it('gives back the reservation for a task that failed to start', async () => {
    // Otherwise a flaky launch quietly eats the day's budget.
    const { engine, runner, threads } = await harness();
    await engine.init({ name: 'demo' });
    repoReady(runner);
    threads.failNextLaunch = 'provider unavailable';
    const result = await engine.coordinate(PARENT, '- one\n- two', { planOnly: false });
    assert.equal(result.started.length, 1);
    assert.equal(result.skipped.length, 1);
    const manifest = await engine.requireManifest();
    assert.equal(manifest.dailyThreadsCreated, 1, 'the failed task must not keep its reservation');
  });

  it('refuses the whole batch when the quota cannot cover it', async () => {
    const { engine, runner } = await harness();
    await engine.init({ name: 'demo', dailyThreadQuotaMax: 2 });
    repoReady(runner);
    await assert.rejects(
      () => engine.coordinate(PARENT, '- one\n- two\n- three', { planOnly: false }),
      (error: unknown) => isProjectError(error) && error.code === 'QUOTA_EXCEEDED',
    );
    const manifest = await engine.requireManifest();
    assert.equal(manifest.dailyThreadsCreated, 0, 'a rejected batch must not spend');
    assert.equal(Object.keys(manifest.threads).length, 0);
  });

  it('counts two projects against one user-wide ceiling', async () => {
    // GAP-01. The enforced quota is "200 new threads per day across your projects", so two
    // projects must not get two budgets. Both engines point at one ledger, which is what
    // happens in production: the ledger lives outside any project root.
    const ledger = join(await freshRoot(), 'shared-ledger.json');
    const build = async (): Promise<{ engine: ProjectEngine; runner: FakeRunner }> => {
      const root = await freshRoot();
      const runner = new FakeRunner();
      const engine = new ProjectEngine(root, {
        runner,
        threads: new FakeThreads(),
        clock: fixedClock(),
        ids: sequentialIds(),
        quotaLedgerPath: ledger,
      });
      return { engine, runner };
    };

    const first = await build();
    await first.engine.init({ name: 'one' });
    repoReady(first.runner);
    const started = await first.engine.coordinate(PARENT, '- a\n- b\n- c', { planOnly: false });
    assert.equal(started.started.length, 3);
    assert.equal(started.quota.global?.created, 3);

    const second = await build();
    await second.engine.init({ name: 'two' });
    repoReady(second.runner);
    const also = await second.engine.coordinate(PARENT, '- d', { planOnly: false });
    // The second project's own counter starts at zero, but the shared one carries on.
    assert.equal((await second.engine.requireManifest()).dailyThreadsCreated, 1);
    assert.equal(also.quota.global?.created, 4);
  });

  it('refuses a batch the shared ceiling cannot cover, and spends nothing', async () => {
    const ledger = join(await freshRoot(), 'full-ledger.json');
    // Fill the day from somewhere else entirely, then ask this project for one more.
    const { GLOBAL_DAILY_THREAD_LIMIT, QuotaLedger } = await import('../src/core/quotaLedger.js');
    await new QuotaLedger(ledger).reserve('someone-else', GLOBAL_DAILY_THREAD_LIMIT, fixedClock().now());

    const root = await freshRoot();
    const runner = new FakeRunner();
    const engine = new ProjectEngine(root, {
      runner,
      threads: new FakeThreads(),
      clock: fixedClock(),
      ids: sequentialIds(),
      quotaLedgerPath: ledger,
    });
    await engine.init({ name: 'demo' });
    repoReady(runner);
    await assert.rejects(
      () => engine.coordinate(PARENT, '- one', { planOnly: false }),
      (error: unknown) => isProjectError(error) && error.code === 'QUOTA_EXCEEDED',
    );
    const manifest = await engine.requireManifest();
    assert.equal(manifest.dailyThreadsCreated, 0, 'a batch refused by the shared ledger must not dent the project');
    assert.equal(Object.keys(manifest.threads).length, 0);
  });

  it('refunds the shared ledger when the per-project preference refuses the batch', async () => {
    // Ordering matters here: the shared ledger is reserved first, so a refusal from the
    // project's own ceiling has to hand that reservation back or the user's day leaks.
    const ledger = join(await freshRoot(), 'refund-ledger.json');
    const root = await freshRoot();
    const runner = new FakeRunner();
    const engine = new ProjectEngine(root, {
      runner,
      threads: new FakeThreads(),
      clock: fixedClock(),
      ids: sequentialIds(),
      quotaLedgerPath: ledger,
    });
    await engine.init({ name: 'demo', dailyThreadQuotaMax: 2 });
    repoReady(runner);
    await assert.rejects(() => engine.coordinate(PARENT, '- one\n- two\n- three', { planOnly: false }));
    const { QuotaLedger } = await import('../src/core/quotaLedger.js');
    const after = await new QuotaLedger(ledger).snapshot('any', fixedClock().now());
    assert.equal(after.created, 0, 'the global reservation must be refunded');
  });

  it('gives back the shared reservation for a task that failed to start', async () => {
    const ledger = join(await freshRoot(), 'leak-ledger.json');
    const root = await freshRoot();
    const runner = new FakeRunner();
    const threads = new FakeThreads();
    const engine = new ProjectEngine(root, {
      runner,
      threads,
      clock: fixedClock(),
      ids: sequentialIds(),
      quotaLedgerPath: ledger,
    });
    await engine.init({ name: 'demo' });
    repoReady(runner);
    threads.failNextLaunch = 'provider unavailable';
    const result = await engine.coordinate(PARENT, '- one\n- two', { planOnly: false });
    assert.equal(result.started.length, 1);
    assert.equal(result.quota.global?.created, 1, 'the failed task must not keep its shared reservation');
  });

  it('honours the limit without planning more work than it starts', async () => {
    const { engine, runner } = await harness();
    await engine.init({ name: 'demo' });
    repoReady(runner);
    const result = await engine.coordinate(PARENT, '- one\n- two\n- three', { limit: 2, planOnly: false });
    assert.equal(result.started.length, 2);
    assert.equal(result.planned.length, 2);
  });

  it('falls back to scope isolation when the root is not a git repo', async () => {
    const { engine, threads } = await harness();
    await engine.init({ name: 'demo' });
    // Nothing routed: every probe fails, so inspectRepo reports "not a repo".
    const result = await engine.coordinate(PARENT, '- one\n- two', { planOnly: false });
    assert.equal(result.started.length, 2);
    assert.equal(threads.launches.length, 2);
    for (const thread of result.started) {
      assert.equal(thread.branch, undefined);
      assert.ok(thread.branchOrScope.length > 0);
    }
  });

  it('fails loudly when no thread runtime is available', async () => {
    const { UnavailableThreadRuntime } = await import('../src/core/threads.js');
    const unavailableRoot = await freshRoot();
    const unavailable = new ProjectEngine(unavailableRoot, {
      runner: new FakeRunner(),
      threads: new UnavailableThreadRuntime('no subagents here'),
      clock: fixedClock(),
      quotaLedgerPath: join(unavailableRoot, 'quota-ledger.json'),
    });
    await unavailable.init();
    await assert.rejects(
      () => unavailable.coordinate(PARENT, '- one\n- two', { planOnly: false }),
      (error: unknown) => isProjectError(error) && error.code === 'SPAWN_FAILED',
    );
  });

  it('rejects a goal that produces no tasks', async () => {
    const { engine } = await harness();
    await engine.init();
    await assert.rejects(
      () => engine.coordinate(PARENT, '   ', { planOnly: false }),
      (error: unknown) => isProjectError(error) && error.code === 'INVALID_INPUT',
    );
  });

  it('passes the shared charter and memory keys into the thread prompt', async () => {
    const { engine, runner, threads } = await harness();
    await engine.init({ name: 'demo' });
    repoReady(runner);
    await engine.setMemory(undefined, { key: 'db', decision: 'use postgres' });
    await engine.coordinate(PARENT, '- one\n- two', { memoryKeys: ['db'], planOnly: false });
    assert.equal(threads.launches.length, 2);
    for (const launch of threads.launches) {
      assert.match(launch.prompt, /branch|scope/i);
    }
  });
});

/**
 * Poll until `predicate` returns a value.
 *
 * Turn-end routing is fired from a listener and writes through the async manifest store,
 * so there is no promise to await. Polling with a deadline is honest about that: it either
 * observes the write or fails, and it never hides a routing bug behind one `setImmediate`.
 */
async function eventually<T>(predicate: () => Promise<T | undefined>, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('condition was never met');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Read one thread descriptor by child session id. */
async function threadByChild(engine: ProjectEngine, childSessionId: string) {
  const manifest = await engine.requireManifest();
  return Object.values(manifest.threads).find((thread) => thread.childSessionId === childSessionId);
}

describe('turn-end routing', () => {
  it('moves a thread to review when its closing message names a pull request', async () => {
    const { engine, runner, threads } = await harness();
    await engine.init({ name: 'demo' });
    repoReady(runner);
    engine.attach();
    const result = await engine.coordinate(PARENT, '- one\n- two', { planOnly: false });
    const child = result.started[0]?.childSessionId ?? '';
    threads.finish(child, {
      stopReason: 'completed',
      text: 'Opened https://github.com/o/r/pull/12 for review.',
    });
    const updated = await eventually(async () => {
      const thread = await threadByChild(engine, child);
      return thread?.status === 'awaiting_review' ? thread : undefined;
    });
    assert.equal(updated.prOrDeliverableRef, 'https://github.com/o/r/pull/12');
  });

  it('asks for feedback when a thread finishes without delivering anything', async () => {
    // Marking this "completed" would claim a deliverable the user cannot find.
    const { engine, runner, threads } = await harness();
    await engine.init({ name: 'demo' });
    repoReady(runner);
    engine.attach();
    const result = await engine.coordinate(PARENT, '- one\n- two', { planOnly: false });
    const child = result.started[0]?.childSessionId ?? '';
    threads.finish(child, { stopReason: 'completed', text: 'All done, tests pass.' });
    const updated = await eventually(async () => {
      const thread = await threadByChild(engine, child);
      return thread?.status === 'needs_feedback' ? thread : undefined;
    });
    assert.match(updated.feedbackPrompt ?? '', /deliver/);
  });

  it('marks a thread failed when the child errors', async () => {
    const { engine, runner, threads } = await harness();
    await engine.init({ name: 'demo' });
    repoReady(runner);
    engine.attach();
    const result = await engine.coordinate(PARENT, '- one\n- two', { planOnly: false });
    const child = result.started[0]?.childSessionId ?? '';
    threads.finish(child, { stopReason: 'error', text: '', diagnostic: 'model exploded' });
    const updated = await eventually(async () => {
      const thread = await threadByChild(engine, child);
      return thread?.status === 'failed' ? thread : undefined;
    });
    assert.equal(updated.lastError, 'model exploded');
  });

  it('returns an interrupted thread to the queue rather than failing it', async () => {
    const { engine, runner, threads } = await harness();
    await engine.init({ name: 'demo' });
    repoReady(runner);
    engine.attach();
    const result = await engine.coordinate(PARENT, '- one\n- two', { planOnly: false });
    const child = result.started[0]?.childSessionId ?? '';
    threads.finish(child, { stopReason: 'aborted', text: '' });
    const updated = await eventually(async () => {
      const thread = await threadByChild(engine, child);
      return thread?.status === 'queued' ? thread : undefined;
    });
    assert.match(updated.lastError ?? '', /interrupted/);
  });

  it('ignores a turn end for a session it never launched', async () => {
    // Another project's thread, or a leftover from a previous process. Guessing a
    // descriptor would corrupt state.
    const { engine, threads } = await harness();
    await engine.init();
    engine.attach();
    threads.finish('child-unknown', { stopReason: 'completed', text: 'x' });
    await new Promise((resolve) => setImmediate(resolve));
    const manifest = await engine.requireManifest();
    assert.equal(Object.keys(manifest.threads).length, 0);
  });

  it('stops routing once detached', async () => {
    const { engine, runner, threads } = await harness();
    await engine.init({ name: 'demo' });
    repoReady(runner);
    const detach = engine.attach();
    const result = await engine.coordinate(PARENT, '- one\n- two', { planOnly: false });
    detach();
    threads.finish(result.started[0]?.childSessionId ?? '', { stopReason: 'completed', text: 'x' });
    await new Promise((resolve) => setImmediate(resolve));
    const manifest = await engine.requireManifest();
    const thread = Object.values(manifest.threads)[0];
    assert.equal(thread?.status, 'running', 'a disposed plugin must not keep mutating the project');
  });
});

describe('manageThread', () => {
  it('steers a busy thread and records the message', async () => {
    const { engine, runner, threads } = await harness();
    await engine.init({ name: 'demo' });
    repoReady(runner);
    const result = await engine.coordinate(PARENT, '- one\n- two', { planOnly: false });
    const id = result.started[0]?.threadId ?? '';
    await engine.manageThread(PARENT, id, 'steer', 'also handle the empty case');
    assert.equal(threads.steers.length, 1);
    assert.match(threads.steers[0]?.text ?? '', /empty case/);
  });

  it('rejects steering without a message', async () => {
    const { engine, runner } = await harness();
    await engine.init({ name: 'demo' });
    repoReady(runner);
    const result = await engine.coordinate(PARENT, '- one\n- two', { planOnly: false });
    await assert.rejects(
      () => engine.manageThread(PARENT, result.started[0]?.threadId ?? '', 'steer', ''),
      (error: unknown) => isProjectError(error) && error.code === 'INVALID_INPUT',
    );
  });

  it('reports an unknown thread id rather than silently doing nothing', async () => {
    const { engine } = await harness();
    await engine.init();
    await assert.rejects(
      () => engine.manageThread(PARENT, 'thr-missing', 'inspect', undefined),
      (error: unknown) => isProjectError(error) && error.code === 'THREAD_NOT_FOUND',
    );
  });

  it('interrupts a running thread and leaves it failed-free', async () => {
    const { engine, runner, threads } = await harness();
    await engine.init({ name: 'demo' });
    repoReady(runner);
    const result = await engine.coordinate(PARENT, '- one\n- two', { planOnly: false });
    const id = result.started[0]?.threadId ?? '';
    const child = result.started[0]?.childSessionId ?? '';
    await engine.manageThread(PARENT, id, 'interrupt', undefined);
    assert.deepEqual(threads.interrupts, [child]);
  });

  it('closes a thread without pretending it succeeded', async () => {
    const { engine, runner } = await harness();
    await engine.init({ name: 'demo' });
    repoReady(runner);
    const result = await engine.coordinate(PARENT, '- one\n- two', { planOnly: false });
    const id = result.started[0]?.threadId ?? '';
    const closed = await engine.manageThread(PARENT, id, 'close', undefined);
    // `completed` means the work is done and nothing is pending; a thread the user closed
    // is out of the way, which is what `resolved` says. Reusing `completed` would also
    // leave it in the Idle bucket forever instead of hiding it.
    assert.equal(closed.thread.status, 'resolved');
    const closedOverview = await engine.overview();
    assert.equal(closedOverview.buckets.resolved.length, 0, 'resolved threads are hidden by default');
    assert.equal(closedOverview.totals.resolved, 1);
  });
  it('reopens a resolved thread into the bucket its evidence supports', async () => {
    const { engine, runner } = await harness();
    await engine.init({ name: 'demo' });
    repoReady(runner);
    const result = await engine.coordinate(PARENT, '- one', { planOnly: false });
    const id = result.started[0]?.threadId ?? '';
    await engine.manageThread(PARENT, id, 'close', undefined);
    const reopened = await engine.manageThread(PARENT, id, 'reopen', undefined);
    // No pull request was ever recorded, so there is nothing for a reviewer to look at:
    // the thread goes back to Idle rather than claiming it is awaiting review.
    assert.equal(reopened.thread.status, 'completed');
  });

  it('resolves a silent thread after a week and says why', async () => {
    const { engine, runner, clock } = await harness();
    await engine.init({ name: 'demo' });
    repoReady(runner);
    await engine.coordinate(PARENT, '- one', { planOnly: false });
    runner.on('gh pr view', { exitCode: 1, stderr: 'no pull requests found' });
    clock.advance(8 * 24 * 60 * 60 * 1000);
    const swept = await engine.healSweep(PARENT, new AbortController().signal);
    assert.equal(swept.resolved, 1);
    assert.equal((await engine.overview()).totals.resolved, 1);
  });
});

describe('state publishing', () => {
  it('publishes a snapshot to the session that drove the project', async () => {
    const { engine, runner } = await harness();
    await engine.init({ name: 'demo' });
    repoReady(runner);
    const published: Array<{ sessionId: string; revision: number }> = [];
    engine.setStatePublisher((sessionId, snapshot) => {
      published.push({ sessionId, revision: snapshot.revision });
    });
    await engine.coordinate(PARENT, '- one', { planOnly: false });
    // Publishing is fire-and-forget behind the write it describes, so wait for it rather
    // than asserting synchronously: a synchronous assertion would test the timer, not the
    // wiring.
    await eventually(async () => (published.length > 0 ? published : undefined));
    assert.equal(published[0]?.sessionId, (PARENT as { id: string }).id);
    assert.ok((published[0]?.revision ?? 0) > 0);
  });

  it('records the caller as a coordinator, and only once', async () => {
    const { engine, runner } = await harness();
    await engine.init({ name: 'demo' });
    repoReady(runner);
    await engine.coordinate(PARENT, '- one', { planOnly: false });
    await engine.overview();
    await engine.coordinate(PARENT, '- two', { planOnly: false });
    assert.deepEqual([...engine.coordinatorSessions()], [(PARENT as { id: string }).id]);
  });

  it('publishes nothing when no publisher is installed', async () => {
    const { engine, runner } = await harness();
    await engine.init({ name: 'demo' });
    repoReady(runner);
    // The point is that the write path does not depend on a panel: a project driven by a
    // headless session must behave identically.
    const result = await engine.coordinate(PARENT, '- one', { planOnly: false });
    assert.equal(result.started.length, 1);
  });
});

describe('overview / charter', () => {
  it('renders an overview from the persisted manifest', async () => {
    const { engine, runner } = await harness();
    await engine.init({ name: 'demo' });
    repoReady(runner);
    await engine.coordinate(PARENT, '- one\n- two', { planOnly: false });
    const overview = await engine.overview();
    assert.equal(overview.name, 'demo');
    assert.equal(overview.totals.threads, 2);
    assert.equal(overview.buckets.working.length, 2);
  });

  it('exposes the same overview as a plain JSON tool payload', async () => {
    const { engine, runner } = await harness();
    await engine.init({ name: 'demo' });
    repoReady(runner);
    await engine.coordinate(PARENT, '- one\n- two', { planOnly: false });
    const payload = await engine.overviewJson();
    assert.equal(payload['name'], 'demo');
    assert.equal((payload['totals'] as { threads: number }).threads, 2);
  });

  it('renders a charter that is byte-identical across calls', async () => {
    // This stability is the whole reason the charter lives in a fixed prompt section:
    // a single varying byte invalidates the provider's prefix cache for every thread.
    const { engine } = await harness();
    await engine.init({ name: 'demo' });
    await engine.setMemory(undefined, { key: 'db', decision: 'postgres' });
    await engine.renderCharter();
    const first = engine.cachedCharter();
    await engine.renderCharter();
    assert.equal(engine.cachedCharter(), first);
    assert.ok(first.length > 0);
  });

  it('changes the charter when a shared decision changes', async () => {
    const { engine } = await harness();
    await engine.init({ name: 'demo' });
    await engine.renderCharter();
    const before = engine.cachedCharter();
    await engine.setMemory(undefined, { key: 'db', decision: 'sqlite' });
    await engine.renderCharter();
    assert.notEqual(engine.cachedCharter(), before);
    assert.match(engine.cachedCharter(), /sqlite/);
  });

  it('starts with an empty charter before the first render', async () => {
    // The prompt section reads synchronously, so the very first assembly of a session has
    // nothing cached yet. Empty is correct: it costs one step, not one session.
    const { engine } = await harness();
    await engine.init();
    assert.equal(engine.cachedCharter(), '');
  });
});

describe('repository conventions', () => {
  it('puts a root CLAUDE.md into the shared charter', async () => {
    // Official: the three root locations are "loaded from every repository when the thread
    // starts". The charter is where a thread reads standing instructions before its task.
    const { engine, root } = await harness();
    await engine.init({ name: 'demo' });
    await writeFile(join(root, 'CLAUDE.md'), 'Always run the type checker before committing.', 'utf8');
    await engine.renderCharter();
    assert.match(engine.cachedCharter(), /## Repository conventions/);
    assert.match(engine.cachedCharter(), /Always run the type checker before committing\./);
  });

  it('ignores a nested CLAUDE.md', async () => {
    const { engine, root } = await harness();
    await engine.init({ name: 'demo' });
    await mkdir(join(root, 'packages', 'api'), { recursive: true });
    await writeFile(join(root, 'packages', 'api', 'CLAUDE.md'), 'nested only', 'utf8');
    await engine.renderCharter();
    assert.doesNotMatch(engine.cachedCharter(), /nested only/);
  });

  it('picks up an edited convention file on the next render', async () => {
    // No watcher: the stamp is size+mtime, so an edit is visible one render later and an
    // unchanged repository costs nothing.
    const { engine, root } = await harness();
    await engine.init({ name: 'demo' });
    await writeFile(join(root, 'CLAUDE.md'), 'use tabs', 'utf8');
    await engine.renderCharter();
    assert.match(engine.cachedCharter(), /use tabs/);
    await writeFile(join(root, 'CLAUDE.md'), 'use two spaces', 'utf8');
    await engine.renderCharter();
    assert.match(engine.cachedCharter(), /use two spaces/);
    assert.doesNotMatch(engine.cachedCharter(), /use tabs/);
  });

  it('reads rules files and sorts them', async () => {
    const { engine, root } = await harness();
    await engine.init({ name: 'demo' });
    await mkdir(join(root, '.claude', 'rules'), { recursive: true });
    await writeFile(join(root, '.claude', 'rules', 'b.md'), 'rule B', 'utf8');
    await writeFile(join(root, '.claude', 'rules', 'a.md'), 'rule A', 'utf8');
    await engine.renderCharter();
    const text = engine.cachedCharter();
    assert.ok(text.indexOf('rule A') < text.indexOf('rule B'));
  });

  it('keeps the charter stable when conventions did not change', async () => {
    const { engine, root } = await harness();
    await engine.init({ name: 'demo' });
    await writeFile(join(root, 'CLAUDE.md'), 'stable text', 'utf8');
    await engine.renderCharter();
    const first = engine.cachedCharter();
    await engine.renderCharter();
    assert.equal(engine.cachedCharter(), first);
  });
});

describe('goal and recent messages', () => {
  it('persists a goal given at init and reads it back from another engine', async () => {
    // Acceptance for GAP-06: the goal must survive the session, because a fresh coordinator
    // has no transcript to recover it from.
    const { engine, root, runner, threads, clock } = await harness();
    await engine.init({ name: 'demo', goal: 'ship the beta' });
    const reopened = new ProjectEngine(root, {
      runner,
      threads,
      clock,
      ids: sequentialIds(),
      quotaLedgerPath: join(root, 'quota-ledger.json'),
    });
    assert.equal(await reopened.goal(), 'ship the beta');
  });

  it('normalises the goal to one line', async () => {
    const { engine } = await harness();
    await engine.init({ name: 'demo' });
    const result = await engine.setGoal('  ship   the\n  beta ');
    assert.equal(result.goal, 'ship the beta');
    assert.equal(result.changed, true);
  });

  it('reports no change when the goal is set to the same value', async () => {
    const { engine } = await harness();
    await engine.init({ name: 'demo', goal: 'ship it' });
    const result = await engine.setGoal('ship it');
    assert.equal(result.changed, false);
  });

  it('renders the goal into the charter and leaves it out when unset', async () => {
    const { engine } = await harness();
    await engine.init({ name: 'demo' });
    await engine.renderCharter();
    assert.doesNotMatch(engine.cachedCharter(), /## Project goal/);
    await engine.setGoal('ship the beta');
    assert.match(engine.cachedCharter(), /ship the beta/);
  });

  it('keeps the charter byte-identical when only recent messages change', async () => {
    // The charter is the prefix every thread shares; if a coordinator message moved into it,
    // every turn would re-cost the provider's cache for all sessions.
    const { engine, runner } = await harness();
    await engine.init({ name: 'demo', goal: 'ship it' });
    repoReady(runner);
    await engine.renderCharter();
    const before = engine.cachedCharter();
    await engine.setMemory(undefined, { key: 'db', decision: 'postgres' });
    await engine.renderCharter();
    const afterMemory = engine.cachedCharter();
    assert.notEqual(afterMemory, before);
    // A message-only change must not touch the prefix.
    const messagesBefore = await engine.recentMessages();
    assert.ok(messagesBefore.length > 0);
    await engine.renderCharter();
    assert.equal(engine.cachedCharter(), afterMemory);
  });

  it('records what the coordinator did, bounded', async () => {
    const { engine, runner } = await harness();
    await engine.init({ name: 'demo' });
    repoReady(runner);
    await engine.coordinate(PARENT, '- one\n- two', { planOnly: false });
    await engine.setMemory(undefined, { key: 'db', decision: 'sqlite' });
    const recent = await engine.recentMessages();
    assert.ok(recent.length >= 2);
    assert.ok(recent.some((message) => message.text.includes('started 2/2 thread')));
    assert.ok(recent.some((message) => message.text.includes('memory db')));
    assert.ok(recent.length <= RECENT_MESSAGE_LIMIT);
  });

  it('surfaces the goal and the recent messages through the overview payload', async () => {
    const { engine } = await harness();
    await engine.init({ name: 'demo', goal: 'ship it' });
    await engine.setMemory(undefined, { key: 'db', decision: 'sqlite' });
    const payload = await engine.overviewJson();
    assert.equal(payload['goal'], 'ship it');
    assert.ok(Array.isArray(payload['recentMessages']));
    assert.ok((payload['recentMessages'] as unknown[]).length > 0);
  });

  it('prints the goal exactly once in the markdown panel', async () => {
    // A duplicated line got in through a scripted edit; asserting the count keeps it out.
    const { engine } = await harness();
    await engine.init({ name: 'demo', goal: 'ship it' });
    const markdown = renderOverviewMarkdown(await engine.overview());
    assert.equal(markdown.match(/- goal:/g)?.length, 1);
  });
});

describe('manifest durability', () => {
  it('survives a concurrent update from two engines on one root', async () => {
    // The store serialises within a process and uses revision CAS across reloads; a lost
    // write here would silently drop a thread descriptor.
    const { engine, root } = await harness();
    await engine.init();
    const second = new ProjectEngine(root, { runner: new FakeRunner(), threads: new FakeThreads(), clock: fixedClock(), quotaLedgerPath: join(root, 'quota-ledger.json') });
    await engine.setMemory(undefined, { key: 'a', decision: 'first' });
    const merged: ProjectManifest = await second.requireManifest();
    assert.equal(merged.memories['a']?.decision, 'first');
  });

  it('reports STALE_REVISION when a writer holds an outdated copy', async () => {
    const { engine } = await harness();
    await engine.init();
    await engine.setMemory(undefined, { key: 'a', decision: 'first' });
    const snapshot = await engine.store.read();
    await engine.setMemory(undefined, { key: 'b', decision: 'second' });
    await assert.rejects(
      () => engine.store.writeAtomic(snapshot.manifest, snapshot.version),
      (error: unknown) => isProjectError(error) && error.code === 'STALE_REVISION',
    );
    // The newer write must survive: a rejected CAS must not clobber it.
    const manifest = await engine.requireManifest();
    assert.equal(manifest.memories['b']?.decision, 'second');
  });

  it('accepts a CAS write whose expected version still matches', async () => {
    const { engine } = await harness();
    await engine.init();
    const snapshot = await engine.store.read();
    await engine.store.writeAtomic({ ...snapshot.manifest, name: 'renamed' }, snapshot.version);
    assert.equal((await engine.requireManifest()).name, 'renamed');
  });
});

describe('pause', () => {
  test('refuses to start work, sweep, or deliver while paused, and says so', async () => {
    const { engine, runner, threads } = await harness();
    repoReady(runner);
    await engine.init({ name: 'demo' });
    const paused = await engine.pause(PARENT, 'machine is busy');
    assert.equal(paused.interrupted.length, 0);

    await assert.rejects(
      () => engine.coordinate(PARENT, '- one'),
      (error: unknown) => isProjectError(error) && error.code === 'PROJECT_PAUSED',
    );
    // The message has to name the way out: "paused" alone leaves the reader stuck.
    await assert.rejects(
      () => engine.coordinate(PARENT, '- one'),
/\/project resume/,

    );
    const swept = await engine.healSweep(PARENT);
    assert.equal(swept.observed, 0);
    assert.equal(swept.paused, 'machine is busy');
    await assert.rejects(
      () => engine.deliverThread('thr-1'),
      (error: unknown) => isProjectError(error) && error.code === 'PROJECT_PAUSED',
    );
    assert.equal(threads.launches.length, 0);
  });

  test('interrupts live threads and keeps them resumable', async () => {
    const { engine, runner, threads } = await harness();
    repoReady(runner);
    await engine.init({ name: 'demo' });
    const plan = await engine.coordinate(PARENT, ['- one', '- two'].join('\n'), { planOnly: false });
    assert.equal(threads.launches.length, 2);

    const paused = await engine.pause(PARENT);
    assert.deepEqual(paused.interrupted, plan.started.map((thread) => thread.threadId));
    assert.deepEqual(threads.interrupts, plan.started.map((thread) => thread.childSessionId));

    // Interrupting is not failing: the record keeps the thread and it can be retried.
    const thread = await engine.requireThread(plan.started[0]?.threadId ?? '');
    assert.ok(thread.status !== 'failed');
    const retried = await engine.resume(PARENT);
    assert.equal(retried.wasPaused, true);
    await engine.manageThread(PARENT, thread.threadId, 'retry', undefined);
    assert.equal(threads.resumes.length, 1);
  });

  test('survives a restart, and resuming an unpaused project is a no-op', async () => {
    const root = await freshRoot();
    const first = new ProjectEngine(root, {
      runner: new FakeRunner(),
      threads: new FakeThreads(),
      clock: fixedClock(),
      ids: sequentialIds(),
      quotaLedgerPath: join(root, 'quota-ledger.json'),
    });
    await first.init({ name: 'demo' });
    assert.equal((await first.resume()).wasPaused, false);
    await first.pause(PARENT, 'overnight');

    const second = new ProjectEngine(root, {
      runner: new FakeRunner(),
      threads: new FakeThreads(),
      clock: fixedClock(),
      ids: sequentialIds(),
      quotaLedgerPath: join(root, 'quota-ledger.json'),
    });
    // The pause is a record, not a flag in memory: a restart must not quietly resume.
    assert.deepEqual(await second.paused(), { since: fixedClock().now(), reason: 'overnight' });
    await assert.rejects(
      () => second.coordinate(PARENT, '- one'),
      (error: unknown) => isProjectError(error) && error.code === 'PROJECT_PAUSED',
    );
  });

  test('still allows reading and closing while paused', async () => {
    const { engine, runner } = await harness();
    repoReady(runner);
    await engine.init({ name: 'demo' });
    const plan = await engine.coordinate(PARENT, '- one', { planOnly: false });
    const threadId = plan.started[0]?.threadId ?? '';
    await engine.pause(PARENT);

    const overview = await engine.overviewJson();
    assert.deepEqual(overview['paused'], { since: fixedClock().now() });
    await engine.manageThread(PARENT, threadId, 'inspect', undefined);
    // A user pausing the machine should still be able to tidy up; closing is their call.
    const closed = await engine.manageThread(PARENT, threadId, 'close', 'tidying up');
    assert.equal(closed.thread.status, 'resolved');
  });
});

describe('deliverThread', () => {
  /** A project with one started thread, ready to deliver. */
  async function deliverable(): Promise<{
    engine: ProjectEngine;
    runner: FakeRunner;
    threadId: string;
  }> {
    const { engine, runner } = await harness();
    await engine.init({ name: 'demo' });
    repoReady(runner);
    const result = await engine.coordinate(PARENT, '- one\n- two', { planOnly: false });
    const threadId = result.started[0]?.threadId ?? '';
    return { engine, runner, threadId };
  }

  it('commits nothing and says so when the worktree is clean', async () => {
    // Claiming a delivery here would fabricate a PR for a thread that changed no files.
    const { engine, runner, threadId } = await deliverable();
    runner.on('git status --porcelain', { stdout: '' });
    const result = await engine.deliverThread(threadId);
    assert.equal(result.prRef, undefined);
    assert.equal(result.message, 'nothing to commit');
    assert.equal(runner.saw('git push'), false);
  });

  it('pushes the branch and records the pull request it opened', async () => {
    const { engine, runner, threadId } = await deliverable();
    runner.on('git status --porcelain', { stdout: ' M src/a.ts\n' });
    runner.on('git commit', { stdout: '[project/demo/1-one abc1234] one\n' });
    runner.on('git push', { exitCode: 0 });
    runner.on('gh pr create', { stdout: 'https://github.com/o/r/pull/7\n' });
    runner.on('gh pr view', {
      stdout: JSON.stringify({
        number: 7,
        url: 'https://github.com/o/r/pull/7',
        state: 'OPEN',
        isDraft: false,
        headRefName: 'project/demo/1-one',
        reviewDecision: '',
        mergeable: 'MERGEABLE',
      }),
    });
    const result = await engine.deliverThread(threadId);
    assert.equal(result.thread.status, 'awaiting_review');
    assert.match(result.prRef ?? '', /\/pull\/7$/);
    assert.equal(result.thread.prOrDeliverableRef, result.prRef);
  });

  it('records a completion without a PR when the thread has no branch', async () => {
    // Scope-only isolation has nothing to push, so the honest outcome is a commit,
    // not a pull request against a branch that does not exist.
    const { engine, runner } = await harness();
    await engine.init({ name: 'demo' });
    runner.on('git status --porcelain', { stdout: ' M src/a.ts\n' });
    runner.on('git add', { exitCode: 0 });
    runner.on('git commit', { stdout: '[main abc1234] one\n' });
    runner.on('git rev-parse HEAD', { stdout: 'abc1234\n' });
    const result = await engine.coordinate(PARENT, '- one\n- two', { planOnly: false });
    const threadId = result.started[0]?.threadId ?? '';
    const delivered = await engine.deliverThread(threadId);
    assert.equal(delivered.prRef, undefined);
    assert.equal(delivered.thread.status, 'completed');
    assert.equal(runner.saw('gh pr create'), false);
  });

  it('fails loudly when the push is rejected', async () => {
    const { engine, runner, threadId } = await deliverable();
    runner.on('git status --porcelain', { stdout: ' M src/a.ts\n' });
    runner.on('git commit', { stdout: '[project/demo/1-one abc1234] one\n' });
    runner.on('git push', { exitCode: 1, stderr: 'rejected: non-fast-forward\n' });
    await assert.rejects(
      () => engine.deliverThread(threadId),
      (error: unknown) => isProjectError(error) && error.code === 'VCS_FAILED',
    );
  });

  it('surfaces the reason gh refused to open the pull request', async () => {
    const { engine, runner, threadId } = await deliverable();
    runner.on('git status --porcelain', { stdout: ' M src/a.ts\n' });
    runner.on('git commit', { stdout: '[project/demo/1-one abc1234] one\n' });
    runner.on('git push', { exitCode: 0 });
    runner.on('gh pr create', { exitCode: 1, stderr: 'a pull request already exists\n' });
    await assert.rejects(
      () => engine.deliverThread(threadId),
      (error: unknown) => isProjectError(error) && /already exists/.test(error.message),
    );
  });
});

describe('library', () => {
  /** A project with one started, delivered thread whose branch changed two files. */
  async function delivered(): Promise<{
    engine: ProjectEngine;
    runner: FakeRunner;
    root: string;
    threadId: string;
    worktreePath: string;
  }> {
    const { engine, runner, root } = await harness();
    await engine.init({ name: 'demo' });
    repoReady(runner);
    const result = await engine.coordinate(PARENT, '- one\n- two', { planOnly: false });
    const threadId = result.started[0]?.threadId ?? '';
    runner.on('git status --porcelain', { stdout: ' M src/a.ts\n' });
    runner.on('git commit', { stdout: '[project/demo/1-one abc1234] one\n' });
    runner.on('git push', { exitCode: 0 });
    runner.on('gh pr create', { stdout: 'https://github.com/o/r/pull/7\n' });
    runner.on('gh pr view', {
      stdout: JSON.stringify({
        number: 7,
        url: 'https://github.com/o/r/pull/7',
        state: 'OPEN',
        isDraft: false,
        headRefName: 'project/demo/1-one',
        reviewDecision: '',
        mergeable: 'MERGEABLE',
      }),
    });
    runner.on('git diff', { stdout: 'A\tsrc/a.ts\nM\tsrc/b.ts\n' });
    await engine.deliverThread(threadId);
    const thread = await engine.requireThread(threadId);
    return { engine, runner, root, threadId, worktreePath: thread.worktreePath ?? '' };
  }

  /**
   * A project with one started thread that has not delivered yet.
   *
   * Delivery reclaims the checkout, so anything that reads bytes from disk has to run before
   * it. The worktree directory itself is not created by the fake runner, so the caller makes it.
   */
  async function started(): Promise<{
    engine: ProjectEngine;
    runner: FakeRunner;
    root: string;
    threadId: string;
    worktreePath: string;
  }> {
    const { engine, runner, root } = await harness();
    await engine.init({ name: 'demo' });
    repoReady(runner);
    const result = await engine.coordinate(PARENT, '- one\n- two', { planOnly: false });
    const threadId = result.started[0]?.threadId ?? '';
    const thread = await engine.requireThread(threadId);
    return { engine, runner, root, threadId, worktreePath: thread.worktreePath ?? '' };
  }

  it('records what the branch changed when the thread delivers', async () => {
    const { engine, threadId } = await delivered();
    const thread = await engine.requireThread(threadId);
    assert.deepEqual(thread.outputs, [
      { path: 'src/a.ts', change: 'added' },
      { path: 'src/b.ts', change: 'modified' },
    ]);
    assert.ok((thread.outputsAt ?? 0) > 0);
    const files = await engine.library();
    assert.deepEqual(files.map((row) => row.path), ['src/a.ts', 'src/b.ts']);
    assert.deepEqual(files[0]?.threads, [threadId]);
  });

  it('records the outputs even when this call commits nothing', async () => {
    // The thread may have committed during its own turn; an empty Library would then claim
    // it produced nothing.
    const { engine, runner, threadId } = await delivered();
    runner.on('git status --porcelain', { stdout: '' });
    const second = await engine.deliverThread(threadId);
    assert.equal(second.message, 'nothing to commit');
    const thread = await engine.requireThread(threadId);
    assert.equal(thread.outputs?.length, 2);
  });

  it('keeps the previous list when the diff cannot be computed', async () => {
    // "we could not look" is not "nothing changed": an unreadable range must not wipe rows.
    const { engine, runner, threadId } = await delivered();
    runner.on('git status --porcelain', { stdout: '' });
    runner.on('git diff', { exitCode: 128, stderr: 'fatal: bad revision\n' });
    await engine.deliverThread(threadId);
    const thread = await engine.requireThread(threadId);
    assert.equal(thread.outputs?.length, 2);
  });

  it('reads a produced file out of a live thread worktree', async () => {
    // A thread that has not delivered yet still owns its checkout, which is the only state in
    // which the bytes are on this disk at all: delivery reclaims the worktree once the branch
    // is pushed, and after that the file lives on the branch rather than in a directory.
    const { engine, runner, threadId, worktreePath } = await started();
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(worktreePath, 'src'), { recursive: true });
    await writeFile(join(worktreePath, 'src', 'a.ts'), 'export const a = 1;\n');
    // Named explicitly: the path → thread mapping is written when the thread delivers, so a
    // thread that has not delivered yet is found by id rather than by searching the manifest.
    const result = await engine.readOutputFile('src/a.ts', threadId);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.text, 'export const a = 1;\n');
      assert.equal(result.source, join(worktreePath, 'src', 'a.ts'));
    }
    // Reading through an explicit thread id is the same file, and an unknown id is an error
    // rather than a silent fallback to some other thread's worktree.
    const named = await engine.readOutputFile('src/a.ts', threadId);
    assert.equal(named.ok, true);
    await assert.rejects(
      () => engine.readOutputFile('src/a.ts', 'thr-999'),
      (error: unknown) => isProjectError(error) && error.code === 'THREAD_NOT_FOUND',
    );
    void runner;
  });

  it('says a reclaimed worktree is unreadable instead of returning an empty file', async () => {
    const { engine, threadId } = await delivered();
    const thread = await engine.requireThread(threadId);
    assert.equal(thread.worktreePath, undefined);
    const result = await engine.readOutputFile('src/a.ts');
    assert.equal(result.ok, false);
    if (!result.ok) {
      // The bytes are on the branch, so the honest report names where they are rather than
      // describing the file as missing.
      assert.match(result.reason, /reclaimed after delivery/);
      assert.match(result.reason, /lives on branch/);
    }
  });

  it('reports no library rows before anything was delivered', async () => {
    const { engine, runner } = await harness();
    await engine.init({ name: 'demo' });
    repoReady(runner);
    await engine.coordinate(PARENT, '- one', { planOnly: false });
    assert.deepEqual(await engine.library(), []);
  });
});

describe('worktree reclamation', () => {
  /**
   * Route git's worktree commands against the real filesystem.
   *
   * The default fake answers `git rev-parse --git-dir` with success for any directory, which
   * makes a deleted checkout look healthy — exactly the bug these tests exist to catch. Here
   * absence is observable, `remove` really deletes, and `add` really creates.
   */
  function worktreeAware(runner: FakeRunner, options: { refuseRemoval?: boolean } = {}): void {
    // Keyed on the whole command, not on `git rev-parse`: route keys are matched by longest
    // prefix, so a shorter key would be shadowed by the fixture's own success-answering route
    // and every deleted checkout would look healthy.
    runner.onCommand('git rev-parse --git-dir', (spec) =>
      existsSync(spec.cwd)
        ? { exitCode: 0, stdout: '.git\n' }
        : { exitCode: 128, stderr: 'fatal: not a git repository' },
    );
    runner.onCommand('git worktree remove', (spec) => {
      if (options.refuseRemoval === true) {
        return { exitCode: 1, stderr: 'fatal: validation failed, cannot remove working tree: untracked files\n' };
      }
      const path = spec.argv[4] ?? '';
      if (existsSync(path)) rmSync(path, { recursive: true, force: true });
      return { exitCode: 0 };
    });
    runner.onCommand('git worktree add', (spec) => {
      // Two shapes reach this route: `add -b <branch> <path> <from>` when a thread starts, and
      // `add <path> <branch>` when delivery's reclaim is undone. The path is the first
      // non-flag argument after the `-b <branch>` pair.
      const rest = spec.argv.slice(3);
      const path = rest[0] === '-b' ? (rest[2] ?? '') : (rest[0] ?? '');
      if (path !== '') mkdirSync(path, { recursive: true });
      return { exitCode: 0 };
    });
  }

  /** A project with one delivered thread whose checkout was reclaimed. */
  async function deliveredThread(options: { refuseRemoval?: boolean } = {}): Promise<{
    engine: ProjectEngine;
    runner: FakeRunner;
    threadId: string;
    worktreePath: string;
    message: string;
  }> {
    const { engine, runner } = await harness();
    await engine.init({ name: 'demo' });
    repoReady(runner);
    const planned = await engine.coordinate(PARENT, '- one\n- two', { planOnly: false });
    const threadId = planned.started[0]?.threadId ?? '';
    const thread = await engine.requireThread(threadId);
    const worktreePath = thread.worktreePath ?? '';
    worktreeAware(runner, options);
    // The fake `git worktree add -b` answers success without touching the disk, so the checkout
    // is materialised here; every later claim about healthy/missing is a real `existsSync`.
    mkdirSync(join(worktreePath, 'src'), { recursive: true });
    runner.on('git status --porcelain', { stdout: ' M src/a.ts\n' });
    runner.on('git commit', { stdout: '[project/demo/1-one abc1234] one\n' });
    runner.on('git push', { exitCode: 0 });
    runner.on('gh pr create', { stdout: 'https://github.com/o/r/pull/7\n' });
    runner.on('gh pr view', {
      stdout: JSON.stringify({
        number: 7,
        url: 'https://github.com/o/r/pull/7',
        state: 'OPEN',
        isDraft: false,
        headRefName: 'project/demo/1-one',
        reviewDecision: '',
        mergeable: 'MERGEABLE',
      }),
    });
    runner.on('git diff', { stdout: 'A\tsrc/a.ts\n' });
    const delivery = await engine.deliverThread(threadId);
    return { engine, runner, threadId, worktreePath, message: delivery.message };
  }

  it('reclaims the checkout once the branch is pushed', async () => {
    // Disk use stays proportional to threads in flight rather than threads ever run. The branch
    // is pushed first, so nothing is lost that is not on the remote.
    const { engine, runner, threadId, worktreePath } = await deliveredThread();
    assert.equal(existsSync(worktreePath), false);
    const thread = await engine.requireThread(threadId);
    assert.equal(thread.worktreePath, undefined);
    assert.equal(thread.note, 'worktree reclaimed after delivery');
    assert.equal(runner.saw('git worktree remove'), true);
    // The recorded outputs survive the deletion, which is the whole reason Library is a list.
    assert.equal(thread.outputs?.[0]?.path, 'src/a.ts');
  });

  it('puts the checkout back before waking a delivered thread', async () => {
    // A heal or respond turn runs in the same path the thread was launched into. Waking it
    // against a deleted directory would fail in a way that looks like the thread's fault.
    const { engine, runner, threadId, worktreePath } = await deliveredThread();
    const before = runner.callsFor('git worktree add').length;
    await engine.manageThread(PARENT, threadId, 'respond', 'merge it');
    // A second `add` means the wake-up actually restored the checkout; the first is the one
    // coordinate made when the thread started.
    assert.equal(runner.callsFor('git worktree add').length, before + 1);
    assert.equal(existsSync(worktreePath), true);
    const thread = await engine.requireThread(threadId);
    assert.equal(thread.worktreePath, worktreePath);
  });

  it('keeps the checkout and reports a warning when git refuses to remove it', async () => {
    // A failed cleanup is housekeeping, not a delivery failure: the pull request is already
    // open, so the honest answer is to keep the directory and say so rather than to throw.
    const { engine, threadId, worktreePath, message } = await deliveredThread({ refuseRemoval: true });
    const thread = await engine.requireThread(threadId);
    assert.equal(thread.worktreePath, worktreePath);
    assert.equal(existsSync(worktreePath), true);
    assert.match(thread.note ?? '', /could not remove worktree/);
    assert.match(message, /could not remove worktree/);
  });
});

describe('card actions', () => {
  /** A delivered thread with a pull request, so the card actions have a target. */
  async function delivered(): Promise<{
    engine: ProjectEngine;
    runner: FakeRunner;
    threads: FakeThreads;
    threadId: string;
  }> {
    const { engine, runner, threads } = await harness();
    repoReady(runner);
    await engine.init({ name: 'demo' });
    const result = await engine.coordinate(PARENT, '- one\n- two', { planOnly: false });
    const threadId = result.started[0]?.threadId ?? '';
    runner.on('git status --porcelain', { stdout: ' M src/a.ts\n' });
    runner.on('git add', { exitCode: 0 });
    runner.on('git commit', { stdout: '[project/demo/1-one abc1234] one\n' });
    runner.on('git push', { exitCode: 0 });
    runner.on('gh pr create', { stdout: 'https://github.com/o/r/pull/7\n' });
    runner.on('gh pr view', {
      stdout: JSON.stringify({
        number: 7,
        url: 'https://github.com/o/r/pull/7',
        state: 'OPEN',
        isDraft: false,
        headRefName: 'project/demo/1-one',
        baseRefName: 'main',
        reviewDecision: '',
        mergeable: 'MERGEABLE',
      }),
    });
    runner.on('git diff', { stdout: '' });
    await engine.deliverThread(threadId);
    return { engine, runner, threads, threadId };
  }

  /** A running thread with no pull request, for the refusal paths. */
  async function bare(): Promise<{ engine: ProjectEngine; threadId: string }> {
    const { engine, runner } = await harness();
    repoReady(runner);
    await engine.init({ name: 'demo' });
    const result = await engine.coordinate(PARENT, '- one', { planOnly: false });
    return { engine, threadId: result.started[0]?.threadId ?? '' };
  }

  it('asks the thread to merge instead of merging behind its back', async () => {
    // The thread is the only party that knows whether the branch needs a rebase first and
    // what to clean up afterwards. A host-side merge would report success on a branch the
    // thread still believes is waiting for review.
    const { engine, runner, threads, threadId } = await delivered();
    const outcome = await engine.manageThread(PARENT, threadId, 'merge', undefined);
    assert.equal(threads.resumes.length, 1);
    assert.match(threads.resumes[0]?.text ?? '', /pull\/7/);
    assert.equal(runner.saw('gh pr merge'), false, 'the host must not merge for the thread');
    assert.equal(outcome.thread.status, 'landing');
  });

  it('refuses to merge a thread with no pull request', async () => {
    const { engine, threadId } = await bare();
    await assert.rejects(
      () => engine.manageThread(PARENT, threadId, 'merge', undefined),
      (error: unknown) => isProjectError(error) && error.code === 'INVALID_INPUT',
    );
  });

  it('hands the thread the likely conflict sites and the base branch', async () => {
    const { engine, runner, threads, threadId } = await delivered();
    runner.on('gh pr view', { stdout: JSON.stringify({ baseRefName: 'main' }) });
    runner.on('git merge-base', { stdout: 'fork1234\n' });
    // Both sides touched `src/shared.ts`; only this branch touched `src/mine.ts`. The prompt
    // names the intersection and calls it a candidate list, because only the merge can turn
    // a candidate into a real conflict.
    runner.onCommand('git diff', (spec) =>
      spec.argv.join(' ').includes('origin/main')
        ? { stdout: 'M\tsrc/shared.ts\n' }
        : { stdout: 'M\tsrc/shared.ts\nA\tsrc/mine.ts\n' },
    );
    await engine.manageThread(PARENT, threadId, 'conflicts', undefined);
    const text = threads.resumes[0]?.text ?? '';
    assert.match(text, /src\/shared\.ts/);
    assert.match(text, /main/);
    assert.equal(text.includes('src/mine.ts'), false, 'a file only this branch touched cannot conflict');
    assert.match(text, /candidate|likely/i);
  });

  it('still asks the thread to fetch and inspect when nothing overlaps', async () => {
    // An empty intersection is not proof of a clean merge: the base may have moved in a way
    // the two-dot diff cannot see. The instruction survives and only the file list vanishes,
    // because a list of zero files would read as "we already checked, nothing to do".
    const { engine, runner, threads, threadId } = await delivered();
    runner.on('gh pr view', { stdout: JSON.stringify({ baseRefName: 'main' }) });
    runner.on('git merge-base', { stdout: 'fork1234\n' });
    runner.on('git diff', { stdout: '' });
    await engine.manageThread(PARENT, threadId, 'conflicts', undefined);
    const text = threads.resumes[0]?.text ?? '';
    assert.match(text, /Bring `main` into your branch/);
    assert.equal(text.includes('Files both sides touched'), false);
  });

  it('refuses to resolve conflicts without a pull request', async () => {
    const { engine, threadId } = await bare();
    await assert.rejects(
      () => engine.manageThread(PARENT, threadId, 'conflicts', undefined),
      (error: unknown) => isProjectError(error) && error.code === 'INVALID_INPUT',
    );
  });

  it('answers review with the link and spends no thread turn', async () => {
    const { engine, threads, threadId } = await delivered();
    const outcome = await engine.manageThread(PARENT, threadId, 'review', undefined);
    assert.match(outcome.message, /^https:\/\/github\.com\/o\/r\/pull\/7$/);
    assert.equal(threads.resumes.length, 0, 'review is a link, not a wake-up');
  });

  it('refuses review without a pull request', async () => {
    const { engine, threadId } = await bare();
    await assert.rejects(
      () => engine.manageThread(PARENT, threadId, 'review', undefined),
      (error: unknown) => isProjectError(error) && error.code === 'INVALID_INPUT',
    );
  });
});

describe('healSweep', () => {
  it('observes nothing and reports no errors for a project with no reviewed threads', async () => {
    const { engine, runner } = await harness();
    await engine.init();
    repoReady(runner);
    const sweep = await engine.healSweep(PARENT, AbortSignal.timeout(5000));
    assert.equal(sweep.observed, 0);
    assert.deepEqual(sweep.errors, []);
  });

  it('does not heal a thread whose PR is missing', async () => {
    const { engine, runner } = await harness();
    await engine.init({ name: 'demo' });
    repoReady(runner);
    const result = await engine.coordinate(PARENT, '- one\n- two', { planOnly: false });
    // No `gh pr view` route: findPullRequest fails, so the sweep must record an error
    // instead of inventing a state.
    const sweep = await engine.healSweep(PARENT, AbortSignal.timeout(5000));
    assert.ok(result.started.length === 2);
    assert.equal(sweep.healed.length, 0);
  });
});

/**
 * Routes that make one thread reachable as an open pull request.
 *
 * `deliverThread` is the honest way to produce an `awaiting_review` thread: it is the same
 * path a real thread takes, so the PR reference, the branch and the status cannot drift
 * from what the polling loop will later read.
 */
async function awaitingThread(): Promise<{
  engine: ProjectEngine;
  runner: FakeRunner;
  threads: FakeThreads;
  threadId: string;
  branch: string;
  prNumber: number;
}> {
  const { engine, runner, threads } = await harness();
  await engine.init({ name: 'demo' });
  repoReady(runner);
  // A commit exists, otherwise `deliverThread` correctly answers "nothing to commit".
  runner.on('git status --porcelain', { stdout: ' M src/a.ts\n' });
  runner.on('git commit', { stdout: '[main abc1234] work\n' });
  const started = await engine.coordinate(PARENT, '- one', { planOnly: false });
  const first = started.started[0];
  const threadId = first?.threadId;
  const branch = first?.branch;
  assert.ok(threadId !== undefined, 'the thread must have started');
  assert.ok(branch !== undefined, 'the thread must have its own branch');

  const prNumber = 7;
    // No pull request exists for the branch yet, so delivery is expected to create one.
    runner.on('gh pr view', { exitCode: 1, stderr: 'no pull requests found for branch' });
  runner.on('gh pr create', { stdout: `https://github.com/acme/demo/pull/${prNumber}\n` });
  runner.on(`gh pr view ${branch}`, {
    stdout: JSON.stringify({
      number: prNumber,
      url: `https://github.com/acme/demo/pull/${prNumber}`,
      state: 'OPEN',
      isDraft: false,
      headRefName: branch,
      reviewDecision: '',
      mergeable: 'MERGEABLE',
    }),
  });
  runner.on(`gh api repos/{owner}/{repo}/pulls/${String(prNumber)}/comments`, { stdout: '[]' });
  runner.on(`gh api repos/{owner}/{repo}/pulls/${String(prNumber)}/reviews`, { stdout: '[]' });
  runner.on(`gh pr view ${String(prNumber)}`, { stdout: JSON.stringify({ state: 'OPEN', isDraft: false }) });

  const delivered = await engine.deliverThread(threadId, {});
  assert.ok(delivered.prRef !== undefined, 'delivery must record a pull request');
  return { engine, runner, threads, threadId, branch, prNumber };
}

describe('healSweep: consecutive-failure budget', () => {
  it('heals the same unchanged failure three times, then escalates', async () => {
    const { engine, runner, threadId } = await awaitingThread();
    runner.on('gh pr checks', { stdout: JSON.stringify([{ name: 'build', state: 'FAILURE' }]) });

    for (const round of [1, 2, 3]) {
      const sweep = await engine.healSweep(PARENT, AbortSignal.timeout(5000));
      assert.equal(sweep.healed.length, 1, `round ${String(round)} must heal`);
      assert.equal(sweep.escalated.length, 0, `round ${String(round)} must not escalate`);
    }

    const fourth = await engine.healSweep(PARENT, AbortSignal.timeout(5000));
    assert.equal(fourth.healed.length, 0, 'a fourth identical round must not spend another attempt');
    assert.equal(fourth.escalated.length, 1);
    const thread = await engine.requireThread(threadId);
    assert.equal(thread.status, 'needs_feedback');
    assert.equal(thread.consecutiveFails, 3);
    assert.match(thread.feedbackPrompt ?? '', /same failure/);
  });

  it('resets the counter when the failure set changes', async () => {
    const { engine, runner, threadId } = await awaitingThread();
    runner.on('gh pr checks', { stdout: JSON.stringify([{ name: 'build', state: 'FAILURE' }]) });
    await engine.healSweep(PARENT, AbortSignal.timeout(5000));
    await engine.healSweep(PARENT, AbortSignal.timeout(5000));

    // A different check fails: the earlier rounds did move the problem along, so the
    // budget must start over instead of escalating a thread that is making progress.
    runner.on('gh pr checks', { stdout: JSON.stringify([{ name: 'lint', state: 'FAILURE' }]) });
    const sweep = await engine.healSweep(PARENT, AbortSignal.timeout(5000));
    assert.equal(sweep.healed.length, 1);
    assert.equal(sweep.escalated.length, 0);
    const thread = await engine.requireThread(threadId);
    assert.equal(thread.consecutiveFails, 1);
    assert.equal(thread.failureSignature, 'lint');
    assert.equal(thread.healAttempts, 3, 'the lifetime counter still records every round');
  });

  it('resets the counter when a new review comment arrives', async () => {
    const { engine, runner, threadId, prNumber } = await awaitingThread();
    runner.on('gh pr checks', { stdout: JSON.stringify([{ name: 'build', state: 'FAILURE' }]) });
    await engine.healSweep(PARENT, AbortSignal.timeout(5000));
    await engine.healSweep(PARENT, AbortSignal.timeout(5000));

    runner.on(`gh api repos/{owner}/{repo}/pulls/${String(prNumber)}/comments`, {
      stdout: JSON.stringify([{ id: 41, user: { login: 'bob' }, body: 'rename the helper', path: 'src/a.ts', line: 3 }]),
    });
    const sweep = await engine.healSweep(PARENT, AbortSignal.timeout(5000));
    assert.equal(sweep.healed.length, 1, 'a new comment is new information, not a repeat failure');
    const thread = await engine.requireThread(threadId);
    assert.equal(thread.consecutiveFails, 1);
  });

  it('does not escalate on a long review that keeps producing new comments', async () => {
    const { engine, runner, threadId, prNumber } = await awaitingThread();
    runner.on('gh pr checks', { stdout: JSON.stringify([{ name: 'build', state: 'FAILURE' }]) });
    // Five rounds, each with a comment nobody has seen before: this is the case a lifetime
    // budget punished — six weeks of review would have "exhausted" three attempts.
    for (let round = 1; round <= 5; round += 1) {
      runner.on(`gh api repos/{owner}/{repo}/pulls/${String(prNumber)}/comments`, {
        stdout: JSON.stringify([{ id: 100 + round, user: { login: 'bob' }, body: `round ${String(round)}` }]),
      });
      const sweep = await engine.healSweep(PARENT, AbortSignal.timeout(5000));
      assert.equal(sweep.healed.length, 1, `round ${String(round)} must heal`);
      assert.equal(sweep.escalated.length, 0, `round ${String(round)} must not escalate`);
    }
    const thread = await engine.requireThread(threadId);
    assert.equal(thread.status, 'ci_fixing');
    assert.equal(thread.consecutiveFails, 1);
    assert.equal(thread.healAttempts, 5);
  });
});

describe('healSweep: unreachable pull requests', () => {
  it('settles a thread whose branch was deleted after the PR merged', async () => {
    const { engine, runner, threadId } = await awaitingThread();
    runner.on('gh pr checks', { exitCode: 1, stderr: 'no pull requests found for branch "project/demo/1-one"' });
    runner.on('gh pr view 7', { stdout: JSON.stringify({ state: 'MERGED', isDraft: false }) });

    const sweep = await engine.healSweep(PARENT, AbortSignal.timeout(5000));
    assert.deepEqual(sweep.errors, [], 'a merged pull request is not an error');
    assert.equal(sweep.settled.length, 1);
    const thread = await engine.requireThread(threadId);
    assert.equal(thread.status, 'completed');
    assert.ok(thread.unwatchAt !== undefined, 'a merged PR cannot change again, so polling stops');

    const second = await engine.healSweep(PARENT, AbortSignal.timeout(5000));
    assert.equal(second.observed, 0, 'a settled thread is not polled again');
  });

  it('reports an authentication failure instead of reading it as a quiet pull request', async () => {
    const { engine, runner, threadId } = await awaitingThread();
    runner.on('gh pr checks', { exitCode: 1, stderr: 'HTTP 401: Bad credentials (https://api.github.com)' });

    const sweep = await engine.healSweep(PARENT, AbortSignal.timeout(5000));
    assert.equal(sweep.errors.length, 1);
    assert.match(sweep.errors[0]?.message ?? '', /401/);
    const thread = await engine.requireThread(threadId);
    assert.equal(thread.status, 'awaiting_review', 'a broken token must not settle or heal anything');
    assert.equal(thread.unwatchAt, undefined, 'and it must not stop watching either');
  });

  it('asks rather than guessing when the pull request is gone and its state is unreadable', async () => {
    const { engine, runner, threadId } = await awaitingThread();
    runner.on('gh pr checks', { exitCode: 1, stderr: 'no pull requests found for branch "project/demo/1-one"' });
    runner.on('gh pr view 7', { exitCode: 1, stderr: 'HTTP 404: Not Found' });

    const sweep = await engine.healSweep(PARENT, AbortSignal.timeout(5000));
    assert.equal(sweep.escalated.length, 1);
    const thread = await engine.requireThread(threadId);
    assert.equal(thread.status, 'needs_feedback');
    assert.match(thread.feedbackPrompt ?? '', /no longer be reached/);
    assert.ok(thread.unwatchAt !== undefined);
  });
});

describe('healSweep: manual subscription', () => {
  it('stops polling after `unwatch` and resumes after `watch`', async () => {
    const { engine, runner, threadId } = await awaitingThread();
    runner.on('gh pr checks', { stdout: JSON.stringify([{ name: 'build', state: 'SUCCESS' }]) });

    const off = await engine.manageThread(PARENT, threadId, 'unwatch', undefined, AbortSignal.timeout(5000));
    assert.match(off.message, /stopped polling/);
    assert.equal((await engine.healSweep(PARENT, AbortSignal.timeout(5000))).observed, 0);

    const on = await engine.manageThread(PARENT, threadId, 'watch', undefined, AbortSignal.timeout(5000));
    assert.match(on.message, /resumed polling/);
    const sweep = await engine.healSweep(PARENT, AbortSignal.timeout(5000));
    assert.equal(sweep.observed, 1);
    assert.ok(runner.saw('gh pr checks'), 'watching again means one `gh` round again');
  });
});

describe('approvals', () => {
  test('keeps the original behaviour when nothing is gated', async () => {
    const { engine, runner, threads } = await harness();
    repoReady(runner);
    runner.on('git status --porcelain', { stdout: '' });
    runner.on('gh pr create', { stdout: 'https://github.com/acme/demo/pull/9\n' });
    await engine.init({ name: 'demo' });
    const plan = await engine.coordinate(PARENT, '- add a thing', { planOnly: false });
    const threadId = plan.started[0]?.threadId;
    assert.ok(threadId !== undefined);
    assert.deepEqual(engine.approvalsRequired(), []);
    await engine.deliverThread(threadId);
    // Nothing was gated, so delivery proceeded without a single approval round.
    assert.equal(threads.resumes.length, 0);
  });

  test('refuses to publish until push and pr are approved, and says how', async () => {
    const { engine, runner } = await harness({ requireApprovalFor: ['push', 'pr'] });
    repoReady(runner);
    runner.on('git status --porcelain', { stdout: ' M src/a.ts\n' });
    runner.on('git add', { exitCode: 0 });
    runner.on('git commit', { stdout: '[main abc1234] feat\n' });
    // First read is the pre-check (no pull request yet); after `gh pr create` the read-back has
    // to answer, otherwise delivery treats the pull request it just made as unreadable.
    runner.onCommand('gh pr view', (spec) => {
      // Nothing exists before the PR is created; after it, the read-back has to answer.
      if (!runner.saw('gh pr create')) return { exitCode: 1, stderr: 'no pull requests found for branch' };
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          number: 9,
          url: 'https://github.com/acme/demo/pull/9',
          state: 'OPEN',
          isDraft: false,
          headRefName: spec.argv[3] ?? '',
          reviewDecision: '',
          mergeable: 'MERGEABLE',
        }),
      };
    });
    runner.on('gh pr create', { stdout: 'https://github.com/acme/demo/pull/9\n' });
    await engine.init({ name: 'demo' });
    const plan = await engine.coordinate(PARENT, '- add a thing', { planOnly: false });
    const threadId = plan.started[0]?.threadId;
    assert.ok(threadId !== undefined);
    await assert.rejects(
      () => engine.deliverThread(threadId),
      (error: unknown) => {
        assert.ok(isProjectError(error));
        assert.equal(error.code, 'APPROVAL_REQUIRED');
        // A refusal nobody can resolve is a dead end, so it names the command that clears it.
        assert.match(error.message, /\/project thread .* approve push/);
        return true;
      },
    );
    // Nothing was published while the gate was closed.
    assert.equal(runner.saw('git push'), false);
    await engine.approve(threadId, 'push');
    await assert.rejects(
      () => engine.deliverThread(threadId),
      (error: unknown) => isProjectError(error) && error.code === 'APPROVAL_REQUIRED',
    );
    await engine.approve(threadId, 'pr');
    const delivered = await engine.deliverThread(threadId);
    assert.ok(delivered.prRef !== undefined);
    assert.equal(runner.saw('git push'), true);
  });

  test('gates merging separately from publishing', async () => {
    const { engine, runner, threads } = await harness({ requireApprovalFor: ['merge'] });
    repoReady(runner);
    runner.on('git status --porcelain', { stdout: ' M src/b.ts\n' });
    runner.on('git add', { exitCode: 0 });
    runner.on('git commit', { stdout: '[main abc1234] feat\n' });
    // First read is the pre-check (no pull request yet); after `gh pr create` the read-back has
    // to answer, otherwise delivery treats the pull request it just made as unreadable.
    runner.onCommand('gh pr view', (spec) => {
      // Nothing exists before the PR is created; after it, the read-back has to answer.
      if (!runner.saw('gh pr create')) return { exitCode: 1, stderr: 'no pull requests found for branch' };
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          number: 3,
          url: 'https://github.com/acme/demo/pull/3',
          state: 'OPEN',
          isDraft: false,
          headRefName: spec.argv[3] ?? '',
          reviewDecision: '',
          mergeable: 'MERGEABLE',
        }),
      };
    });
    runner.on('gh pr create', { stdout: 'https://github.com/acme/demo/pull/3\n' });
    await engine.init({ name: 'demo' });
    const plan = await engine.coordinate(PARENT, '- add a thing', { planOnly: false });
    const threadId = plan.started[0]?.threadId;
    assert.ok(threadId !== undefined);
    // Publishing is not gated here, so this path also proves the gate is per action.
    await engine.deliverThread(threadId);
    await assert.rejects(
      () => engine.manageThread(PARENT, threadId, 'merge', undefined, AbortSignal.timeout(1_000)),
      (error: unknown) => isProjectError(error) && error.code === 'APPROVAL_REQUIRED',
    );
    assert.equal(threads.resumes.length, 0);
    await engine.approve(threadId, 'merge');
    const merged = await engine.manageThread(PARENT, threadId, 'merge', undefined, AbortSignal.timeout(1_000));
    assert.equal(merged.thread.status, 'landing');
  });

  test('rejects an unknown approval action instead of recording it', async () => {
    const { engine, runner } = await harness({ requireApprovalFor: ['push'] });
    repoReady(runner);
    await engine.init({ name: 'demo' });
    const plan = await engine.coordinate(PARENT, '- add a thing', { planOnly: false });
    const threadId = plan.started[0]?.threadId;
    assert.ok(threadId !== undefined);
    await assert.rejects(
      () => engine.approve(threadId, 'everything' as ApprovalAction),
      (error: unknown) => isProjectError(error) && error.code === 'INVALID_INPUT',
    );
  });

  test('tells a fresh thread to stop before publishing, and the panel says what is gated', async () => {
    const { engine, runner, threads } = await harness({ requireApprovalFor: ['push', 'pr'] });
    repoReady(runner);
    await engine.init({ name: 'demo' });
    await engine.coordinate(PARENT, '- add a thing', { planOnly: false });
    const prompt = threads.launches[0]?.prompt ?? '';
    assert.match(prompt, /Stop before publishing/);
    assert.match(prompt, /approve push and open a PR/);
    const overview = await engine.overviewJson();
    assert.deepEqual(overview.approvalsRequired, ['push', 'pr']);
    assert.match(renderOverviewMarkdown(await engine.overview()), /sign-off required before: push, pr/);
  });
});
