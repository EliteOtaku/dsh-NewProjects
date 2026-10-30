/**
 * The model-facing tools, exercised through their real `execute`.
 *
 * Two properties matter more than any single payload: a tool must never throw for an
 * expected state (a thrown error ends the turn, and "no project yet" is not an error the
 * model should die on), and it must resolve its engine from the `rootDir` it was given so
 * one plugin can serve several workspaces.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { ProjectEngine } from '../src/core/engine.js';
import { buildTools } from '../src/host/tools.js';
import type { HostToolDefinition, HostToolRunContext } from '../src/host/hostTypes.js';
import type { UsagePort } from '../src/core/usage.js';
import type { ApprovalAction } from '../src/types.js';
import { FakeRunner, FakeThreads, fixedClock, sequentialIds } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const cleanup of cleanups) await cleanup();
});

const PARENT = { id: 'session-parent' };

/** A fake `ToolRunContext`: the tools only read `agent` and `signal`. */
function context(): HostToolRunContext {
  return {
    callId: 'call-1',
    agent: PARENT,
    signal: AbortSignal.timeout(5000),
    deferContext: () => undefined,
    concludeTurn: () => undefined,
  };
}

/** A project over a fresh temp root. */
async function harness(extra: { usage?: UsagePort; requireApprovalFor?: ApprovalAction[] } = {}): Promise<{
  engine: ProjectEngine;
  runner: FakeRunner;
  threads: FakeThreads;
  root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-project-tool-'));
  cleanups.push(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const runner = new FakeRunner();
  const threads = new FakeThreads();
  const engine = new ProjectEngine(root, {
    runner,
    threads,
    clock: fixedClock(),
    ids: sequentialIds(),
    quotaLedgerPath: join(root, 'quota-ledger.json'),
    ...(extra.usage === undefined ? {} : { usage: extra.usage }),
    ...(extra.requireApprovalFor === undefined ? {} : { requireApprovalFor: extra.requireApprovalFor }),
  });
  return { engine, runner, threads, root };
}

/** Pull one tool out of the set by name. */
function tool(source: Parameters<typeof buildTools>[0], name: string): HostToolDefinition {
  const found = buildTools(source).find((definition) => definition.name === name);
  assert.ok(found !== undefined, `no tool named ${name}`);
  return found;
}

/** Route the git/gh probes so coordination takes the branch-isolation path. */
function repoReady(runner: FakeRunner): void {
  runner.on('git rev-parse --git-dir', { stdout: '.git\n' });
  runner.on('git rev-parse --show-toplevel', { stdout: '/tmp/demo\n' });
  runner.on('git rev-parse HEAD', { stdout: 'deadbeefcafe\n' });
  runner.on('git rev-parse --abbrev-ref', { stdout: 'main\n' });
  runner.on('git rev-parse --verify', { exitCode: 1 });
  runner.on('gh --version', { stdout: 'gh version 2.40.0\n' });
  runner.on('gh auth status', { stdout: 'Logged in to github.com\n' });
  runner.on('git branch', { exitCode: 0 });
  // Threads get their own checkout now, so the worktree command must be routed too.
  runner.on('git worktree', { exitCode: 0 });
  // Diff for the Library: the branches these fixtures model changed nothing on their own.
  runner.on('git diff', { stdout: '' });
}

/**
 * Paths where a value would not survive the Host's lossless-JSON check.
 *
 * The Host validates every tool result before the model sees it: each own enumerable value
 * must be `null`, a string, a boolean, a finite number other than `-0`, or a plain
 * array/object of the same. `undefined` is not a JSON value, so a single such key fails the
 * whole call — which no unit test noticed until a real Host rejected `project_overview` on a
 * freshly initialised project.
 */
function jsonFailurePaths(value: unknown, path = '$', found: string[] = []): string[] {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return found;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) found.push(`${path}=${String(value)}`);
    return found;
  }
  if (typeof value !== 'object') {
    found.push(`${path}: ${typeof value}`);
    return found;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) found.push(`${path}: not a plain array`);
    value.forEach((item, index) => jsonFailurePaths(item, `${path}[${index}]`, found));
    return found;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) found.push(`${path}: non-plain object`);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || descriptor === undefined || descriptor.enumerable !== true || !('value' in descriptor)) {
      found.push(`${path}.${String(key)}: not a plain own property`);
      continue;
    }
    jsonFailurePaths(descriptor.value, `${path}.${key}`, found);
  }
  return found;
}

