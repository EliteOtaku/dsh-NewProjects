/**
 * Tests for the daily quota guard.
 *
 * The guard's job is to prevent `coordinate` from starting more threads than the cap
 * allows. The invariant that matters is **all-or-nothing**: a batch whose size exceeds the
 * remaining budget must fail without partially spending it, because a half-reserved batch
 * would leave the counter above the truth and quietly shrink today's real capacity.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  QUOTA_MAX_CEILING,
  normaliseQuotaMax,
  quotaRemaining,
  quotaState,
  quotaWarning,
  releaseQuota,
  reserveQuota,
  rolloverQuota,
} from '../../src/core/quota.js';
import { isProjectError } from '../../src/core/errors.js';
import { makeManifest } from './manifestFixture.js';

const NOON = Date.parse('2026-01-02T12:00:00Z');

describe('normaliseQuotaMax', () => {
  it('clamps into the accepted range', () => {
    assert.equal(normaliseQuotaMax(undefined), 200);
    assert.equal(normaliseQuotaMax(0), 1);
    assert.equal(normaliseQuotaMax(-5), 1);
    assert.equal(normaliseQuotaMax(50), 50);
    assert.equal(normaliseQuotaMax(10_000), QUOTA_MAX_CEILING);
  });

  it('truncates fractions rather than rounding up the budget', () => {
    assert.equal(normaliseQuotaMax(7.9), 7);
  });
});

describe('rolloverQuota', () => {
  it('resets the counter when the day changes', () => {
    const manifest = makeManifest({ quotaDay: '2026-01-01', dailyThreadsCreated: 42 });
    rolloverQuota(manifest, '2026-01-02');
    assert.equal(manifest.quotaDay, '2026-01-02');
    assert.equal(manifest.dailyThreadsCreated, 0);
  });

  it('leaves the counter alone within the same day', () => {
    const manifest = makeManifest({ quotaDay: '2026-01-02', dailyThreadsCreated: 7 });
    rolloverQuota(manifest, '2026-01-02');
    assert.equal(manifest.dailyThreadsCreated, 7);
  });
});

describe('reserveQuota', () => {
  it('spends exactly the reserved amount', () => {
    const manifest = makeManifest();
    reserveQuota(manifest, 3, NOON);
    assert.equal(manifest.dailyThreadsCreated, 3);
    assert.equal(quotaRemaining(quotaState(manifest, NOON)), 197);
  });

  it('is all-or-nothing: an over-budget batch spends nothing', () => {
    const manifest = makeManifest({ dailyThreadsCreated: 198 });
    assert.throws(
      () => reserveQuota(manifest, 5, NOON),
      (error: unknown) => isProjectError(error) && error.code === 'QUOTA_EXCEEDED',
    );
    assert.equal(manifest.dailyThreadsCreated, 198, 'a rejected batch must not partially spend');
  });

  it('accepts a batch that exactly fills the budget', () => {
    const manifest = makeManifest({ dailyThreadsCreated: 198 });
    reserveQuota(manifest, 2, NOON);
    assert.equal(manifest.dailyThreadsCreated, 200);
    assert.equal(quotaRemaining(quotaState(manifest, NOON)), 0);
  });

  it('rolls the day over before spending', () => {
    const manifest = makeManifest({ quotaDay: '2026-01-01', dailyThreadsCreated: 200 });
    reserveQuota(manifest, 1, NOON);
    assert.equal(manifest.dailyThreadsCreated, 1);
  });

  it('rejects a non-positive count instead of walking the ledger backwards', () => {
    const manifest = makeManifest({ dailyThreadsCreated: 10 });
    for (const bad of [0, -3, Number.NaN]) {
      assert.throws(
        () => reserveQuota(manifest, bad, NOON),
        (error: unknown) => isProjectError(error) && error.code === 'INVALID_INPUT',
      );
    }
    assert.equal(manifest.dailyThreadsCreated, 10, 'a rejected count must not move the ledger');
  });

  it('carries the quota details on the error so a caller can report them', () => {
    const manifest = makeManifest({ dailyThreadsCreated: 199 });
    try {
      reserveQuota(manifest, 2, NOON);
      assert.fail('expected a quota error');
    } catch (error) {
      assert.ok(isProjectError(error));
      assert.deepEqual(error.details, { day: '2026-01-02', used: 199, requested: 2, max: 200 });
    }
  });
});

describe('releaseQuota', () => {
  it('gives back unused reservations but never goes negative', () => {
    const manifest = makeManifest();
    reserveQuota(manifest, 4, NOON);
    releaseQuota(manifest, 3, NOON);
    assert.equal(manifest.dailyThreadsCreated, 1);
    releaseQuota(manifest, 10, NOON);
    assert.equal(manifest.dailyThreadsCreated, 0);
  });

  it('ignores a release once the ledger belongs to another day', () => {
    // Otherwise yesterday's batch failure would hand today a windfall.
    const manifest = makeManifest({ quotaDay: '2026-01-01', dailyThreadsCreated: 50 });
    releaseQuota(manifest, 10, NOON);
    assert.equal(manifest.dailyThreadsCreated, 50);
  });
});

describe('quotaState / quotaWarning', () => {
  it('reports the day it rolled to', () => {
    const manifest = makeManifest({ quotaDay: '2026-01-01', dailyThreadsCreated: 5 });
    const state = quotaState(manifest, NOON);
    assert.equal(state.created, 0);
    assert.equal(state.max, 200);
    assert.equal(state.day, '2026-01-02');
  });

  it('warns only from 80% of the cap onward', () => {
    assert.equal(quotaWarning(quotaState(makeManifest({ dailyThreadsCreated: 159 }), NOON)), undefined);
    const warning = quotaWarning(quotaState(makeManifest({ dailyThreadsCreated: 160 }), NOON));
    assert.match(warning ?? '', /160\/200/);
  });

  it('says nothing once the day has rolled over', () => {
    const manifest = makeManifest({ quotaDay: '2026-01-01', dailyThreadsCreated: 200 });
    assert.equal(quotaWarning(quotaState(manifest, NOON)), undefined);
  });
});
