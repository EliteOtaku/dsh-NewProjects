/**
 * Tests for the project-state projection fold.
 *
 * The panel reads this fold, and the Host caches its output, so two properties matter more
 * than the payload shape: the fold must be pure (same events in, same state out) and it must
 * return the identical object for events that are not ours, so unrelated events do not
 * invalidate the panel's cache on every turn.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_THREADS_PER_BUCKET,
  PROJECT_STATE_EVENT,
  PROJECT_STATE_KEY,
  applyProjectState,
  buildProjectState,
  emptyProjectState,
} from '../../src/core/projectState.js';
import { buildOverview } from '../../src/core/overview.js';
import type { ProjectThreadDescriptor, ThreadStatus } from '../../src/types.js';
import { makeManifest } from './manifestFixture.js';

const NOW = Date.parse('2026-01-02T12:00:00Z');

function thread(id: string, status: ThreadStatus, overrides: Partial<ProjectThreadDescriptor> = {}): ProjectThreadDescriptor {
  return {
    threadId: id,
    childSessionId: `child-${id}`,
    title: `task ${id}`,
    objective: `do ${id}`,
    branchOrScope: `project/demo/${id}`,
    status,
    startedAt: NOW - 1000,
    updatedAt: NOW,
    healAttempts: 0,
    ...overrides,
  };
}

function snapshotFor(manifest = makeManifest()) {
  return buildProjectState(buildOverview(manifest, NOW), NOW);
}

describe('buildProjectState', () => {
  it('starts empty, because a session that never drove a project has no snapshot', () => {
    const state = emptyProjectState();
    assert.equal(state.snapshot, null);
  });

  it('carries the six buckets and the totals the panel renders', () => {
    const manifest = makeManifest();
    manifest.threads['a'] = thread('a', 'running');
    manifest.threads['b'] = thread('b', 'needs_feedback', { feedbackPrompt: 'which database?' });
    const snapshot = snapshotFor(manifest);
    assert.deepEqual(Object.keys(snapshot.buckets).sort(), [
      'idle',
      'landing',
      'ready_for_review',
      'resolved',
      'waiting_on_you',
      'working',
    ]);
    assert.equal(snapshot.totals.threads, 2);
    assert.equal(snapshot.totals.needsAttention, true);
  });

  it('keeps only what a panel row shows, not the whole descriptor', () => {
    const manifest = makeManifest();
    manifest.threads['a'] = thread('a', 'awaiting_review', {
      prOrDeliverableRef: 'https://github.com/o/r/pull/7',
      objective: 'a long objective nobody reads in a table row',
    });
    const row = snapshotFor(manifest).buckets.ready_for_review[0];
    assert.ok(row !== undefined);
    assert.equal(row.pr, 'https://github.com/o/r/pull/7');
    assert.deepEqual(Object.keys(row).sort(), ['pr', 'status', 'threadId', 'title']);
  });

  it('reports truncation instead of silently dropping rows', () => {
    // A panel that says "19 threads" when there are 40 is worse than one that says 20 of 40.
    const manifest = makeManifest();
    for (let index = 0; index < MAX_THREADS_PER_BUCKET + 5; index += 1) {
      manifest.threads[`t${index}`] = thread(`t${index}`, 'running', { updatedAt: NOW - index });
    }
    const snapshot = snapshotFor(manifest);
    assert.equal(snapshot.buckets.working.length, MAX_THREADS_PER_BUCKET);
    assert.equal(snapshot.truncated, 5);
  });

  it('carries the pending plan and the quota, because the panel header shows both', () => {
    const snapshot = snapshotFor();
    assert.equal(snapshot.quota.max, 200);
    assert.equal(snapshot.quota.used, 0);
    assert.equal(snapshot.suggested, undefined);
  });

  it('carries knowledge numbers when the caller supplies them', () => {
    const snapshot = buildProjectState(buildOverview(makeManifest(), NOW), NOW, {
      knowledge: { docs: 3, summary: '3 documents loaded in full' },
    });
    assert.deepEqual(snapshot.knowledge, { docs: 3, summary: '3 documents loaded in full' });
  });
});

describe('applyProjectState', () => {
  it('returns the identical object for events it does not own', () => {
    // The Host caches reducer output per event; allocating on every turn event would
    // invalidate the panel continuously for nothing.
    const state = emptyProjectState();
    const afterUserMessage = applyProjectState(state, { type: 'user/message', data: {} });
    assert.equal(afterUserMessage, state, 'must be referentially identical');
    const afterToolCall = applyProjectState(state, { type: 'tool/call', data: { name: 'read' } });
    assert.equal(afterToolCall, state);
  });

  it('ignores its own event type when the payload is malformed', () => {
    const state = emptyProjectState();
    assert.equal(applyProjectState(state, { type: PROJECT_STATE_EVENT }), state);
    assert.equal(applyProjectState(state, { type: PROJECT_STATE_EVENT, data: {} }), state);
    assert.equal(applyProjectState(state, { type: PROJECT_STATE_EVENT, data: { snapshot: 'nope' } }), state);
  });

  it('folds a snapshot in and is deterministic', () => {
    const snapshot = snapshotFor();
    const event = { type: PROJECT_STATE_EVENT, data: { snapshot } };
    const first = applyProjectState(emptyProjectState(), event);
    const second = applyProjectState(emptyProjectState(), event);
    assert.deepEqual(first, second);
    assert.equal(first.snapshot, snapshot);
  });

  it('keeps the latest snapshot when several arrive', () => {
    const older = snapshotFor();
    const newer = { ...snapshotFor(), revision: older.revision + 1 };
    const afterOlder = applyProjectState(emptyProjectState(), { type: PROJECT_STATE_EVENT, data: { snapshot: older } });
    const afterNewer = applyProjectState(afterOlder, { type: PROJECT_STATE_EVENT, data: { snapshot: newer } });
    assert.equal(afterNewer.snapshot?.revision, older.revision + 1);
  });

  it('uses a stable projection key', () => {
    // The key is part of the persisted snapshot; renaming it orphans every stored view.
    assert.equal(PROJECT_STATE_KEY, 'projectBeta');
  });
});