describe('tool registration', () => {
  it('exposes exactly the documented tools', () => {
    const source = { engineFor: () => Promise.reject(new Error('unused')), parentOf: () => PARENT };
    assert.deepEqual(
      buildTools(source).map((definition) => definition.name),
      [
        'project_coordinate',
        'project_memory_sync',
        'project_thread_manage',
        'project_overview',
        'project_knowledge_search',
        'project_knowledge',
        'project_library',
      ],
    );
  });

  it('gives every tool an object output schema and a renderer', () => {
    // The Host calls `render` with the value `execute` returned; a missing renderer would
    // make the tool result empty rather than failing loudly.
    const source = { engineFor: () => Promise.reject(new Error('unused')), parentOf: () => PARENT };
    for (const definition of buildTools(source)) {
      assert.equal(definition.output.schema.type, 'object', definition.name);
      const blocks = definition.output.render({}, { ok: true });
      assert.equal(blocks[0]?.type, 'text');
      assert.match(blocks[0]?.text ?? '', /"ok": true/);
    }
  });
});

describe('project_coordinate', () => {
  it('starts one thread per bullet and reports the plan', async () => {
    const { engine, runner } = await harness();
    await engine.init({ name: 'demo' });
    repoReady(runner);
    const source = { engineFor: () => Promise.resolve(engine), parentOf: () => PARENT };
    // A goal with no `tasks` still has to leave the caller with an actionable plan, so the
    // fallback splitter proposes and the caller starts. Asking to start immediately is allowed.
    const proposed = (await tool(source, 'project_coordinate').execute(
      { goal: '- add tests\n- document the API' },
      context(),
    )) as Record<string, unknown>;
    assert.equal(proposed['ok'], true);
    assert.equal((proposed['planned'] as unknown[]).length, 2);
    assert.equal((proposed['started'] as unknown[]).length, 0);
    assert.equal((proposed['suggested'] as unknown[]).length, 2);
    const started = (await tool(source, 'project_coordinate').execute(
      { goal: '- add tests\n- document the API', planOnly: false },
      context(),
    )) as Record<string, unknown>;
    assert.equal((started['started'] as unknown[]).length, 2);
    assert.equal(started['suggested'], undefined);
  });

  it('starts exactly the tasks the model supplied, without re-splitting the goal', async () => {
    const { engine, runner } = await harness();
    await engine.init({ name: 'demo' });
    repoReady(runner);
    const result = (await tool({ engineFor: () => Promise.resolve(engine), parentOf: () => PARENT }, 'project_coordinate').execute(
      {
        goal: 'ship the settings page',
        // The model's split disagrees with what the bullet splitter would produce, which is the
        // whole point: the goal is prose here, not a list.
        tasks: [
          { title: 'add the form', objective: 'add the settings form and its validation' },
          { title: 'wire persistence', objective: 'persist settings through the store' },
        ],
      },
      context(),
    )) as Record<string, unknown>;
    assert.equal(result['ok'], true);
    const planned = result['planned'] as Array<Record<string, string>>;
    assert.equal(planned.length, 2);
    assert.equal(planned[0]?.['title'], 'add the form');
    assert.equal(planned[1]?.['objective'], 'persist settings through the store');
    assert.equal(result['planOrigin'], 'model');
  });

  it('returns an uninitialised result instead of throwing', async () => {
    // A thrown error would end the model's turn over a state the model can fix itself.
    const { engine } = await harness();
    const result = (await tool({ engineFor: () => Promise.resolve(engine), parentOf: () => PARENT }, 'project_coordinate').execute(
      { goal: '- one' },
      context(),
    )) as Record<string, unknown>;
    assert.equal(result['ok'], false);
    assert.equal(result['code'], 'PROJECT_NOT_INITIALIZED');
    assert.match(String(result['message']), /\/project init/);
  });

  it('reports a goal that decomposes to nothing as INVALID_INPUT', async () => {
    const { engine } = await harness();
    await engine.init();
    const result = (await tool({ engineFor: () => Promise.resolve(engine), parentOf: () => PARENT }, 'project_coordinate').execute(
      { goal: '   \n\n  ' },
      context(),
    )) as Record<string, unknown>;
    assert.equal(result['code'], 'INVALID_INPUT');
  });

  it('resolves the engine from the rootDir it was given', async () => {
    // One plugin serves several workspaces; a tool that ignored rootDir would silently
    // operate on the wrong project.
    const first = await harness();
    const second = await harness();
    await second.engine.init({ name: 'second' });
    const source = {
      engineFor: (rootDir: string | undefined) => Promise.resolve(rootDir === second.root ? second.engine : first.engine),
      parentOf: () => PARENT,
    };
    const result = (await tool(source, 'project_overview').execute({ rootDir: second.root }, context())) as Record<string, unknown>;
    assert.equal(result['ok'], true);
    assert.equal(result['projectId'], (await second.engine.requireManifest()).projectId);
  });
});

