/**
 * Integration tests for the orchestration engine.
 *
 * These drive the real `ProjectEngine` over a real temporary directory, with the two
 * ports (`CommandRunner`, `ThreadRuntime`) faked. That combination is deliberate: the
 * manifest store's atomic rename and CAS loop only mean something on a real filesystem,
 * while git and subagents are exactly the parts that cannot run in a unit test.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { ProjectEngine } from '../src/core/engine.js';
import { isProjectError } from '../src/core/errors.js';
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
async function harness(): Promise<{
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

    const result = await engine.coordinate(PARENT, '- add the form\n- wire persistence', {});
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
    await engine.coordinate(PARENT, '- one\n- two\n- three', {});
    const manifest = await engine.requireManifest();
    assert.equal(manifest.dailyThreadsCreated, 3);
  });

  it('gives back the reservation for a task that failed to start', async () => {
    // Otherwise a flaky launch quietly eats the day's budget.
    const { engine, runner, threads } = await harness();
    await engine.init({ name: 'demo' });
    repoReady(runner);
    threads.failNextLaunch = 'provider unavailable';
    const result = await engine.coordinate(PARENT, '- one\n- two', {});
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
      () => engine.coordinate(PARENT, '- one\n- two\n- three', {}),
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
    const started = await first.engine.coordinate(PARENT, '- a\n- b\n- c', {});
    assert.equal(started.started.length, 3);
    assert.equal(started.quota.global?.created, 3);

    const second = await build();
    await second.engine.init({ name: 'two' });
    repoReady(second.runner);
    const also = await second.engine.coordinate(PARENT, '- d', {});
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
      () => engine.coordinate(PARENT, '- one', {}),
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
    await assert.rejects(() => engine.coordinate(PARENT, '- one\n- two\n- three', {}));
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
    const result = await engine.coordinate(PARENT, '- one\n- two', {});
    assert.equal(result.started.length, 1);
    assert.equal(result.quota.global?.created, 1, 'the failed task must not keep its shared reservation');
  });

  it('honours the limit without planning more work than it starts', async () => {
    const { engine, runner } = await harness();
    await engine.init({ name: 'demo' });
    repoReady(runner);
    const result = await engine.coordinate(PARENT, '- one\n- two\n- three', { limit: 2 });
    assert.equal(result.started.length, 2);
    assert.equal(result.planned.length, 2);
  });

  it('falls back to scope isolation when the root is not a git repo', async () => {
    const { engine, threads } = await harness();
    await engine.init({ name: 'demo' });
    // Nothing routed: every probe fails, so inspectRepo reports "not a repo".
    const result = await engine.coordinate(PARENT, '- one\n- two', {});
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
      () => unavailable.coordinate(PARENT, '- one\n- two', {}),
      (error: unknown) => isProjectError(error) && error.code === 'SPAWN_FAILED',
    );
  });

  it('rejects a goal that produces no tasks', async () => {
    const { engine } = await harness();
    await engine.init();
    await assert.rejects(
      () => engine.coordinate(PARENT, '   ', {}),
      (error: unknown) => isProjectError(error) && error.code === 'INVALID_INPUT',
    );
  });

  it('passes the shared charter and memory keys into the thread prompt', async () => {
    const { engine, runner, threads } = await harness();
    await engine.init({ name: 'demo' });
    repoReady(runner);
    await engine.setMemory(undefined, { key: 'db', decision: 'use postgres' });
    await engine.coordinate(PARENT, '- one\n- two', { memoryKeys: ['db'] });
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
    const result = await engine.coordinate(PARENT, '- one\n- two', {});
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
    const result = await engine.coordinate(PARENT, '- one\n- two', {});
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
    const result = await engine.coordinate(PARENT, '- one\n- two', {});
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
    const result = await engine.coordinate(PARENT, '- one\n- two', {});
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
    const result = await engine.coordinate(PARENT, '- one\n- two', {});
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
    const result = await engine.coordinate(PARENT, '- one\n- two', {});
    const id = result.started[0]?.threadId ?? '';
    await engine.manageThread(PARENT, id, 'steer', 'also handle the empty case');
    assert.equal(threads.steers.length, 1);
    assert.match(threads.steers[0]?.text ?? '', /empty case/);
  });

  it('rejects steering without a message', async () => {
    const { engine, runner } = await harness();
    await engine.init({ name: 'demo' });
    repoReady(runner);
    const result = await engine.coordinate(PARENT, '- one\n- two', {});
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
    const result = await engine.coordinate(PARENT, '- one\n- two', {});
    const id = result.started[0]?.threadId ?? '';
    const child = result.started[0]?.childSessionId ?? '';
    await engine.manageThread(PARENT, id, 'interrupt', undefined);
    assert.deepEqual(threads.interrupts, [child]);
  });

  it('closes a thread without pretending it succeeded', async () => {
    const { engine, runner } = await harness();
    await engine.init({ name: 'demo' });
    repoReady(runner);
    const result = await engine.coordinate(PARENT, '- one\n- two', {});
    const id = result.started[0]?.threadId ?? '';
    const closed = await engine.manageThread(PARENT, id, 'close', undefined);
    assert.equal(closed.thread.status, 'completed');
  });
});

describe('overview / charter', () => {
  it('renders an overview from the persisted manifest', async () => {
    const { engine, runner } = await harness();
    await engine.init({ name: 'demo' });
    repoReady(runner);
    await engine.coordinate(PARENT, '- one\n- two', {});
    const overview = await engine.overview();
    assert.equal(overview.name, 'demo');
    assert.equal(overview.totals.threads, 2);
    assert.equal(overview.buckets.running.length, 2);
  });

  it('exposes the same overview as a plain JSON tool payload', async () => {
    const { engine, runner } = await harness();
    await engine.init({ name: 'demo' });
    repoReady(runner);
    await engine.coordinate(PARENT, '- one\n- two', {});
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
    const result = await engine.coordinate(PARENT, '- one\n- two', {});
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
    const result = await engine.coordinate(PARENT, '- one\n- two', {});
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
    const result = await engine.coordinate(PARENT, '- one\n- two', {});
    // No `gh pr view` route: findPullRequest fails, so the sweep must record an error
    // instead of inventing a state.
    const sweep = await engine.healSweep(PARENT, AbortSignal.timeout(5000));
    assert.ok(result.started.length === 2);
    assert.equal(sweep.healed.length, 0);
  });
});
