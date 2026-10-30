/**
 * Browsing bound knowledge as a folder: `tree`, `read`, and the staleness stamp.
 *
 * These are the entry points a thread reaches for when a keyword search misses. Their two
 * jobs are to say what they did not show (a cap that is not named reads as a complete
 * answer) and to refuse to leave the project root (knowledge is a window onto the project,
 * not onto the disk). Both are asserted here rather than trusted to review.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';

import { ProjectError } from '../../src/core/errors.js';
import {
  DEFAULT_READ_LINES,
  knowledgeStamp,
  listKnowledgeTree,
  MAX_KNOWLEDGE_FILE_BYTES,
  MAX_READ_LINES,
  MAX_TREE_DEPTH,
  MAX_TREE_LIMIT,
  readKnowledgeFile,
} from '../../src/core/knowledgeSource.js';

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-project-kbfiles-'));
  roots.push(root);
  return root;
}

/** Assert a rejection is a ProjectError with the expected code and message shape. */
async function rejectsWith(run: () => Promise<unknown>, code: string, pattern: RegExp): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof ProjectError, `expected ProjectError, got ${String(error)}`);
    assert.equal(error.code, code);
    assert.match(error.message, pattern);
    return true;
  });
}

describe('knowledge tree', () => {
  it('lists directories and files relative to the root, sorted by path', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'kb', 'nested'), { recursive: true });
    await writeFile(join(root, 'kb', 'b.md'), 'bravo\n', 'utf8');
    await writeFile(join(root, 'kb', 'a.md'), 'alpha\n', 'utf8');
    await writeFile(join(root, 'kb', 'nested', 'c.md'), 'charlie\n', 'utf8');

    const tree = await listKnowledgeTree(root, { depth: 3 });
    assert.equal(tree.path, '.');
    assert.deepEqual(
      tree.entries.map((entry) => [entry.path, entry.kind]),
      [
        ['kb', 'dir'],
        ['kb/a.md', 'file'],
        ['kb/b.md', 'file'],
        ['kb/nested', 'dir'],
        ['kb/nested/c.md', 'file'],
      ],
    );
    // Two calls must agree down to the byte, or a model that re-reads sees a different tree.
    assert.deepEqual(tree.entries, (await listKnowledgeTree(root, { depth: 3 })).entries);
    assert.equal(tree.truncated, false);
    assert.equal(tree.note, '');
    const sized = tree.entries.find((entry) => entry.path === 'kb/a.md');
    assert.equal(sized?.bytes, 6);
    // Directories carry no byte count: their size is a filesystem detail, not a fact about the folder.
    assert.equal(tree.entries.find((entry) => entry.path === 'kb')?.bytes, undefined);
  });

  it('hides ignored directories and binary files', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await mkdir(join(root, 'dist'), { recursive: true });
    await mkdir(join(root, '.git'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n', 'utf8');
    await writeFile(join(root, 'dist', 'bundle.js'), 'x\n', 'utf8');
    await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    await writeFile(join(root, 'logo.png'), 'not really a png\n', 'utf8');
    await writeFile(join(root, 'notes.md'), 'real\n', 'utf8');

    const tree = await listKnowledgeTree(root, { depth: 4 });
    assert.deepEqual(
      tree.entries.map((entry) => entry.path),
      ['notes.md'],
    );
  });

  it('names the depth cap instead of pretending the tree ended', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'a', 'b', 'c'), { recursive: true });
    await writeFile(join(root, 'a', 'b', 'c', 'deep.md'), 'deep\n', 'utf8');

    const tree = await listKnowledgeTree(root, { depth: 1 });
    assert.equal(tree.truncated, true);
    assert.match(tree.note, /depth 1/);
    assert.match(tree.note, new RegExp(`max ${String(MAX_TREE_DEPTH)}`));
    // `a` is listed; its children are not, and the note is what says so.
    assert.deepEqual(
      tree.entries.map((entry) => entry.path),
      ['a'],
    );
  });

  it('names the entry cap and stops at it', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'many'), { recursive: true });
    for (let index = 0; index < 6; index += 1) {
      await writeFile(join(root, 'many', `f-${String(index)}.md`), 'x\n', 'utf8');
    }

    const tree = await listKnowledgeTree(root, { limit: 3 });
    assert.equal(tree.entries.length, 3);
    assert.equal(tree.truncated, true);
    assert.match(tree.note, /3-entry limit/);
    assert.match(tree.note, new RegExp(`max ${String(MAX_TREE_LIMIT)}`));
  });

  it('clamps a nonsensical depth instead of returning nothing', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'a', 'b'), { recursive: true });
    await writeFile(join(root, 'a', 'b', 'f.md'), 'x\n', 'utf8');

    const tree = await listKnowledgeTree(root, { depth: 99 });
    assert.equal(tree.depth, MAX_TREE_DEPTH);
    assert.deepEqual(
      tree.entries.map((entry) => entry.path),
      ['a', 'a/b', 'a/b/f.md'],
    );
  });

  it('refuses to escape the project root', async () => {
    const root = await tempRoot();
    await rejectsWith(() => listKnowledgeTree(root, { path: '../elsewhere' }), 'INVALID_INPUT', /outside the project root/);
    await rejectsWith(() => listKnowledgeTree(root, { path: resolve(root, '..') }), 'INVALID_INPUT', /outside the project root/);
    await rejectsWith(() => listKnowledgeTree(root, { path: '' }), 'INVALID_INPUT', /path must not be empty/);
  });

  it('accepts a path that only looks like an escape', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'kb'), { recursive: true });
    await writeFile(join(root, 'kb', 'note.md'), 'note\n', 'utf8');
    const tree = await listKnowledgeTree(root, { path: 'kb/../kb' });
    assert.equal(tree.path, 'kb');
    assert.deepEqual(
      tree.entries.map((entry) => entry.path),
      ['kb/note.md'],
    );
  });

  it('reports a missing path and points a file at read', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'note.md'), 'note\n', 'utf8');
    await rejectsWith(() => listKnowledgeTree(root, { path: 'nope' }), 'INVALID_INPUT', /does not exist/);
    await rejectsWith(() => listKnowledgeTree(root, { path: 'note.md' }), 'INVALID_INPUT', /use action "read"/);
  });
});

