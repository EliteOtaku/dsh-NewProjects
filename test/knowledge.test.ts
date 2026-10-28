/**
 * The knowledge layer as the engine actually exposes it.
 *
 * These run against a real temporary directory because indexing reads real files and the
 * index is written with a rename; a fake filesystem would test the mock instead of the store.
 * What matters here is the wiring the unit tests cannot see: the manifest owns the bound
 * paths, the charter lists the catalogue without ever carrying a document body, and a
 * rebuild is what makes a newly added file appear in that catalogue.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { ProjectEngine } from '../src/core/engine.js';
import { FakeRunner, FakeThreads, fixedClock, sequentialIds } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const cleanup of cleanups) await cleanup();
});

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-project-kbengine-'));
  cleanups.push(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function harness(root: string): { engine: ProjectEngine; runner: FakeRunner } {
  const runner = new FakeRunner();
  runner.on('git rev-parse --git-dir', { exitCode: 1 });
  const engine = new ProjectEngine(root, {
    runner,
    threads: new FakeThreads(),
    clock: fixedClock(),
    ids: sequentialIds(),
    quotaLedgerPath: join(root, 'quota-ledger.json'),
  });
  return { engine, runner };
}

/** A project with a knowledge folder of `count` documents of `chars` characters each. */
async function projectWithKnowledge(
  engine: ProjectEngine,
  count: number,
  chars: number,
  subject = 'deployment',
): Promise<void> {
  const manifest = await engine.requireManifest();
  const folder = join(manifest.rootDir, 'kb');
  await mkdir(folder, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    const body = `${subject} note ${String(index)}\n\n${'detail '.repeat(Math.ceil(chars / 7))}`;
    await writeFile(join(folder, `note-${String(index)}.md`), body, 'utf8');
  }
}

describe('knowledge binding', () => {
  it('starts unbound and reports that plainly', async () => {
    const root = await freshRoot();
    const { engine } = harness(root);
    await engine.init({ name: 'demo' });
    const { index, state } = await engine.knowledgeState();
    assert.equal(index.docs.length, 0);
    assert.equal(state.docs, 0);
    assert.equal(state.totalChars, 0);
  });

  it('binds a folder and indexes every readable file', async () => {
    const root = await freshRoot();
    const { engine } = harness(root);
    await engine.init({ name: 'demo' });
    await projectWithKnowledge(engine, 2, 100);
    const state = await engine.setKnowledgePaths(['kb']);
    assert.equal(state.docs, 2);
    assert.ok(state.totalChars > 0);
  });

  it('persists the bound paths in the manifest, not just in memory', async () => {
    const root = await freshRoot();
    const { engine } = harness(root);
    await engine.init({ name: 'demo' });
    await engine.addKnowledgePaths(['kb', 'docs/notes.md']);
    // A second engine models a reload: the binding must come back from disk.
    const reloaded = harness(root).engine;
    const manifest = await reloaded.requireManifest();
    assert.deepEqual(manifest.knowledgePaths, ['kb', 'docs/notes.md']);
  });

  it('reports which paths were actually added or removed', async () => {
    const root = await freshRoot();
    const { engine } = harness(root);
    await engine.init({ name: 'demo' });
    await projectWithKnowledge(engine, 1, 50);

    const added = await engine.addKnowledgePaths(['kb', 'kb', '  ']);
    assert.deepEqual(added.added, ['kb']);
    const again = await engine.addKnowledgePaths(['kb']);
    assert.deepEqual(again.added, []);

    const removed = await engine.removeKnowledgePaths(['kb', 'never-bound']);
    assert.deepEqual(removed.removed, ['kb']);
    const noneLeft = await engine.removeKnowledgePaths(['kb']);
    assert.deepEqual(noneLeft.removed, []);
  });

  it('warns when the bound paths yield nothing readable', async () => {
    const root = await freshRoot();
    const { engine } = harness(root);
    await engine.init({ name: 'demo' });
    const state = await engine.setKnowledgePaths(['missing-folder']);
    assert.equal(state.docs, 0);
    assert.match(state.warnings.join('\n'), /does not exist/);
  });

  it('writes the index next to the manifest and keeps it out of git', async () => {
    const root = await freshRoot();
    const { engine } = harness(root);
    await engine.init({ name: 'demo' });
    await projectWithKnowledge(engine, 1, 40);
    await engine.setKnowledgePaths(['kb']);
    const entries = await readdir(join(root, '.dsh-project'));
    assert.ok(entries.includes('KNOWLEDGE_INDEX.json'));
    const gitignore = await readdir(join(root, '.dsh-project'));
    assert.ok(gitignore.includes('.gitignore'));
  });
});

