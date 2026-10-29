/**
 * The `/project` command family, exercised through its real handler.
 *
 * Commands bypass the model, so their whole contract is "given this input line, produce
 * this text or this error". They are tested against a real `ProjectEngine` over a temp
 * root, because the handlers read and write the manifest for real.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { ProjectEngine } from '../src/core/engine.js';
import type { HostCommandDefinition } from '../src/host/hostTypes.js';
import { PROJECT_USAGE, buildCommands } from '../src/host/commands.js';
import { FakeRunner, FakeThreads, fixedClock, sequentialIds } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const cleanup of cleanups) await cleanup();
});

const PARENT = { id: 'session-parent' };

/** Run one `/project ...` line through the real handler. */
async function run(engine: ProjectEngine, rawInput: string): Promise<{ kind: string; text: string }> {
  const [definition] = buildCommands({
    engineFor: () => Promise.resolve(engine),
  }) as HostCommandDefinition[];
  assert.ok(definition !== undefined);
  const result = await definition.handler({
    commandId: 'cmd-1',
    agent: PARENT,
    rawInput,
    attachments: [],
    signal: AbortSignal.timeout(5000),
  });
  return { kind: result.kind, text: result.text ?? '' };
}

/** A project over a fresh temp root, not yet initialised. */
async function harness(): Promise<{ engine: ProjectEngine; runner: FakeRunner; threads: FakeThreads }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-project-cmd-'));
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
  return { engine, runner, threads };
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

describe('/project verb routing', () => {
  it('defaults an empty invocation to the overview', async () => {
    const { engine } = await harness();
    await engine.init({ name: 'demo' });
    const result = await run(engine, '');
    assert.equal(result.kind, 'success');
    assert.match(result.text, /0\/200/);
  });

  it('treats "overview" as the same verb as no input', async () => {
    const { engine } = await harness();
    await engine.init({ name: 'demo' });
    assert.match((await run(engine, 'overview')).text, /0\/200/);
  });

  it('shows the usage text for help', async () => {
    const { engine } = await harness();
    assert.equal((await run(engine, 'help')).text, PROJECT_USAGE);
  });

  it('rejects an unknown verb with the usage text attached', async () => {
    const { engine } = await harness();
    const result = await run(engine, 'frobnicate');
    assert.equal(result.kind, 'error');
    assert.match(result.text, /unknown verb "frobnicate"/);
    assert.match(result.text, /\/project init/);
  });
});

describe('/project init and deinit', () => {
  it('creates a project and names the record path', async () => {
    const { engine } = await harness();
    const result = await run(engine, 'init my-service');
    assert.equal(result.kind, 'success');
    assert.match(result.text, /initialised project `my-service`/);
    assert.match(result.text, /manifest\.json/);
    assert.equal((await engine.requireManifest()).name, 'my-service');
  });

  it('derives the name from the directory when none is given', async () => {
    const { engine } = await harness();
    const result = await run(engine, 'init');
    assert.equal(result.kind, 'success');
    assert.ok((await engine.requireManifest()).name.length > 0);
  });

  it('refuses to overwrite an existing record', async () => {
    const { engine } = await harness();
    await run(engine, 'init');
    const again = await run(engine, 'init other');
    assert.equal(again.kind, 'error');
    assert.match(again.text, /PROJECT_NOT_INITIALIZED|already/i);
  });

  it('warns that running threads survive deinit', async () => {
    // The descriptors are gone but the child sessions are not, and a user who believes
    // deinit stopped the work would be surprised by later commits.
    const { engine } = await harness();
    await run(engine, 'init');
    const result = await run(engine, 'deinit');
    assert.equal(result.kind, 'success');
    assert.match(result.text, /keep running/);
    assert.equal(await engine.isInitialised(), false);
  });
});