describe('project_memory_sync', () => {
  it('writes decisions and returns the whole set', async () => {
    const { engine } = await harness();
    await engine.init();
    const result = (await tool({ engineFor: () => Promise.resolve(engine), parentOf: () => PARENT }, 'project_memory_sync').execute(
      { set: [{ key: 'stack', decision: 'TypeScript', rationale: 'existing code' }] },
      context(),
    )) as Record<string, unknown>;
    assert.equal(result['ok'], true);
    const entries = result['entries'] as Array<Record<string, unknown>>;
    assert.equal(entries[0]?.['key'], 'stack');
    assert.equal(entries[0]?.['rationale'], 'existing code');
  });

  it('reports which keys it actually removed', async () => {
    const { engine } = await harness();
    await engine.init();
    await engine.setMemory(PARENT, { key: 'stack', decision: 'TypeScript' });
    const result = (await tool({ engineFor: () => Promise.resolve(engine), parentOf: () => PARENT }, 'project_memory_sync').execute(
      { remove: ['stack', 'never-existed'] },
      context(),
    )) as Record<string, unknown>;
    assert.deepEqual(result['removed'], ['stack']);
  });

  it('lists without writing anything when given no set or remove', async () => {
    const { engine } = await harness();
    await engine.init();
    const result = (await tool({ engineFor: () => Promise.resolve(engine), parentOf: () => PARENT }, 'project_memory_sync').execute(
      {},
      context(),
    )) as Record<string, unknown>;
    assert.equal(result['ok'], true);
    assert.deepEqual(await engine.listMemory(), []);
  });

  it('returns an uninitialised result instead of throwing', async () => {
    const { engine } = await harness();
    const result = (await tool({ engineFor: () => Promise.resolve(engine), parentOf: () => PARENT }, 'project_memory_sync').execute(
      { set: [{ key: 'a', decision: 'b' }] },
      context(),
    )) as Record<string, unknown>;
    assert.equal(result['code'], 'PROJECT_NOT_INITIALIZED');
  });
});

describe('project_thread_manage', () => {
  it('lists every thread with a readable summary', async () => {
    const { engine, runner } = await harness();
    await engine.init({ name: 'demo' });
    repoReady(runner);
    await engine.coordinate(PARENT, '- one\n- two', { planOnly: false });
    const manage = tool({ engineFor: () => Promise.resolve(engine), parentOf: () => PARENT }, 'project_thread_manage');
    const result = (await manage.execute({ action: 'list' }, context())) as Record<string, unknown>;
    const threads = result['threads'] as Array<Record<string, unknown>>;
    assert.equal(threads.length, 2);
    assert.ok(threads.every((thread) => typeof thread['summary'] === 'string'));
  });

  it('defaults to list when no action is given', async () => {
    const { engine } = await harness();
    await engine.init();
    const manage = tool({ engineFor: () => Promise.resolve(engine), parentOf: () => PARENT }, 'project_thread_manage');
    const result = (await manage.execute({}, context())) as Record<string, unknown>;
    assert.equal(result['ok'], true);
    assert.deepEqual(result['threads'], []);
  });

  it('demands a thread id for actions that need one', async () => {
    const { engine } = await harness();
    await engine.init();
    const manage = tool({ engineFor: () => Promise.resolve(engine), parentOf: () => PARENT }, 'project_thread_manage');
    const result = (await manage.execute({ action: 'steer' }, context())) as Record<string, unknown>;
    assert.equal(result['code'], 'INVALID_INPUT');
    assert.match(String(result['message']), /requires threadId/);
  });

  it('rejects an unknown action by name', async () => {
    const { engine } = await harness();
    await engine.init();
    const manage = tool({ engineFor: () => Promise.resolve(engine), parentOf: () => PARENT }, 'project_thread_manage');
    const result = (await manage.execute({ action: 'explode', threadId: 'thr-1' }, context())) as Record<string, unknown>;
    assert.equal(result['code'], 'INVALID_INPUT');
    assert.match(String(result['message']), /unknown action "explode"/);
  });

  it('steers a live thread through the tool', async () => {
    const { engine, runner, threads } = await harness();
    await engine.init({ name: 'demo' });
    repoReady(runner);
    const started = await engine.coordinate(PARENT, '- one\n- two', { planOnly: false });
    const threadId = started.started[0]?.threadId ?? '';
    const manage = tool({ engineFor: () => Promise.resolve(engine), parentOf: () => PARENT }, 'project_thread_manage');
    const result = (await manage.execute({ action: 'steer', threadId, message: 'use the existing helper' }, context())) as Record<
      string,
      unknown
    >;
    assert.equal(result['ok'], true);
    assert.equal(threads.steers[0]?.text, 'use the existing helper');
  });

  it('surfaces a missing thread as THREAD_NOT_FOUND', async () => {
    const { engine } = await harness();
    await engine.init();
    const manage = tool({ engineFor: () => Promise.resolve(engine), parentOf: () => PARENT }, 'project_thread_manage');
    const result = (await manage.execute({ action: 'inspect', threadId: 'thr-999' }, context())) as Record<string, unknown>;
    assert.equal(result['code'], 'THREAD_NOT_FOUND');
  });
});