describe('paths-first knowledge', () => {
  it('lists each document in the charter and never its body', async () => {
    const root = await freshRoot();
    const { engine } = harness(root);
    await engine.init({ name: 'demo' });
    await writeFile(join(root, 'note.md'), 'the release window is Tuesday', 'utf8');
    await engine.setKnowledgePaths(['note.md']);

    const charter = await engine.renderCharter();
    assert.match(charter.text, /Project knowledge/);
    // The catalogue entry is there...
    assert.match(charter.text, /`note\.md` — \d+ chars/);
    // ...and the body is not. This is the whole of paths-first: a thread reads the file, so
    // a file edited after the last rebuild cannot produce a stale answer from the prefix.
    assert.doesNotMatch(charter.text, /release window is Tuesday/);
  });

  it('keeps the charter the same size as the knowledge grows', async () => {
    const root = await freshRoot();
    const { engine } = harness(root);
    await engine.init({ name: 'demo' });
    await writeFile(join(root, 'small.md'), 'tiny', 'utf8');
    await engine.setKnowledgePaths(['small.md']);
    const small = (await engine.renderCharter()).text.length;

    // Two orders of magnitude more content, same single document: the charter must not grow
    // with it, because the body never enters the prompt. Under the old context mode this
    // assertion was false by construction.
    await writeFile(join(root, 'small.md'), 'detail '.repeat(20_000), 'utf8');
    await engine.buildKnowledge();
    const large = (await engine.renderCharter()).text.length;

    // Only the character count in the catalogue line differs.
    assert.ok(large - small < 40, `charter grew by ${String(large - small)} chars`);
  });

  it('falls back to the bare path list when nothing has been indexed yet', async () => {
    const root = await freshRoot();
    const { engine } = harness(root);
    await engine.init({ name: 'demo', knowledgePaths: ['kb'] });
    const charter = await engine.renderCharter();
    assert.match(charter.text, /Project knowledge/);
    assert.match(charter.text, /`kb`/);
  });

  it('points the thread at the file rather than at the index', async () => {
    const root = await freshRoot();
    const { engine } = harness(root);
    await engine.init({ name: 'demo' });
    await writeFile(join(root, 'note.md'), 'anything', 'utf8');
    await engine.setKnowledgePaths(['note.md']);
    const charter = await engine.renderCharter();
    assert.match(charter.text, /file on disk is authoritative/);
    assert.match(charter.text, /project_knowledge_search/);
  });

  it('rebuilds so new content becomes visible without restarting', async () => {
    const root = await freshRoot();
    const { engine } = harness(root);
    await engine.init({ name: 'demo' });
    await engine.setKnowledgePaths(['kb']);
    const before = await engine.knowledgeState();
    assert.equal(before.index.docs.length, 0);

    await projectWithKnowledge(engine, 2, 30, 'freshdoc');
    const state = await engine.buildKnowledge();
    assert.equal(state.docs, 2);

    const hits = await engine.searchProjectKnowledge('freshdoc');
    assert.ok(hits.hits.length > 0);
  });

  it('drops the section entirely once every path is unbound', async () => {
    const root = await freshRoot();
    const { engine } = harness(root);
    await engine.init({ name: 'demo' });
    await projectWithKnowledge(engine, 2, 40, 'gonesoon');
    await engine.setKnowledgePaths(['kb']);
    assert.match((await engine.renderCharter()).text, /Project knowledge/);

    const after = await engine.setKnowledgePaths([]);
    assert.equal(after.docs, 0);
    assert.doesNotMatch((await engine.renderCharter()).text, /Project knowledge/);
  });
});

describe('search through the engine', () => {
  it('finds a passage and cites the file it came from', async () => {
    const root = await freshRoot();
    const { engine } = harness(root);
    await engine.init({ name: 'demo' });
    await writeFile(join(root, 'deploy.md'), 'The release window is Tuesday afternoon.', 'utf8');
    await writeFile(join(root, 'auth.md'), 'Tokens expire after one hour.', 'utf8');
    await engine.setKnowledgePaths(['deploy.md', 'auth.md']);

    const result = await engine.searchProjectKnowledge('release window');
    assert.ok(result.hits.length > 0);
    assert.equal(result.hits[0]?.path, 'deploy.md');
  });

  it('rejects an empty query rather than returning the whole index', async () => {
    const root = await freshRoot();
    const { engine } = harness(root);
    await engine.init({ name: 'demo' });
    await assert.rejects(
      engine.searchProjectKnowledge('   '),
      (error: unknown) => (error as { code?: string }).code === 'INVALID_INPUT',
    );
  });

  it('searches an empty index without failing', async () => {
    const root = await freshRoot();
    const { engine } = harness(root);
    await engine.init({ name: 'demo' });
    const result = await engine.searchProjectKnowledge('anything');
    assert.deepEqual(result.hits, []);
  });
});