describe('/project memory', () => {
  it('says there is nothing yet on an empty project', async () => {
    const { engine } = await harness();
    await run(engine, 'init');
    assert.match((await run(engine, 'memory')).text, /no shared decisions yet/);
  });

  it('stores a decision from `key = value` and reports the revision', async () => {
    const { engine } = await harness();
    await run(engine, 'init');
    const result = await run(engine, 'memory stack = TypeScript on Node');
    assert.equal(result.kind, 'success');
    assert.match(result.text, /stored `stack` \(revision 1\)/);
  });

  it('accepts surrounding whitespace around the equals sign', async () => {
    const { engine } = await harness();
    await run(engine, 'init');
    await run(engine, 'memory   tests  =   node --test  ');
    const entries = await engine.listMemory();
    assert.equal(entries[0]?.key, 'tests');
    assert.equal(entries[0]?.decision, 'node --test');
  });

  it('lists what was stored, including the author', async () => {
    const { engine } = await harness();
    await run(engine, 'init');
    await run(engine, 'memory stack = TypeScript on Node');
    const listed = await run(engine, 'memory');
    assert.match(listed.text, /`stack` \(r1, by coordinator\)/);
    assert.match(listed.text, /TypeScript on Node/);
  });

  it('does not treat a plain phrase as an assignment', async () => {
    // Without this guard every listing typo would silently become an empty-key write.
    const { engine } = await harness();
    await run(engine, 'init');
    const result = await run(engine, 'memory just some words');
    assert.equal(result.kind, 'success');
    assert.match(result.text, /no shared decisions yet/);
  });

  it('removes a decision by key and says how many threads it told', async () => {
    const { engine } = await harness();
    await run(engine, 'init');
    await run(engine, 'memory stack = TypeScript');
    const removed = await run(engine, 'memory rm stack');
    assert.equal(removed.kind, 'success');
    assert.match(removed.text, /removed `stack`; notified 0 live thread\(s\)/);
    assert.deepEqual(await engine.listMemory(), []);
  });

  it('reports an unknown key instead of silently succeeding', async () => {
    const { engine } = await harness();
    await run(engine, 'init');
    const result = await run(engine, 'memory rm nope');
    assert.equal(result.kind, 'error');
    assert.match(result.text, /no shared decision named `nope`/);
  });
});

