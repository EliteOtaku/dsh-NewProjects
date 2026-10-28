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