describe('overview', () => {
  it('reports the knowledge catalogue and a summary on the panel payload', async () => {
    const root = await freshRoot();
    const { engine } = harness(root);
    await engine.init({ name: 'demo' });
    await writeFile(join(root, 'note.md'), 'short note', 'utf8');
    await engine.setKnowledgePaths(['note.md']);

    const json = await engine.overviewJson();
    const knowledge = json.knowledge as { docs: number; summary: string; builtAt: number } | undefined;
    assert.ok(knowledge !== undefined);
    assert.equal(knowledge.docs, 1);
    assert.ok(knowledge.builtAt > 0);
    assert.match(knowledge.summary, /read from disk on demand/);
    // No mode, no budget, no capacity: the payload cannot report a dimension that is gone.
    assert.equal((knowledge as Record<string, unknown>).mode, undefined);
    assert.equal((knowledge as Record<string, unknown>).budgetChars, undefined);
  });
});

/**
 * GAP-22a — the catalogue must be reachable from a thread's working directory.
 *
 * A thread runs in its own worktree, and a worktree holds only what was committed when the
 * branch was cut. So the failure this guards against is not "the path is spelled oddly"; it is
 * that the same relative path means two different things in the two directories, and only the
 * project root is guaranteed to have the file.
 */
describe('knowledge paths are anchored to the project root', () => {
  /** Pull the stated root and the catalogued documents back out of a rendered charter. */
  function parseCharter(charter: string): { root: string; docs: string[] } {
    const root = /Project root: `([^`]+)`/.exec(charter)?.[1];
    assert.ok(root !== undefined, 'the charter must state the project root');
    const docs: string[] = [];
    for (const match of charter.matchAll(/^- `(.+?)` — \d+ chars$/gm)) {
      if (match[1] !== undefined) docs.push(match[1]);
    }
    return { root, docs };
  }

  it('lets a thread in a worktree reach every catalogued document', async () => {
    const root = await freshRoot();
    const { engine } = harness(root);
    await engine.init({ name: 'anchor-demo' });

    await mkdir(join(root, 'kb'), { recursive: true });
    await writeFile(join(root, 'kb', 'arch.md'), 'the architecture', 'utf8');
    await writeFile(join(root, 'kb', 'ops.md'), 'how to deploy', 'utf8');
    await engine.setKnowledgePaths(['kb']);

    const charter = (await engine.renderCharter()).text;
    const { root: stated, docs } = parseCharter(charter);
    assert.ok(docs.length >= 2, 'both documents should be catalogued');

    // A worktree cut before those files were committed: the same relative paths are absent
    // there. This is the state every thread starts in when the knowledge was added afterwards.
    const worktree = join(root, '.dsh-project', 'worktrees', 'thr-1');
    await mkdir(worktree, { recursive: true });

    for (const doc of docs) {
      const atRoot = await stat(join(stated, doc)).catch(() => undefined);
      assert.ok(atRoot?.isFile() === true, `${doc} must be readable under the stated root`);
      const inWorktree = await stat(join(worktree, doc)).catch(() => undefined);
      assert.equal(inWorktree, undefined, `${doc} should not exist in the worktree, which is why the anchor matters`);
    }
  });

  it('states the root even when nothing has been indexed yet', async () => {
    const root = await freshRoot();
    const { engine } = harness(root);
    await engine.init({ name: 'anchor-demo' });
    // Bound but never indexed: the fallback branch is what a thread sees before the first
    // rebuild, and it is the one that used to be a bare list of unresolvable relatives.
    await engine.setKnowledgePaths(['kb']);

    const charter = (await engine.renderCharter()).text;
    assert.match(charter, /Project root: `/);
    assert.match(charter, /- `kb`/);
  });

  it('carries the root on search hits, because a citation is only usable with it', async () => {
    const root = await freshRoot();
    const { engine } = harness(root);
    await engine.init({ name: 'anchor-demo' });
    await writeFile(join(root, 'kb.md'), 'the deployment runbook', 'utf8');
    await engine.setKnowledgePaths(['kb.md']);

    const result = await engine.searchProjectKnowledge('deployment');
    assert.equal(result.rootDir, root);
    assert.ok(result.hits.length > 0);
    const hit = result.hits[0];
    assert.ok(hit !== undefined);
    const resolved = await stat(join(result.rootDir, hit.path)).catch(() => undefined);
    assert.ok(resolved?.isFile() === true, 'a cited path must resolve under the returned root');
  });
});
