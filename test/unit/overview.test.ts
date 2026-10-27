/**
 * Tests for the overview projection.
 *
 * The bucket mapping is the contract the panel reads, so it is pinned here rather than
 * inferred from screenshots later: a status that lands in the wrong bucket looks like a
 * rendering bug months after the mapping drifted.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BUCKET_LABELS, BUCKET_ORDER, bucketOf, buildOverview, isActiveStatus, renderOverviewMarkdown } from '../../src/core/overview.js';
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
  it('folds the working statuses into a single running bucket', () => {
    // `queued`, `running`, and `ci_fixing` are all "not yet the user's turn", so the panel
    // shows one running row instead of three near-empty ones.
    assert.equal(bucketOf('queued'), 'running');
    assert.equal(bucketOf('running'), 'running');
    assert.equal(bucketOf('ci_fixing'), 'running');
  });

  it('separates review from feedback, because the human action differs', () => {
    assert.equal(bucketOf('awaiting_review'), 'awaiting_review');
    assert.equal(bucketOf('needs_feedback'), 'waiting_for_feedback');
  });

  it('maps terminal states directly', () => {
    assert.equal(bucketOf('completed'), 'completed');
    assert.equal(bucketOf('failed'), 'failed');
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
    // work is in flight. It still lives in its own bucket, and CI healing can still wake it.
    for (const status of ['awaiting_review', 'needs_feedback', 'completed', 'failed'] as const) {
      assert.equal(isActiveStatus(status), false, `${status} should be inactive`);
    }
  });
});

describe('buildOverview', () => {
  it('puts every thread in exactly one bucket', () => {
    const manifest = makeManifest();
    for (const [index, status] of (['queued', 'running', 'awaiting_review', 'needs_feedback', 'completed', 'failed'] as const).entries()) {
      manifest.threads[`t${index}`] = thread(`t${index}`, status);
    }
    const overview = buildOverview(manifest, NOW);
    const seen = BUCKET_ORDER.flatMap((bucket) => overview.buckets[bucket].map((entry) => entry.threadId));
    assert.equal(seen.length, 6);
    assert.equal(new Set(seen).size, 6, 'a thread must not appear twice');
    assert.equal(overview.totals.threads, 6);
  });

  it('orders each bucket by most recently updated first', () => {
    const manifest = makeManifest();
    manifest.threads['old'] = thread('old', 'running', { updatedAt: NOW - 5000 });
    manifest.threads['new'] = thread('new', 'running', { updatedAt: NOW });
    const overview = buildOverview(manifest, NOW);
    assert.deepEqual(
      overview.buckets.running.map((entry) => entry.threadId),
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
    assert.match(markdown, /- threads: 0 total/);
    assert.match(markdown, /No threads yet/);
  });

  it('omits empty buckets instead of printing empty tables', () => {
    const manifest = makeManifest();
    manifest.threads['t1'] = thread('t1', 'completed');
    const markdown = renderOverviewMarkdown(buildOverview(manifest, NOW));
    assert.match(markdown, /Completed/);
    assert.equal(markdown.includes('Awaiting Review'), false);
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
});
