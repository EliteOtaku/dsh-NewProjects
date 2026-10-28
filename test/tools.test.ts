/**
 * The model-facing tools, exercised through their real `execute`.
 *
 * Two properties matter more than any single payload: a tool must never throw for an
 * expected state (a thrown error ends the turn, and "no project yet" is not an error the
 * model should die on), and it must resolve its engine from the `rootDir` it was given so
 * one plugin can serve several workspaces.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { ProjectEngine } from '../src/core/engine.js';
import { buildTools } from '../src/host/tools.js';
import type { HostToolDefinition, HostToolRunContext } from '../src/host/hostTypes.js';
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
async function harness(): Promise<{ engine: ProjectEngine; runner: FakeRunner; threads: FakeThreads; root: string }> {
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
});
