/**
 * The knowledge layer as the engine actually exposes it.
 *
 * These run against a real temporary directory because indexing reads real files and the
 * index is written with a rename; a fake filesystem would test the mock instead of the store.
 * What matters here is the wiring the unit tests cannot see: the manifest owns the bound
 * paths, the charter changes when the mode changes, and a rebuild is what makes new content
 * visible to a thread that already has its prompt.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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
    assert.equal(state.mode, 'context');
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

describe('automatic mode switching', () => {
  it('stays in context mode for a small project and puts the content in the charter', async () => {
    const root = await freshRoot();
    const { engine } = harness(root);
    await engine.init({ name: 'demo' });
    await writeFile(join(root, 'note.md'), 'the release window is Tuesday', 'utf8');
    await engine.setKnowledgePaths(['note.md']);

    const charter = await engine.renderCharter();
    assert.match(charter.text, /Project knowledge/);
    assert.match(charter.text, /release window is Tuesday/);
  });

  it('switches to retrieval once the knowledge exceeds the budget, and drops the content', async () => {
    const root = await freshRoot();
    const { engine } = harness(root);
    await engine.init({ name: 'demo' });
    await projectWithKnowledge(engine, 3, 400, 'secretword');
    await engine.setKnowledgePaths(['kb']);
    // A budget far below the content forces retrieval mode; the point is that nothing flips a
    // stored flag, the size alone decides.
    const state = await engine.buildKnowledge({ budgetChars: 100 });
    assert.equal(state.mode, 'rag');

    const charter = await engine.renderCharter();
    assert.match(charter.text, /retrieval mode/);
    assert.match(charter.text, /project_knowledge_search/);
    // The content must be gone from the prompt: otherwise retrieval buys no capacity.
    assert.doesNotMatch(charter.text, /secretword/);
  });

  it('converts back to context mode when the knowledge shrinks', async () => {
    const root = await freshRoot();
    const { engine } = harness(root);
    await engine.init({ name: 'demo' });
    await projectWithKnowledge(engine, 3, 400, 'shrinksignal');
    await engine.setKnowledgePaths(['kb']);
    const rag = await engine.buildKnowledge({ budgetChars: 100 });
    assert.equal(rag.mode, 'rag');

    // Drop every bound path: the project now holds nothing, so it cannot still be in RAG mode.
    const after = await engine.setKnowledgePaths([]);
    assert.equal(after.mode, 'context');
    assert.equal(after.docs, 0);
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
});

describe('search through the engine', () => {
  it('finds a passage and reports the mode it searched in', async () => {
    const root = await freshRoot();
    const { engine } = harness(root);
    await engine.init({ name: 'demo' });
    await writeFile(join(root, 'deploy.md'), 'The release window is Tuesday afternoon.', 'utf8');
    await writeFile(join(root, 'auth.md'), 'Tokens expire after one hour.', 'utf8');
    await engine.setKnowledgePaths(['deploy.md', 'auth.md']);

    const result = await engine.searchProjectKnowledge('release window');
    assert.equal(result.state.mode, 'context');
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
  it('reports knowledge mode and a summary on the panel payload', async () => {
    const root = await freshRoot();
    const { engine } = harness(root);
    await engine.init({ name: 'demo' });
    await writeFile(join(root, 'note.md'), 'short note', 'utf8');
    await engine.setKnowledgePaths(['note.md']);

    const json = await engine.overviewJson();
    const knowledge = json.knowledge as { mode: string; docs: number; summary: string } | undefined;
    assert.ok(knowledge !== undefined);
    assert.equal(knowledge.mode, 'context');
    assert.equal(knowledge.docs, 1);
    assert.match(knowledge.summary, /loaded in full/);
  });
});
