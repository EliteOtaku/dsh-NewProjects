/**
 * Tests for the concurrency preference.
 *
 * Two things are pinned here because both are easy to break later and hard to notice:
 * the preference only ever narrows a round (a per-call `limit` cannot widen it), and a round
 * never comes out empty — a "preference" that refuses all work is the cap the spec says this
 * is not.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  activeThreadCount,
  concurrencyPreference,
  CONCURRENCY_CEILING,
  CONCURRENCY_MIN,
  normaliseConcurrencyPreference,
  roundBudget,
} from '../../src/core/concurrency.js';
import { isProjectError } from '../../src/core/errors.js';
import type { ProjectThreadDescriptor, ThreadStatus } from '../../src/types.js';
import { makeManifest } from './manifestFixture.js';

/** One thread descriptor at a given status. */
function thread(id: string, status: ThreadStatus): ProjectThreadDescriptor {
  return {
    threadId: id,
    childSessionId: `child-${id}`,
    title: `task ${id}`,
    objective: `do ${id}`,
    branchOrScope: `project/demo/${id}`,
    status,
    startedAt: 1_000,
    updatedAt: 2_000,
    healAttempts: 0,
  };
}

describe('normaliseConcurrencyPreference', () => {
  it('accepts whole numbers inside the usable range', () => {
    assert.equal(normaliseConcurrencyPreference(1), CONCURRENCY_MIN);
    assert.equal(normaliseConcurrencyPreference(3), 3);
    assert.equal(normaliseConcurrencyPreference(CONCURRENCY_CEILING), CONCURRENCY_CEILING);
  });

  it('rejects zero and negatives, and points at the way to clear it', () => {
    for (const value of [0, -1, -40]) {
      assert.throws(
        () => normaliseConcurrencyPreference(value),
        (error: unknown) => isProjectError(error) && error.code === 'INVALID_INPUT' && /concurrent off/.test(error.message),
        `expected ${value} to be rejected`,
      );
    }
  });

  it('rejects fractions and non-numbers', () => {
    for (const value of [1.5, Number.NaN, '3', null, undefined]) {
      assert.throws(
        () => normaliseConcurrencyPreference(value),
        (error: unknown) => isProjectError(error) && error.code === 'INVALID_INPUT',
        `expected ${String(value)} to be rejected`,
      );
    }
  });

  it('rejects a preference above a day of quota, because it can never be reached', () => {
    assert.throws(
      () => normaliseConcurrencyPreference(CONCURRENCY_CEILING + 1),
      (error: unknown) => isProjectError(error) && /daily thread quota/.test(error.message),
    );
  });
});

describe('activeThreadCount', () => {
  it('counts only threads we still own', () => {
    const manifest = makeManifest({
      threads: {
        a: thread('a', 'queued'),
        b: thread('b', 'running'),
        c: thread('c', 'ci_fixing'),
        d: thread('d', 'awaiting_review'),
        e: thread('e', 'needs_feedback'),
        f: thread('f', 'resolved'),
      },
    });
    assert.equal(activeThreadCount(Object.values(manifest.threads)), 3);
  });

  it('is zero for an empty project', () => {
    assert.equal(activeThreadCount([]), 0);
  });
});

describe('concurrencyPreference', () => {
  it('reports what the manifest stores, and nothing when unset', () => {
    assert.equal(concurrencyPreference(makeManifest()), undefined);
    assert.equal(concurrencyPreference(makeManifest({ maxConcurrentThreads: 4 })), 4);
  });
});

describe('roundBudget', () => {
  it('starts everything when no preference is set', () => {
    const budget = roundBudget({ preference: undefined, active: 0, planned: 5 });
    assert.equal(budget.allowed, 5);
    assert.equal(budget.deferred, 0);
    assert.equal(budget.decision, undefined);
  });

  it('honours a per-call limit when no preference is set', () => {
    const budget = roundBudget({ preference: undefined, active: 0, planned: 5, requested: 2 });
    assert.equal(budget.allowed, 2);
    assert.equal(budget.deferred, 3);
  });

  it('leaves room for the preference after the threads already running', () => {
    const budget = roundBudget({ preference: 3, active: 1, planned: 5 });
    assert.equal(budget.allowed, 2);
    assert.equal(budget.deferred, 3);
    assert.equal(budget.decision?.preference, 3);
    assert.equal(budget.decision?.active, 1);
    assert.equal(budget.decision?.allowed, 2);
    assert.match(budget.decision?.note ?? '', /preference is 3/);
    assert.match(budget.decision?.note ?? '', /2 of 5/);
  });

  it('starts one thread even when the preference is already reached', () => {
    // The spec says a limit the user asks for is "a preference rather than a cap". A round that
    // starts nothing turns it into a cap, so the floor is one and the note says why.
    const budget = roundBudget({ preference: 2, active: 2, planned: 4 });
    assert.equal(budget.allowed, 1);
    assert.equal(budget.deferred, 3);
    assert.match(budget.decision?.note ?? '', /started one anyway/);
    assert.match(budget.decision?.note ?? '', /not a cap/);
  });

  it('still allows one when the project is over its preference', () => {
    const budget = roundBudget({ preference: 1, active: 5, planned: 3 });
    assert.equal(budget.allowed, 1);
  });

  it('lets a per-call limit narrow the round but never widen it past the preference', () => {
    const narrow = roundBudget({ preference: 3, active: 0, planned: 5, requested: 1 });
    assert.equal(narrow.allowed, 1);
    assert.equal(narrow.deferred, 4);
    // Same note: the round was cut, and the reader needs to know by what.
    assert.match(narrow.decision?.note ?? '', /1 of 5/);

    const widen = roundBudget({ preference: 2, active: 0, planned: 5, requested: 9 });
    assert.equal(widen.allowed, 2, 'an explicit limit must not override a standing preference');
  });

  it('adds no note when the preference did not cut anything', () => {
    const budget = roundBudget({ preference: 8, active: 0, planned: 3 });
    assert.equal(budget.allowed, 3);
    assert.equal(budget.deferred, 0);
    assert.equal(budget.decision?.note, undefined);
  });

  it('treats a nonsense limit as one rather than starting nothing', () => {
    const budget = roundBudget({ preference: undefined, active: 0, planned: 3, requested: 0 });
    assert.equal(budget.allowed, 1);
  });

  it('is a no-op for an empty round', () => {
    const budget = roundBudget({ preference: 2, active: 9, planned: 0 });
    assert.equal(budget.allowed, 0);
    assert.equal(budget.deferred, 0);
  });
});
