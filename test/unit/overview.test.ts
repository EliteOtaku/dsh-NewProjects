/**
 * Tests for the overview projection.
 *
 * The bucket mapping is the contract the panel reads, so it is pinned here rather than
 * inferred from screenshots later: a status that lands in the wrong bucket looks like a
 * rendering bug months after the mapping drifted.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BUCKET_LABELS,
  BUCKET_ORDER,
  RESOLVE_AFTER_MS,
  bucketOf,
  buildOverview,
  dueForResolve,
  isActiveStatus,
  renderOverviewMarkdown,
} from '../../src/core/overview.js';
import type { ProjectThreadDescriptor, ThreadStatus } from '../../src/types.js';
import { makeManifest } from './manifestFixture.js';

const NOW = Date.parse('2026-01-02T12:00:00Z');

/** One thread descriptor. */
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

describe('bucketOf', () => {
  it('folds the working statuses into a single Working bucket', () => {
    // `queued`, `running`, and `ci_fixing` are all "not yet the user's turn", so the panel
    // shows one Working row instead of three near-empty ones.
    assert.equal(bucketOf('queued'), 'working');
    assert.equal(bucketOf('running'), 'working');
    assert.equal(bucketOf('ci_fixing'), 'working');
  });

  it('follows the official six names one-to-one', () => {
    assert.deepEqual([...BUCKET_ORDER], [
      'ready_for_review',
      'waiting_on_you',
      'working',
      'landing',
      'idle',
      'resolved',
    ]);
    assert.equal(bucketOf('awaiting_review'), 'ready_for_review');
    assert.equal(bucketOf('landing'), 'landing');
    assert.equal(bucketOf('needs_feedback'), 'waiting_on_you');
    assert.equal(bucketOf('completed'), 'idle');
    assert.equal(bucketOf('resolved'), 'resolved');
  });

  it('puts a failure in Waiting on you, because "or that failed" is the same group', () => {
    // Official: Waiting on you means threads that "need your reply or approval, or that
    // failed". A separate Failed bucket made the user look in two places for one question.
    assert.equal(bucketOf('failed'), 'waiting_on_you');
  });

  it('gives the human-blocking group priority over the PR lifecycle', () => {
    // A thread can have a PR open and still be stuck on an in-thread approval. The official
    // overview dot means "a thread is waiting on you"; filing that thread under Ready for
    // review would leave the dot dark and the thread unreachable, because in-thread
    // approvals cannot be answered from the project conversation.
    const stuck = thread('stuck', 'needs_feedback', { prOrDeliverableRef: 'https://x/pull/1' });
    assert.equal(bucketOf(stuck.status), 'waiting_on_you');
    const broken = thread('broken', 'failed', { prOrDeliverableRef: 'https://x/pull/2' });
    assert.equal(bucketOf(broken.status), 'waiting_on_you');
  });
});

describe('isActiveStatus', () => {
  it('is true only for statuses that are still burning compute', () => {
    for (const status of ['queued', 'running', 'ci_fixing'] as const) {
      assert.equal(isActiveStatus(status), true, `${status} should be active`);
    }
  });

  it('is false once the thread is waiting on a human, including a PR under review', () => {
    // `awaiting_review` is deliberately not active: the thread's turn has ended and the
    // next move belongs to a reviewer, so counting it as active would overstate how much
    // work is in flight. `landing` is the same argument one step later: the merge is the
    // host's job now, not ours.
    for (const status of ['awaiting_review', 'landing', 'needs_feedback', 'completed', 'failed', 'resolved'] as const) {
      assert.equal(isActiveStatus(status), false, `${status} should be inactive`);
    }
  });
});

describe('dueForResolve', () => {
  it('marks a thread after a week of silence, and not before', () => {
    const quiet = thread('quiet', 'completed', { updatedAt: NOW - RESOLVE_AFTER_MS });
    assert.equal(dueForResolve(quiet, NOW), true);
    const recent = thread('recent', 'completed', { updatedAt: NOW - RESOLVE_AFTER_MS + 1000 });
    assert.equal(dueForResolve(recent, NOW), false);
  });

  it('does not re-resolve an already resolved thread', () => {
    const done = thread('done', 'resolved', { updatedAt: NOW - RESOLVE_AFTER_MS * 2 });
    assert.equal(dueForResolve(done, NOW), false);
  });
});