describe('project_thread_manage approval round trip', () => {
  /**
   * The gate moves the question from the thread to the root conversation, which is the
   * direction the official docs say does not reach a thread. So the whole loop has to be
   * proven through the surface the coordinator actually calls: refused, answered, delivered.
   */
  it('delivers after the root records the sign-off, even across a restart', async () => {
    const { engine, runner, threads, root } = await harness({ requireApprovalFor: ['push', 'pr'] });
    await engine.init({ name: 'demo' });
    repoReady(runner);
    const planned = await engine.coordinate(PARENT, '- one', { planOnly: false });
    const threadId = planned.started[0]?.threadId ?? '';
    runner.on('git status --porcelain', { stdout: ' M src/a.ts\n' });
    runner.on('git add', { exitCode: 0 });
    runner.on('git commit', { stdout: '[project/demo/1-one abc1234] one\n' });
    runner.on('git push', { exitCode: 0 });
    runner.on('gh pr create', { stdout: 'https://github.com/o/r/pull/7\n' });
    runner.onCommand('gh pr view', (spec) => {
      if (!runner.saw('gh pr create')) return { exitCode: 1, stderr: 'no pull requests found for branch' };
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          number: 7,
          url: 'https://github.com/o/r/pull/7',
          state: 'OPEN',
          isDraft: false,
          headRefName: spec.argv[3] ?? '',
          reviewDecision: '',
          mergeable: 'MERGEABLE',
        }),
      };
    });
    const manageWith = (current: ProjectEngine): HostToolDefinition =>
      tool({ engineFor: () => Promise.resolve(current), parentOf: () => PARENT }, 'project_thread_manage');

    // Refused as a result, not a throw, and it names everything missing so the root asks once.
    const refused = (await manageWith(engine).execute({ action: 'deliver', threadId }, context())) as Record<string, unknown>;
    assert.equal(refused['ok'], false);
    assert.equal(refused['code'], 'APPROVAL_REQUIRED');
    assert.deepEqual((refused['details'] as Record<string, unknown>)['missing'], ['push', 'pr']);
    assert.match(String(refused['message']), new RegExp(`/project thread ${threadId} approve push pr`));
    assert.equal(runner.saw('git push'), false);

    const first = (await manageWith(engine).execute({ action: 'approve', threadId, approval: 'push' }, context())) as Record<
      string,
      unknown
    >;
    assert.equal(first['ok'], true);

    // A fresh engine over the same root stands in for a Host restart between the two answers:
    // a grant that lived only in memory would be asked for again here.
    const restarted = new ProjectEngine(root, {
      runner,
      threads,
      clock: fixedClock(),
      ids: sequentialIds(),
      quotaLedgerPath: join(root, 'quota-ledger.json'),
      requireApprovalFor: ['push', 'pr'],
    });
    const second = (await manageWith(restarted).execute({ action: 'approve', threadId, approval: 'pr' }, context())) as Record<
      string,
      unknown
    >;
    assert.equal(second['ok'], true);

    const delivered = (await manageWith(restarted).execute({ action: 'deliver', threadId }, context())) as Record<string, unknown>;
    assert.equal(delivered['ok'], true, String(delivered['message']));
    assert.equal(delivered['prRef'], 'https://github.com/o/r/pull/7');
    assert.equal(runner.saw('git push'), true);
    assert.equal(runner.saw('gh pr create'), true);
  });
});

