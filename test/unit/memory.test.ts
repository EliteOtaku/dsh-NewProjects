/**
 * Tests for the stable-prefix contract.
 *
 * The whole point of mounting shared memory in the system prompt is that a decision made
 * mid-session does not invalidate the provider's cached prefix. That only holds if the
 * rendered prefix is a pure function of the *decisions*, so these tests pin exactly that:
 * same decisions -> byte-identical text, and no incidental field (timestamp, revision,
 * author, insertion order) leaks into the output.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  markSeen,
  memoryPrefixFingerprint,
  normaliseMemoryKey,
  removeMemory,
  renderMemoryDelta,
  renderMemoryPrefix,
  sortedMemories,
  upsertMemory,
} from '../../src/core/memory.js';
import type { ProjectManifest } from '../../src/types.js';
import { fixedClock } from '../helpers.js';
import { makeManifest } from './manifestFixture.js';

describe('normaliseMemoryKey', () => {
  it('lowercases and collapses punctuation into single dashes', () => {
    assert.equal(normaliseMemoryKey('Use pnpm, not npm!'), 'use-pnpm-not-npm');
    assert.equal(normaliseMemoryKey('  AST   shape  '), 'ast-shape');
  });

  it('truncates to 64 characters without leaving a trailing dash', () => {
    const key = normaliseMemoryKey('a'.repeat(70));
    assert.equal(key.length, 64);
    assert.equal(normaliseMemoryKey(`${'b'.repeat(63)} tail`).endsWith('-'), false);
  });

  it('rejects a key that normalises to nothing', () => {
    // The normaliser is pure, so it reports "nothing usable" as the empty string and
    // leaves rejecting it to the caller that actually needs a key.
    assert.equal(normaliseMemoryKey('!!!'), '');
    assert.throws(() => upsertMemory(makeManifest(), { key: '!!!', decision: 'x' }, fixedClock()), /key/);
  });
});

describe('upsertMemory', () => {
  it('bumps the prefix version but leaves the store revision alone', () => {
    // Two different counters with two different jobs: `prefixVersion` tracks memory
    // content for cache reasoning, `manifest.revision` is the file CAS counter that only
    // the store may advance. Conflating them would make every memory write look like an
    // out-of-band file edit.
    const manifest = makeManifest();
    const clock = fixedClock();
    upsertMemory(manifest, { key: 'db', decision: 'sqlite only' }, clock);
    assert.equal(manifest.prefixVersion, 1);
    assert.equal(manifest.revision, 0);
    assert.equal(manifest.memories['db']?.decision, 'sqlite only');
    assert.equal(manifest.memories['db']?.revision, 1);
  });

  it('bumps the prefix version even when the decision text is unchanged', () => {
    // Rewriting the same decision must still count as a write: the delta channel keys
    // off entry revision, and silently swallowing a write would lose the author's intent.
    const manifest = makeManifest();
    const clock = fixedClock();
    upsertMemory(manifest, { key: 'db', decision: 'sqlite only' }, clock);
    const firstFingerprint = memoryPrefixFingerprint(manifest);
    upsertMemory(manifest, { key: 'db', decision: 'sqlite only' }, clock);
    assert.equal(manifest.prefixVersion, 2);
    assert.equal(manifest.memories['db']?.revision, 2);
    assert.equal(memoryPrefixFingerprint(manifest), firstFingerprint);
  });

  it('records the author and rejects an empty decision', () => {
    const manifest = makeManifest();
    const clock = fixedClock();
    upsertMemory(manifest, { key: 'db', decision: 'sqlite', author: 'thr-2' }, clock);
    assert.equal(manifest.memories['db']?.authorThreadId, 'thr-2');
    assert.throws(() => upsertMemory(manifest, { key: 'x', decision: '  ' }, clock), /decision/);
  });
});

describe('renderMemoryPrefix', () => {
  it('is empty for a project with no decisions', () => {
    assert.equal(renderMemoryPrefix(makeManifest()), '');
  });

  it('is byte-identical for the same decisions regardless of insertion order', () => {
    const clock = fixedClock();
    const first = makeManifest();
    upsertMemory(first, { key: 'zeta', decision: 'z' }, clock);
    upsertMemory(first, { key: 'alpha', decision: 'a' }, clock);

    const second = makeManifest();
    upsertMemory(second, { key: 'alpha', decision: 'a' }, clock);
    upsertMemory(second, { key: 'zeta', decision: 'z' }, clock);

    assert.equal(renderMemoryPrefix(first), renderMemoryPrefix(second));
  });

  it('does not leak timestamps, revisions, or author ids into the prefix', () => {
    const manifest = makeManifest();
    const clock = fixedClock();
    upsertMemory(manifest, { key: 'db', decision: 'sqlite found', author: 'thr-9' }, clock);
    const text = renderMemoryPrefix(manifest);
    assert.equal(text.includes('thr-9'), false);
    assert.equal(text.includes('20'), false, 'a year must not appear in the stable prefix');
    assert.equal(/\brev\b/i.test(text), false);
  });

  it('changes when a decision changes', () => {
    const manifest = makeManifest();
    const clock = fixedClock();
    upsertMemory(manifest, { key: 'db', decision: 'sqlite' }, clock);
    const before = renderMemoryPrefix(manifest);
    upsertMemory(manifest, { key: 'db', decision: 'postgres' }, clock);
    assert.notEqual(renderMemoryPrefix(manifest), before);
  });
});

describe('renderMemoryDelta', () => {
  it('is empty when nothing is newer than the watermark', () => {
    const manifest = makeManifest();
    const clock = fixedClock();
    upsertMemory(manifest, { key: 'db', decision: 'sqlite' }, clock);
    const seen = markSeen(manifest, {});
    assert.equal(renderMemoryDelta(manifest, seen), '');
  });

  it('reports only the entries beyond the watermark', () => {
    const manifest = makeManifest();
    const clock = fixedClock();
    upsertMemory(manifest, { key: 'db', decision: 'sqlite' }, clock);
    const seen = markSeen(manifest, {});
    upsertMemory(manifest, { key: 'cache', decision: 'redis' }, clock);
    const delta = renderMemoryDelta(manifest, seen);
    assert.match(delta, /redis/);
    assert.equal(delta.includes('sqlite'), false, 'already-delivered decisions must not repeat');
  });

  it('re-reports an entry that was revised after delivery', () => {
    const manifest = makeManifest();
    const clock = fixedClock();
    upsertMemory(manifest, { key: 'db', decision: 'sqlite' }, clock);
    const seen = markSeen(manifest, {});
    upsertMemory(manifest, { key: 'db', decision: 'postgres' }, clock);
    assert.match(renderMemoryDelta(manifest, seen), /postgres/);
  });
});

describe('removeMemory', () => {
  it('deletes the entry and reports whether it existed', () => {
    const manifest = makeManifest();
    const clock = fixedClock();
    upsertMemory(manifest, { key: 'db', decision: 'sqlite' }, clock);
    assert.equal(removeMemory(manifest, 'db'), true);
    assert.equal(removeMemory(manifest, 'db'), false);
    assert.deepEqual(sortedMemories(manifest), []);
  });
});

describe('ProjectManifest fixtures', () => {
  it('keeps memories sorted by key so the prefix order is structural', () => {
    const manifest: ProjectManifest = makeManifest();
    const clock = fixedClock();
    upsertMemory(manifest, { key: 'z', decision: 'z' }, clock);
    upsertMemory(manifest, { key: 'a', decision: 'a' }, clock);
    assert.deepEqual(
      sortedMemories(manifest).map((entry) => entry.key),
      ['a', 'z'],
    );
  });
});