describe('/project threads and thread', () => {
  it('says there are no threads on a fresh project', async () => {
    const { engine } = await harness();
    await run(engine, 'init');
    assert.match((await run(engine, 'threads')).text, /no threads yet/);
  });

  it('lists a started thread with its branch', async () => {
    const { engine, runner } = await harness();
    await run(engine, 'init');
    repoReady(runner);
    await run(engine, 'coordinate - one\n- two');
    // coordinate only proposes; starting is a separate, explicit step.
    await run(engine, 'start');
    const listed = await run(engine, 'threads');
    assert.match(listed.text, /one/);
    // The branch carries the task ordinal, which is what keeps two same-titled tasks from
    // landing on one branch.
    assert.match(listed.text, /\/1-one/);
  });

  it('coordinate reports planned, started and quota', async () => {
    const { engine, runner } = await harness();
    await run(engine, 'init');
    repoReady(runner);
    const proposed = await run(engine, 'coordinate - one\n- two');
    // The command path bypasses the model, so its split is a guess and stays proposed.
    assert.match(proposed.text, /planned 2, started 0, skipped 0/);
    assert.match(proposed.text, /1\. one/);
    const result = await run(engine, 'start');
    assert.match(result.text, /started 2, skipped 0, still proposed 0/);
    assert.match(result.text, /quota 2\/200/);
  });

  it('coordinate demands a goal', async () => {
    const { engine } = await harness();
    await run(engine, 'init');
    const result = await run(engine, 'coordinate');
    assert.equal(result.kind, 'error');
    assert.match(result.text, /usage: `\/project coordinate <goal>`/);
  });

  it('thread without an action inspects it', async () => {
    const { engine, runner } = await harness();
    await run(engine, 'init');
    repoReady(runner);
    const coordinated = await run(engine, 'coordinate - one\n- two');
    assert.match(coordinated.text, /planned 2, started 0, skipped 0/);
    assert.match(coordinated.text, /nothing started/);
    const started = await run(engine, 'start');
    const threadId = /started `([^`]+)`/.exec(started.text)?.[1] ?? '';
    const inspected = await run(engine, `thread ${threadId}`);
    assert.equal(inspected.kind, 'success');
    assert.match(inspected.text, /one/);
  });

  it('thread steer passes the message through', async () => {
    const { engine, runner, threads } = await harness();
    await run(engine, 'init');
    repoReady(runner);
    await run(engine, 'coordinate - one\n- two');
    const started = await run(engine, 'start');
    const threadId = /started `([^`]+)`/.exec(started.text)?.[1] ?? '';
    const result = await run(engine, `thread ${threadId} steer add a test`);
    assert.equal(result.kind, 'success');
    assert.equal(threads.steers[0]?.text, 'add a test');
  });

  it('thread demands an id', async () => {
    const { engine } = await harness();
    await run(engine, 'init');
    const result = await run(engine, 'thread');
    assert.equal(result.kind, 'error');
    assert.match(result.text, /usage: `\/project thread <id>/);
  });

  it('thread reports an unknown id as an error', async () => {
    const { engine } = await harness();
    await run(engine, 'init');
    const result = await run(engine, 'thread thr-999 inspect');
    assert.equal(result.kind, 'error');
    assert.match(result.text, /THREAD_NOT_FOUND/);
  });
});

describe('/project pause', () => {
  it('stops the project, reports why, and lifts on resume', async () => {
    const { engine } = await harness();
    await run(engine, 'init');

    const paused = await run(engine, 'pause machine is busy');
    assert.equal(paused.kind, 'success');
    assert.match(paused.text, /paused: machine is busy/);
    assert.match(paused.text, /\/project resume/);

    const refused = await run(engine, 'coordinate - one');
    assert.equal(refused.kind, 'error');
    assert.match(refused.text, /paused/);

    const swept = await run(engine, 'heal');
    assert.match(swept.text, /paused: machine is busy/);

    const resumed = await run(engine, 'resume');
    assert.equal(resumed.kind, 'success');
    assert.match(resumed.text, /resumed/);

    const again = await run(engine, 'resume');
    assert.match(again.text, /not paused/);
  });
});

describe('/project goal', () => {
  it('sets, reads, and clears the goal', async () => {
    const { engine } = await harness();
    await run(engine, 'init');

    const empty = await run(engine, 'goal');
    assert.match(empty.text, /no goal set/);

    const set = await run(engine, 'goal ship the beta');
    assert.equal(set.kind, 'success');
    assert.match(set.text, /goal set: ship the beta/);

    const read = await run(engine, 'goal');
    assert.match(read.text, /goal: ship the beta/);

    const unchanged = await run(engine, 'goal ship the beta');
    assert.match(unchanged.text, /goal unchanged/);

    const cleared = await run(engine, 'goal clear');
    assert.match(cleared.text, /goal cleared/);
    assert.equal(await engine.goal(), undefined);
  });

  it('lists recent coordinator messages after the goal', async () => {
    const { engine } = await harness();
    await run(engine, 'init');
    await run(engine, 'memory db = postgres');
    const read = await run(engine, 'goal');
    assert.match(read.text, /recent coordinator messages/);
    assert.match(read.text, /memory db: postgres/);
  });

  it('requires a project record', async () => {
    const { engine } = await harness();
    const result = await run(engine, 'goal ship it');
    assert.equal(result.kind, 'error');
    assert.match(result.text, /\/project init/);
  });
});

describe('/project heal', () => {
  it('summarises a sweep with nothing to do', async () => {
    const { engine } = await harness();
    await run(engine, 'init');
    const result = await run(engine, 'heal');
    assert.equal(result.kind, 'success');
    assert.match(result.text, /observed 0 thread\(s\)/);
    assert.match(result.text, /healed 0/);
  });
});

describe('/project without a project record', () => {
  it('tells the caller to init first rather than failing obscurely', async () => {
    const { engine } = await harness();
    for (const verb of ['', 'overview', 'memory', 'threads', 'heal']) {
      const result = await run(engine, verb);
      assert.equal(result.kind, 'error', `"${verb}" should fail without a record`);
      assert.match(result.text, /run `\/project init` first/);
    }
  });

  it('lets init and deinit run without a record', async () => {
    // These are the two verbs that must work before and after the record exists.
    const { engine } = await harness();
    assert.equal((await run(engine, 'init')).kind, 'success');
    assert.equal((await run(engine, 'deinit')).kind, 'success');
  });
});

describe('/project library', () => {
  it('says the library is empty before any thread delivers', async () => {
    const { engine } = await harness();
    await engine.init({ name: 'demo' });
    const result = await run(engine, 'library');
    assert.equal(result.kind, 'success');
    assert.match(result.text, /no files yet/);
  });

  it('lists a produced file with its change and the thread that made it', async () => {
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

    const result = await run(engine, 'library');
    assert.equal(result.kind, 'success');
    assert.match(result.text, /src\/a\.ts/);
    assert.match(result.text, /added/);
    assert.match(result.text, new RegExp(threadId));
  });

  it('explains a file whose bytes are gone instead of printing nothing', async () => {
    const { engine } = await harness();
    await engine.init({ name: 'demo' });
    const result = await run(engine, 'library read src/a.ts');
    assert.equal(result.kind, 'error');
    assert.match(result.text, /not readable/);
    assert.match(result.text, /not on disk/);
  });

  it('needs a path and names an unknown verb', async () => {
    const { engine } = await harness();
    await engine.init({ name: 'demo' });
    const noPath = await run(engine, 'library read');
    assert.equal(noPath.kind, 'error');
    assert.match(noPath.text, /needs a path/);
    const unknown = await run(engine, 'library prune');
    assert.equal(unknown.kind, 'error');
    assert.match(unknown.text, /unknown library verb/);
    assert.match(unknown.text, /\/project library read <path>/);
  });
});