describe('project_overview', () => {
  it('returns the four buckets and the quota', async () => {
    const { engine } = await harness();
    await engine.init();
    const result = (await tool({ engineFor: () => Promise.resolve(engine), parentOf: () => PARENT }, 'project_overview').execute(
      {},
      context(),
    )) as Record<string, unknown>;
    assert.equal(result['ok'], true);
    const buckets = result['buckets'] as Record<string, unknown>;
    assert.deepEqual(Object.keys(buckets).sort(), [
      'idle',
      'landing',
      'ready_for_review',
      'resolved',
      'waiting_on_you',
      'working',
    ]);
    assert.equal((result['quota'] as Record<string, unknown>)['max'], 200);
  });

  it('adds markdown only when asked', async () => {
    const { engine } = await harness();
    await engine.init();
    const overview = tool({ engineFor: () => Promise.resolve(engine), parentOf: () => PARENT }, 'project_overview');
    const plain = (await overview.execute({}, context())) as Record<string, unknown>;
    assert.equal(plain['markdown'], undefined);
    const rendered = (await overview.execute({ markdown: true }, context())) as Record<string, unknown>;
    assert.match(String(rendered['markdown']), /0\/200/);
  });

  it('returns an uninitialised result instead of throwing', async () => {
    const { engine } = await harness();
    const result = (await tool({ engineFor: () => Promise.resolve(engine), parentOf: () => PARENT }, 'project_overview').execute(
      {},
      context(),
    )) as Record<string, unknown>;
    assert.equal(result['code'], 'PROJECT_NOT_INITIALIZED');
  });

  it('sends lossless JSON while the project has no goal yet', async () => {
    // A freshly initialised project has neither a goal nor recorded messages. Those keys must
    // be absent rather than present-and-undefined: the Host drops the whole result otherwise.
    const { engine } = await harness();
    await engine.init({ name: 'demo' });
    const result = (await tool({ engineFor: () => Promise.resolve(engine), parentOf: () => PARENT }, 'project_overview').execute(
      {},
      context(),
    )) as Record<string, unknown>;
    assert.deepEqual(jsonFailurePaths(result), []);
    assert.equal('goal' in result, false);
    assert.equal('recentMessages' in result, false);
  });

  it('sends the goal once one is recorded', async () => {
    const { engine } = await harness();
    await engine.init({ name: 'demo', goal: 'ship the plugin' });
    const result = (await tool({ engineFor: () => Promise.resolve(engine), parentOf: () => PARENT }, 'project_overview').execute(
      {},
      context(),
    )) as Record<string, unknown>;
    assert.equal(result['goal'], 'ship the plugin');
    assert.deepEqual(jsonFailurePaths(result), []);
  });
});