describe('knowledge read', () => {
  it('returns a 1-based line window and says whether lines remain', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'note.md'), 'one\ntwo\nthree\n', 'utf8');

    const first = await readKnowledgeFile(root, { path: 'note.md', from: 1, lines: 2 });
    assert.equal(first.path, 'note.md');
    assert.equal(first.from, 1);
    assert.equal(first.to, 2);
    assert.equal(first.totalLines, 3);
    assert.equal(first.truncated, true);
    assert.equal(first.text, 'one\ntwo');

    const rest = await readKnowledgeFile(root, { path: 'note.md', from: 3, lines: 2 });
    assert.equal(rest.to, 3);
    assert.equal(rest.truncated, false);
    assert.equal(rest.text, 'three');
  });

  it('starts at line 1 by default and caps the window', async () => {
    const root = await tempRoot();
    const lines = Array.from({ length: MAX_READ_LINES + 5 }, (_, index) => `line ${String(index + 1)}`);
    await writeFile(join(root, 'long.md'), `${lines.join('\n')}\n`, 'utf8');

    // Default window: 200 lines, not the whole file.
    const byDefault = await readKnowledgeFile(root, { path: 'long.md' });
    assert.equal(byDefault.from, 1);
    assert.equal(byDefault.to, DEFAULT_READ_LINES);
    assert.equal(byDefault.truncated, true);

    // A request beyond the cap is clamped, and the result says where it stopped.
    const capped = await readKnowledgeFile(root, { path: 'long.md', lines: 99_999 });
    assert.equal(capped.to, MAX_READ_LINES);
    assert.equal(capped.truncated, true);
  });

  it('handles an empty file without inventing a line', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'empty.md'), '', 'utf8');
    const slice = await readKnowledgeFile(root, { path: 'empty.md' });
    assert.equal(slice.totalLines, 0);
    assert.equal(slice.to, 0);
    assert.equal(slice.truncated, false);
    assert.equal(slice.text, '');
  });

  it('normalises CRLF and ignores one trailing newline', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'crlf.md'), 'alpha\r\nbeta\r\n', 'utf8');
    const slice = await readKnowledgeFile(root, { path: 'crlf.md' });
    assert.equal(slice.totalLines, 2);
    assert.equal(slice.text, 'alpha\nbeta');
  });

  it('refuses binary content', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'blob.dat'), 'text\u0000more', 'utf8');
    await rejectsWith(() => readKnowledgeFile(root, { path: 'blob.dat' }), 'INVALID_INPUT', /binary/);
  });

  it('refuses an oversize file unless a window was asked for, then names the window', async () => {
    const root = await tempRoot();
    const body = `${'x'.repeat(MAX_KNOWLEDGE_FILE_BYTES)}\nsmall tail\n`;
    await writeFile(join(root, 'huge.log'), body, 'utf8');

    await rejectsWith(
      () => readKnowledgeFile(root, { path: 'huge.log' }),
      'INVALID_INPUT',
      /pass `from` and\/or `lines`/,
    );
    // Asking for a window is the caller choosing to read part of it; that must work, and
    // `truncated` still says what it got.
    const slice = await readKnowledgeFile(root, { path: 'huge.log', from: 1, lines: 1 });
    assert.equal(slice.to, 1);
    assert.equal(slice.truncated, true);
  });

  it('refuses to escape the project root', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'note.md'), 'note\n', 'utf8');
    await rejectsWith(() => readKnowledgeFile(root, { path: '../secret.md' }), 'INVALID_INPUT', /outside the project root/);
    await rejectsWith(() => readKnowledgeFile(root, { path: resolve(root, '..', 'x') }), 'INVALID_INPUT', /outside the project root/);
  });

  it('points a directory at tree and a missing path at nothing', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'kb'), { recursive: true });
    await rejectsWith(() => readKnowledgeFile(root, { path: 'kb' }), 'INVALID_INPUT', /use action "tree"/);
    await rejectsWith(() => readKnowledgeFile(root, { path: 'kb/none.md' }), 'INVALID_INPUT', /does not exist/);
  });
});

