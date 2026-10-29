/**
 * Unit tests for the Library: turning `git diff --name-status` into the file list a
 * project keeps after its threads are gone.
 *
 * The two decisions worth pinning down here are that a rename becomes a deletion plus an
 * addition (there is no `renamed` row a panel could render) and that a missing file reads
 * as missing rather than as an empty document.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { aggregateLibrary, parseNameStatus, readOutput } from '../../src/core/library.js';
import type { ProjectThreadDescriptor } from '../../src/types.js';

const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const cleanup of cleanups) await cleanup();
});

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-project-library-'));
  cleanups.push(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

/** A descriptor with just enough set for the library helpers. */
function thread(overrides: Partial<ProjectThreadDescriptor> & { threadId: string }): ProjectThreadDescriptor {
  return {
    childSessionId: `child-${overrides.threadId}`,
    title: overrides.threadId,
    objective: 'do the work',
    branchOrScope: 'scope',
    status: 'awaiting_review',
    startedAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('parseNameStatus', () => {
  it('maps the status letters onto the three changes a panel shows', () => {
    const files = parseNameStatus(['A\tsrc/new.ts', 'M\tsrc/old.ts', 'D\tsrc/gone.ts'].join('\n'));
    assert.deepEqual(files, [
      { path: 'src/new.ts', change: 'added' },
      { path: 'src/old.ts', change: 'modified' },
      { path: 'src/gone.ts', change: 'deleted' },
    ]);
  });

  it('treats a copy as an addition and a type change as a modification', () => {
    const files = parseNameStatus(['C100\ta.ts\tb.ts', 'T\tlink.ts'].join('\n'));
    assert.deepEqual(files, [
      { path: 'b.ts', change: 'added' },
      { path: 'link.ts', change: 'modified' },
    ]);
  });

  it('keeps a path that contains tabs, because only the last column is the path', () => {
    // A rename row with `--no-renames` never happens, but a `-z`-less path with a tab can.
    const files = parseNameStatus('A\ta\tb.ts');
    assert.deepEqual(files, [{ path: 'b.ts', change: 'added' }]);
  });

  it('ignores blank lines and trailing whitespace', () => {
    assert.deepEqual(parseNameStatus('\n  \n'), []);
    assert.deepEqual(parseNameStatus(''), []);
  });
});

describe('aggregateLibrary', () => {
  it('deduplicates a path produced by two threads and names both', () => {
    const rows = aggregateLibrary([
      thread({ threadId: 'thr-1', outputs: [{ path: 'src/a.ts', change: 'modified' }] }),
      thread({ threadId: 'thr-2', outputs: [{ path: 'src/a.ts', change: 'modified' }] }),
    ]);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]?.threads, ['thr-1', 'thr-2']);
  });

  it('prefers added over modified over deleted for the same path', () => {
    // A file one branch added and another deleted still exists somewhere, so the row must
    // not claim it is gone.
    const rows = aggregateLibrary([
      thread({ threadId: 'thr-1', outputs: [{ path: 'a.ts', change: 'deleted' }] }),
      thread({ threadId: 'thr-2', outputs: [{ path: 'a.ts', change: 'added' }] }),
    ]);
    assert.equal(rows[0]?.change, 'added');
  });

  it('sorts by path so the list is stable across renders', () => {
    const rows = aggregateLibrary([
      thread({ threadId: 'thr-1', outputs: [{ path: 'z.ts', change: 'added' }] }),
      thread({ threadId: 'thr-2', outputs: [{ path: 'a.ts', change: 'added' }] }),
    ]);
    assert.deepEqual(rows.map((row) => row.path), ['a.ts', 'z.ts']);
  });

  it('returns nothing when no thread recorded any output', () => {
    assert.deepEqual(aggregateLibrary([thread({ threadId: 'thr-1' })]), []);
  });
});

describe('readOutput', () => {
  it('reads a file out of the worktree and reports its size', async () => {
    const dir = await freshDir();
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
    const result = await readOutput(dir, 'src/a.ts');
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.text, 'export const a = 1;\n');
      assert.equal(result.truncated, false);
      assert.equal(result.bytes, 20);
      assert.equal(result.source, join(dir, 'src', 'a.ts'));
    }
  });

  it('says the file is unreadable instead of returning an empty string', async () => {
    // An empty body would be indistinguishable from a genuinely empty file, so the caller
    // would show a blank panel where the truth is "the worktree was reclaimed".
    const dir = await freshDir();
    const result = await readOutput(dir, 'src/missing.ts');
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /not on disk/);
  });

  it('refuses a directory rather than pretending it is a file', async () => {
    const dir = await freshDir();
    await mkdir(join(dir, 'src'), { recursive: true });
    const result = await readOutput(dir, 'src');
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /not a regular file/);
  });

  it('refuses binary content and says why', async () => {
    const dir = await freshDir();
    await writeFile(join(dir, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00]));
    const result = await readOutput(dir, 'blob.bin');
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /binary/);
  });

  it('refuses a path that climbs out of the worktree', async () => {
    // The path can arrive from a model or a command line; `..` must not reach the project
    // root, let alone the rest of the disk.
    const dir = await freshDir();
    const result = await readOutput(join(dir, 'wt'), '../../etc/passwd');
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /escapes the worktree/);
  });

  it('truncates a large text file instead of loading it whole', async () => {
    const dir = await freshDir();
    await writeFile(join(dir, 'big.txt'), 'x'.repeat(250_000));
    const result = await readOutput(dir, 'big.txt');
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.truncated, true);
      assert.ok(result.text.length <= 200_000);
    }
  });
});