describe('project_library', () => {
  /** A project with one delivered thread that changed two files. */
  async function delivered(): Promise<{ engine: ProjectEngine; runner: FakeRunner; threadId: string; worktreePath: string }> {
    const { engine, runner } = await harness();
    await engine.init({ name: 'demo' });
    repoReady(runner);
    const planned = await engine.coordinate(PARENT, '- one\n- two', { planOnly: false });
    const threadId = planned.started[0]?.threadId ?? '';
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
        reviewDecision: '',
        mergeable: 'MERGEABLE',
      }),
    });
    runner.on('git diff', { stdout: 'A\tsrc/a.ts\n' });
    await engine.deliverThread(threadId);
    const thread = await engine.requireThread(threadId);
    return { engine, runner, threadId, worktreePath: thread.worktreePath ?? '' };
  }

  /** A project with one started thread that still owns its checkout. */
  async function started(): Promise<{ engine: ProjectEngine; runner: FakeRunner; threadId: string; worktreePath: string }> {
    const { engine, runner } = await harness();
    await engine.init({ name: 'demo' });
    repoReady(runner);
    const planned = await engine.coordinate(PARENT, '- one\n- two', { planOnly: false });
    const threadId = planned.started[0]?.threadId ?? '';
    const thread = await engine.requireThread(threadId);
    return { engine, runner, threadId, worktreePath: thread.worktreePath ?? '' };
  }

  it('lists what the threads produced', async () => {
    const { engine } = await delivered();
    const source = { engineFor: () => Promise.resolve(engine), parentOf: () => PARENT };
    const result = (await tool(source, 'project_library').execute({}, context())) as Record<string, unknown>;
    assert.equal(result['ok'], true);
    assert.equal(result['total'], 1);
    const files = result['files'] as Array<Record<string, unknown>>;
    assert.equal(files[0]?.['path'], 'src/a.ts');
    assert.equal(files[0]?.['change'], 'added');
  });

  it('says the library is empty rather than pretending the tool failed', async () => {
    const { engine } = await harness();
    await engine.init();
    const source = { engineFor: () => Promise.resolve(engine), parentOf: () => PARENT };
    const result = (await tool(source, 'project_library').execute({}, context())) as Record<string, unknown>;
    assert.equal(result['ok'], true);
    assert.equal(result['total'], 0);
    assert.match(String(result['hint']), /no thread has delivered/);
  });

  it('reads a produced file, and reports a missing one as missing', async () => {
    // Not delivered: delivery reclaims the checkout, and these bytes only exist on disk while
    // the thread still owns its worktree.
    const { engine, worktreePath, threadId } = await started();
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(worktreePath, 'src'), { recursive: true });
    await writeFile(join(worktreePath, 'src', 'a.ts'), 'export const a = 1;\n');
    const source = { engineFor: () => Promise.resolve(engine), parentOf: () => PARENT };
    const read = tool(source, 'project_library');

    // The thread is named because delivery is what records which thread produced which path.
    const ok = (await read.execute({ action: 'read', path: 'src/a.ts', threadId }, context())) as Record<string, unknown>;
    assert.equal(ok['ok'], true);
    assert.equal(ok['text'], 'export const a = 1;\n');

    // A body-less success would be indistinguishable from an empty file.
    const missing = (await read.execute({ action: 'read', path: 'src/gone.ts', threadId }, context())) as Record<string, unknown>;
    assert.equal(missing['ok'], false);
    assert.equal(missing['code'], 'NOT_READABLE');
    assert.match(String(missing['message']), /not on disk/);
  });

  it('needs a path to read and names an unknown action', async () => {
    const { engine } = await harness();
    await engine.init();
    const read = tool({ engineFor: () => Promise.resolve(engine), parentOf: () => PARENT }, 'project_library');
    const noPath = (await read.execute({ action: 'read' }, context())) as Record<string, unknown>;
    assert.equal(noPath['code'], 'INVALID_INPUT');
    const bad = (await read.execute({ action: 'delete' }, context())) as Record<string, unknown>;
    assert.match(String(bad['message']), /unknown action/);
  });

  it('returns an uninitialised result instead of throwing', async () => {
    const { engine } = await harness();
    const source = { engineFor: () => Promise.resolve(engine), parentOf: () => PARENT };
    const result = (await tool(source, 'project_library').execute({}, context())) as Record<string, unknown>;
    assert.equal(result['code'], 'PROJECT_NOT_INITIALIZED');
  });
});

describe('project_overview usage', () => {
  it('omits token spend unless asked, and reports it when asked', async () => {
    const usage: UsagePort = {
      async measure() {
        return {
          calls: 1,
          inputTokens: 5,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          models: [{ provider: 'p', model: 'm', calls: 1, inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }],
        };
      },
    };
    const { engine, runner, root } = await harness({ usage });
    await engine.init({ name: 'demo' });
    repoReady(runner);
    await engine.coordinate(PARENT, '- one', { planOnly: false });
    const overview = tool({ engineFor: () => Promise.resolve(engine), parentOf: () => PARENT }, 'project_overview');

    const cheap = (await overview.execute({ rootDir: root }, context())) as { usage?: unknown };
    assert.equal(cheap.usage, undefined);

    const full = (await overview.execute({ rootDir: root, usage: true }, context())) as {
      usage?: { totals?: { inputTokens?: number } };
    };
    assert.equal(full.usage?.totals?.inputTokens, 5);
  });
});