describe('knowledge stamp', () => {
  it('is stable across calls and independent of enumeration order', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'kb'), { recursive: true });
    await writeFile(join(root, 'kb', 'b.md'), 'bravo\n', 'utf8');
    await writeFile(join(root, 'kb', 'a.md'), 'alpha\n', 'utf8');

    const first = await knowledgeStamp(['kb'], root);
    const second = await knowledgeStamp(['kb'], root);
    assert.equal(first, second);
    assert.match(first, /roots:\["kb"\]/);
    assert.match(first, /kb\/a\.md/);
  });

  it('changes when a file is edited, added, or removed', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'kb'), { recursive: true });
    await writeFile(join(root, 'kb', 'a.md'), 'alpha\n', 'utf8');
    const initial = await knowledgeStamp(['kb'], root);

    // Same length, different bytes: a size-only fingerprint would miss this.
    await writeFile(join(root, 'kb', 'a.md'), 'alpha!\n', 'utf8');
    const edited = await knowledgeStamp(['kb'], root);
    assert.notEqual(edited, initial);

    await writeFile(join(root, 'kb', 'b.md'), 'bravo\n', 'utf8');
    const added = await knowledgeStamp(['kb'], root);
    assert.notEqual(added, edited);

    await rm(join(root, 'kb', 'b.md'));
    const removed = await knowledgeStamp(['kb'], root);
    assert.notEqual(removed, added);
  });

  it('changes when the bound set changes and records missing roots', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'kb'), { recursive: true });
    await writeFile(join(root, 'kb', 'a.md'), 'alpha\n', 'utf8');

    assert.notEqual(await knowledgeStamp(['kb'], root), await knowledgeStamp(['kb', 'docs'], root));
    assert.match(await knowledgeStamp(['docs'], root), /missing:docs/);
  });

  it('ignores the directories collection skips, so build output cannot fake a change', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'kb', 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(root, 'kb', 'note.md'), 'note\n', 'utf8');
    const before = await knowledgeStamp(['kb'], root);
    await writeFile(join(root, 'kb', 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n', 'utf8');
    assert.equal(await knowledgeStamp(['kb'], root), before);
  });
});