describe('buildOverview', () => {
  it('puts every thread in exactly one bucket', () => {
    const manifest = makeManifest();
    const statuses = ['queued', 'running', 'awaiting_review', 'needs_feedback', 'landing', 'completed', 'failed'] as const;
    for (const [index, status] of statuses.entries()) {
      manifest.threads[`t${index}`] = thread(`t${index}`, status);
    }
    const overview = buildOverview(manifest, NOW);
    const seen = BUCKET_ORDER.flatMap((bucket) => overview.buckets[bucket].map((entry) => entry.threadId));
    assert.equal(seen.length, statuses.length);
    assert.equal(new Set(seen).size, statuses.length, 'a thread must not appear twice');
    assert.equal(overview.totals.threads, statuses.length);
  });

  it('counts failures as waiting on you in the totals', () => {
    const manifest = makeManifest();
    manifest.threads['a'] = thread('a', 'failed');
    manifest.threads['b'] = thread('b', 'needs_feedback');
    const overview = buildOverview(manifest, NOW);
    assert.equal(overview.totals.waitingOnYou, 2);
    assert.equal(overview.buckets.waiting_on_you.length, 2);
    assert.equal(overview.totals.needsAttention, true);
  });

  it('keeps the attention signal off when nothing needs a human', () => {
    const manifest = makeManifest();
    manifest.threads['a'] = thread('a', 'running');
    manifest.threads['b'] = thread('b', 'completed');
    assert.equal(buildOverview(manifest, NOW).totals.needsAttention, false);
  });

  it('hides resolved threads by default and shows them on request', () => {
    const manifest = makeManifest();
    manifest.threads['open'] = thread('open', 'running');
    manifest.threads['done'] = thread('done', 'resolved');
    const hidden = buildOverview(manifest, NOW);
    assert.equal(hidden.totals.threads, 1, 'the panel counts what it shows');
    assert.equal(hidden.totals.resolved, 1, 'but it still reports how many are hidden');
    assert.equal(hidden.buckets.resolved.length, 0);
    const shown = buildOverview(manifest, NOW, [], { includeResolved: true });
    assert.equal(shown.totals.threads, 2);
    assert.equal(shown.buckets.resolved.length, 1);
  });

  it('orders each bucket by most recently updated first', () => {
    const manifest = makeManifest();
    manifest.threads['old'] = thread('old', 'running', { updatedAt: NOW - 5000 });
    manifest.threads['new'] = thread('new', 'running', { updatedAt: NOW });
    const overview = buildOverview(manifest, NOW);
    assert.deepEqual(
      overview.buckets.working.map((entry) => entry.threadId),
      ['new', 'old'],
    );
  });

  it('reports the quota as used-today, not raw lifetime count', () => {
    const manifest = makeManifest({ quotaDay: '2026-01-01', dailyThreadsCreated: 199 });
    const overview = buildOverview(manifest, NOW);
    assert.equal(overview.quota.created, 0, 'yesterday usage must not show against today');
    assert.equal(overview.quota.max, 200);
  });

  it('surfaces the prefix fingerprint so the panel can prove the prefix is stable', () => {
    const first = buildOverview(makeManifest(), NOW);
    const second = buildOverview(makeManifest(), NOW);
    assert.equal(first.prefixFingerprint, second.prefixFingerprint);
    assert.ok(first.prefixFingerprint.length > 0);
  });

  it('carries caller warnings through without inventing any', () => {
    assert.deepEqual(buildOverview(makeManifest(), NOW).warnings, []);
    assert.deepEqual(buildOverview(makeManifest(), NOW, ['gh is not authenticated']).warnings, [
      'gh is not authenticated',
    ]);
  });

  it('does not include child session ids in the rendered markdown', () => {
    // The panel is for humans; an opaque session id in the table is noise that also
    // invites pasting an internal handle into a bug report.
    const manifest = makeManifest();
    manifest.threads['t1'] = thread('t1', 'running');
    const markdown = renderOverviewMarkdown(buildOverview(manifest, NOW));
    assert.equal(markdown.includes('child-t1'), false);
  });
});

describe('renderOverviewMarkdown', () => {
  it('reports the quota and thread totals even for a fresh project', () => {
    const markdown = renderOverviewMarkdown(buildOverview(makeManifest(), NOW));
    assert.match(markdown, /0\/200/);
    assert.match(markdown, /- threads: 0 shown/);
    assert.match(markdown, /No threads yet/);
  });

  it('omits empty buckets instead of printing empty tables', () => {
    const manifest = makeManifest();
    manifest.threads['t1'] = thread('t1', 'completed');
    const markdown = renderOverviewMarkdown(buildOverview(manifest, NOW));
    assert.match(markdown, /Idle/);
    assert.equal(markdown.includes('Ready for review'), false);
  });

  it('states the PR reference and the last error for a thread that has one', () => {
    const manifest = makeManifest();
    manifest.threads['t1'] = thread('t1', 'failed', {
      prOrDeliverableRef: 'https://github.com/o/r/pull/9',
      lastError: 'tests failed twice',
    });
    const markdown = renderOverviewMarkdown(buildOverview(manifest, NOW));
    assert.match(markdown, /pull\/9/);
    assert.match(markdown, /tests failed twice/);
  });

  it('labels every bucket it prints', () => {
    const manifest = makeManifest();
    manifest.threads['a'] = thread('a', 'awaiting_review');
    manifest.threads['b'] = thread('b', 'needs_feedback', { feedbackPrompt: 'which db?' });
    manifest.threads['c'] = thread('c', 'running');
    const overview = buildOverview(manifest, NOW);
    const markdown = renderOverviewMarkdown(overview);
    for (const bucket of BUCKET_ORDER) {
      if (overview.buckets[bucket].length === 0) continue;
      assert.ok(markdown.includes(BUCKET_LABELS[bucket]), `missing label for ${bucket}`);
    }
    assert.match(markdown, /which db\?/, 'a pending question must be visible in the panel');
  });

  it('says how many resolved threads it is hiding', () => {
    const manifest = makeManifest();
    manifest.threads['open'] = thread('open', 'running');
    manifest.threads['done'] = thread('done', 'resolved');
    const markdown = renderOverviewMarkdown(buildOverview(manifest, NOW));
    assert.match(markdown, /1 hidden/);
    assert.match(markdown, /threads --all/);
  });
});