describe('project_knowledge browsing', () => {
  const sourceFor = (engine: ProjectEngine) => ({
    engineFor: () => Promise.resolve(engine),
    parentOf: () => PARENT,
  });

  it('advertises tree and read in the action enum', () => {
    const source = { engineFor: () => Promise.reject(new Error('unused')), parentOf: () => PARENT };
    const definition = tool(source, 'project_knowledge');
    const action = (definition.parameters['properties'] as Record<string, Record<string, unknown>>)['action'];
    assert.deepEqual(action?.['enum'], ['list', 'add', 'remove', 'rebuild', 'tree', 'read']);
    // The schema must document the window parameters, or the model cannot address a fragment.
    const properties = definition.parameters['properties'] as Record<string, unknown>;
    for (const key of ['path', 'depth', 'limit', 'from', 'lines']) {
      assert.ok(key in properties, `missing \`${key}\` parameter`);
    }
  });

  it('trees the project root and says the listings are complete', async () => {
    const { engine, root } = await harness();
    await engine.init({ name: 'demo' });
    await mkdir(join(root, 'kb'), { recursive: true });
    await writeFile(join(root, 'kb', 'deploy.md'), 'one\ntwo\n', 'utf8');

    const result = (await tool(sourceFor(engine), 'project_knowledge').execute(
      { action: 'tree', path: 'kb' },
      context(),
    )) as Record<string, unknown>;
    assert.equal(result['ok'], true);
    assert.deepEqual(result['entries'], [{ path: 'kb/deploy.md', kind: 'file', bytes: 8 }]);
    assert.equal(result['truncated'], false);
    assert.match(String(result['hint']), /project root/);
  });

  it('names the depth cap when the tree was cut', async () => {
    const { engine, root } = await harness();
    await engine.init({ name: 'demo' });
    await mkdir(join(root, 'a', 'b'), { recursive: true });
    await writeFile(join(root, 'a', 'b', 'deep.md'), 'x\n', 'utf8');

    const result = (await tool(sourceFor(engine), 'project_knowledge').execute(
      { action: 'tree', depth: 1 },
      context(),
    )) as Record<string, unknown>;
    assert.equal(result['truncated'], true);
    assert.match(String(result['note']), /depth 1/);
    // The hint has to carry the warning too: a model reading only the first line of the
    // result would otherwise take the partial listing as the whole project.
    assert.match(String(result['hint']), /Incomplete:/);
  });

  it('reads a line window and points at the next one', async () => {
    const { engine, root } = await harness();
    await engine.init({ name: 'demo' });
    await writeFile(join(root, 'note.md'), 'one\ntwo\nthree\n', 'utf8');

    const result = (await tool(sourceFor(engine), 'project_knowledge').execute(
      { action: 'read', path: 'note.md', from: 1, lines: 2 },
      context(),
    )) as Record<string, unknown>;
    assert.equal(result['ok'], true);
    assert.equal(result['from'], 1);
    assert.equal(result['to'], 2);
    assert.equal(result['totalLines'], 3);
    assert.equal(result['truncated'], true);
    assert.equal(result['text'], 'one\ntwo');
    assert.match(String(result['hint']), /from: 3/);
  });

  it('reports an escape as an error result instead of throwing', async () => {
    const { engine } = await harness();
    await engine.init({ name: 'demo' });
    const knowledge = tool(sourceFor(engine), 'project_knowledge');
    for (const args of [
      { action: 'tree', path: '../..' },
      { action: 'read', path: '../../etc/passwd' },
    ]) {
      // A thrown error ends the turn; an out-of-bounds path is the model's mistake to correct.
      const result = (await knowledge.execute(args, context())) as Record<string, unknown>;
      assert.equal(result['ok'], false);
      assert.equal(result['code'], 'INVALID_INPUT');
      assert.match(String(result['message']), /outside the project root/);
    }
  });

  it('requires a path for read', async () => {
    const { engine } = await harness();
    await engine.init({ name: 'demo' });
    const result = (await tool(sourceFor(engine), 'project_knowledge').execute(
      { action: 'read' },
      context(),
    )) as Record<string, unknown>;
    assert.equal(result['ok'], false);
    assert.equal(result['code'], 'INVALID_INPUT');
    assert.match(String(result['message']), /needs a path/);
  });
});
