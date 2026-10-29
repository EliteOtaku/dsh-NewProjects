import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  collectConventions,
  conventionsStamp,
  MAX_CONVENTIONS_CHARS,
  renderConventions,
} from '../../src/core/conventions.js';
import { makeTempRoot } from '../helpers.js';

const cleanups: Array<() => Promise<void>> = [];

after(async () => {
  for (const cleanup of cleanups) await cleanup();
});

async function freshRoot(): Promise<string> {
  const made = await makeTempRoot();
  cleanups.push(made.cleanup);
  return made.root;
}

async function write(root: string, path: string, text: string): Promise<void> {
  const absolute = join(root, path);
  await mkdir(join(absolute, '..'), { recursive: true });
  await writeFile(absolute, text, 'utf8');
}

describe('collectConventions', () => {
  it('returns nothing for a repository without conventions', async () => {
    const root = await freshRoot();
    const collected = await collectConventions(root);
    assert.deepEqual(collected.documents, []);
    assert.deepEqual(collected.warnings, []);
    assert.equal(collected.truncated, false);
  });

  it('reads the two root files in their documented order', async () => {
    const root = await freshRoot();
    await write(root, '.claude/CLAUDE.md', 'claude dir wins second');
    await write(root, 'CLAUDE.md', 'root file first');
    const collected = await collectConventions(root);
    assert.deepEqual(
      collected.documents.map((document) => document.path),
      ['CLAUDE.md', '.claude/CLAUDE.md'],
    );
    assert.equal(collected.documents[0]?.text, 'root file first');
  });

  it('reads rules after the fixed files and sorts them by name', async () => {
    const root = await freshRoot();
    await write(root, 'CLAUDE.md', 'root');
    await write(root, '.claude/rules/zeta.md', 'zeta');
    await write(root, '.claude/rules/alpha.md', 'alpha');
    await write(root, '.claude/rules/notes.txt', 'not markdown');
    const collected = await collectConventions(root);
    assert.deepEqual(
      collected.documents.map((document) => document.path),
      ['CLAUDE.md', '.claude/rules/alpha.md', '.claude/rules/zeta.md'],
    );
  });

  it('ignores a CLAUDE.md in a subdirectory', async () => {
    // Official: the three locations are "at the repository root". Reading nested files would
    // make the shared prefix grow with the size of the checkout, which is the one thing the
    // charter cannot afford.
    const root = await freshRoot();
    await write(root, 'packages/api/CLAUDE.md', 'nested rules');
    const collected = await collectConventions(root);
    assert.deepEqual(collected.documents, []);
  });

  it('strips a byte-order mark so the prefix does not start with an invisible character', async () => {
    const root = await freshRoot();
    await write(root, 'CLAUDE.md', '\uFEFFrun the linter');
    const collected = await collectConventions(root);
    assert.equal(collected.documents[0]?.text, 'run the linter');
  });

  it('truncates at the budget and says so', async () => {
    const root = await freshRoot();
    await write(root, 'CLAUDE.md', 'a'.repeat(50));
    const collected = await collectConventions(root, { maxChars: 10 });
    assert.equal(collected.truncated, true);
    assert.equal(collected.documents[0]?.text.length, 10);
    assert.ok(collected.warnings.some((warning) => warning.includes('exceeded 10 characters')));
  });

  it('stops reading further files once the budget is spent', async () => {
    const root = await freshRoot();
    await write(root, 'CLAUDE.md', 'b'.repeat(10));
    await write(root, '.claude/CLAUDE.md', 'should not be read');
    const collected = await collectConventions(root, { maxChars: 10 });
    assert.deepEqual(collected.documents.map((document) => document.path), ['CLAUDE.md']);
  });

  it('defaults the budget to the documented instruction figure', () => {
    assert.equal(MAX_CONVENTIONS_CHARS, 16_000);
  });
});

describe('conventionsStamp', () => {
  it('changes when a convention file changes', async () => {
    const root = await freshRoot();
    await write(root, 'CLAUDE.md', 'one');
    const before = await conventionsStamp(root);
    await write(root, 'CLAUDE.md', 'two');
    const after = await conventionsStamp(root);
    assert.notEqual(before, after);
  });

  it('is stable while nothing changes', async () => {
    const root = await freshRoot();
    await write(root, 'CLAUDE.md', 'same');
    assert.equal(await conventionsStamp(root), await conventionsStamp(root));
  });

  it('notices an added rule file', async () => {
    const root = await freshRoot();
    const before = await conventionsStamp(root);
    await write(root, '.claude/rules/new.md', 'added');
    assert.notEqual(before, await conventionsStamp(root));
  });
});

describe('renderConventions', () => {
  it('renders nothing when there is nothing to say', () => {
    assert.equal(renderConventions([]), '');
  });

  it('names each file so a thread can cite it', () => {
    const text = renderConventions([
      { path: 'CLAUDE.md', text: 'use tabs' },
      { path: '.claude/rules/tests.md', text: 'test first' },
    ]);
    assert.match(text, /^## Repository conventions/);
    assert.match(text, /### CLAUDE\.md\n\nuse tabs/);
    assert.match(text, /### \.claude\/rules\/tests\.md\n\ntest first/);
  });

  it('is deterministic for the same input', () => {
    const documents = [{ path: 'CLAUDE.md', text: 'same' }];
    assert.equal(renderConventions(documents), renderConventions(documents));
  });
});
