/**
 * Tests for the self-healing decision function.
 *
 * `decideHealAction` is pure, so it is the right place to pin the escalation ladder:
 * what counts as a failure, when a wake is warranted, and when the attempt budget is
 * spent. The ordering tests matter most — a merged PR must settle even while a stale red
 * check is still visible, and a pending check must never trigger a "fix".
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_HEAL_ATTEMPTS,
  buildHealPrompt,
  consumeComments,
  decideHealAction,
  failureSignature,
  hasActionableSignal,
  mergeSnapshot,
  normaliseConclusion,
  toCheckStates,
  toReviewComments,
} from '../../src/core/healing.js';
import type { ProjectCheckState, ProjectReviewComment, ProjectReviewSnapshot } from '../../src/types.js';

/** One check state. */
function check(name: string, conclusion: ProjectCheckState['conclusion']): ProjectCheckState {
  return { name, conclusion };
}

/** One review comment. */
function comment(id: string, body = 'please rename this'): ProjectReviewComment {
  return { id, author: 'reviewer', body, createdAt: 1 };
}

/** A snapshot with everything passed. */
function green(overrides: Partial<ProjectReviewSnapshot> = {}): ProjectReviewSnapshot {
  return {
    prRef: '7',
    state: 'open',
    checks: [check('build', 'pass')],
    comments: [],
    consumedCommentIds: [],
    observedAt: 1,
    ...overrides,
  };
}

describe('normaliseConclusion', () => {
  it('maps GitHub conclusion spellings onto three states', () => {
    for (const raw of ['failure', 'failed', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'ERROR']) {
      assert.equal(normaliseConclusion(raw), 'fail', `expected ${raw} to be a failure`);
    }
    for (const raw of ['pending', 'queued', 'in_progress', 'waiting', 'requested', 'expected']) {
      assert.equal(normaliseConclusion(raw), 'pending', `expected ${raw} to be pending`);
    }
    for (const raw of ['success', 'passed', 'PASS']) {
      assert.equal(normaliseConclusion(raw), 'pass', `expected ${raw} to pass`);
    }
    for (const raw of ['neutral', 'skipped']) {
      assert.equal(normaliseConclusion(raw), 'skipped', `expected ${raw} to be skipped`);
    }
  });

  it('treats an unknown conclusion as pending, not as success', () => {
    // Guessing "pass" would let a broken pipeline look healthy; guessing "fail" would
    // wake a thread on noise. Pending is the only safe default.
    assert.equal(normaliseConclusion('some_new_state'), 'pending');
  });
});

describe('toCheckStates / toReviewComments', () => {
  it('keeps one entry per row so a fresh red cannot hide behind a green', () => {
    // `gh pr checks` lists the runs that exist now. Two rows sharing a name are two real
    // runs (a re-run that did not replace the original, or two matrix legs), so collapsing
    // them by name would let a passing row mask a failing one.
    const states = toCheckStates([
      { name: 'build', state: 'success' },
      { name: 'build', state: 'failure' },
      { name: 'lint', state: 'in_progress' },
    ]);
    assert.deepEqual(
      states.map((state) => [state.name, state.conclusion]),
      [
        ['build', 'pass'],
        ['build', 'fail'],
        ['lint', 'pending'],
      ],
    );
  });

  it('keeps the details link when GitHub provides one', () => {
    const states = toCheckStates([{ name: 'test', state: 'failure', link: 'https://ci/1' }]);
    assert.equal(states[0]?.detailsUrl, 'https://ci/1');
  });

  it('normalises review comments and skips empty bodies', () => {
    const comments = toReviewComments([
      { id: 11, user: { login: 'alice' }, body: 'rename me', path: 'src/a.ts', line: 3, created_at: '2026-01-02T00:00:00Z' },
      { id: 12, user: { login: 'bob' }, body: '   ' },
    ]);
    assert.equal(comments.length, 1, 'a blank comment carries no instruction to act on');
    assert.equal(comments[0]?.author, 'alice');
    assert.equal(comments[0]?.path, 'src/a.ts');
    assert.equal(comments[0]?.line, 3);
    assert.equal(comments[0]?.createdAt, Date.parse('2026-01-02T00:00:00Z'));
  });

  it('names an anonymous reviewer honestly instead of blanking the author', () => {
    const comments = toReviewComments([{ id: 1, user: {}, body: 'hi' }]);
    assert.equal(comments[0]?.author, 'unknown');
  });
});

describe('decideHealAction', () => {
  it('settles a merged PR even when a stale failure is still listed', () => {
    const action = decideHealAction({
      prRef: '7',
      prState: 'merged',
      checks: [check('build', 'fail')],
      comments: [comment('c1')],
      consumedCommentIds: [],
      healAttempts: 0,
      consecutiveFails: 0,
      threadTitle: 'login',
    });
    assert.equal(action.kind, 'transition');
    assert.equal(action.kind === 'transition' && action.status, 'completed');
  });

  it('fails a closed-without-merge PR rather than healing it forever', () => {
    const action = decideHealAction({
      prRef: '7',
      prState: 'closed',
      checks: [check('build', 'fail')],
      comments: [],
      consumedCommentIds: [],
      healAttempts: 0,
      consecutiveFails: 0,
      threadTitle: 'login',
    });
    assert.equal(action.kind, 'transition');
    assert.equal(action.kind === 'transition' && action.status, 'failed');
  });

  it('waits while any check is still pending, even next to a failure', () => {
    const action = decideHealAction({
      prRef: '7',
      prState: 'open',
      checks: [check('build', 'fail'), check('deploy', 'pending')],
      comments: [],
      consumedCommentIds: [],
      healAttempts: 0,
      consecutiveFails: 0,
      threadTitle: 'login',
    });
    // Acting mid-run would fix a failure the pipeline is about to re-report, and burn one
    // of only three heal attempts on a race that would have resolved itself.
    assert.equal(action.kind, 'wait');
  });

  it('does nothing on an all-green PR with no new comments', () => {
    const action = decideHealAction({
      prRef: '7',
      prState: 'open',
      checks: [check('build', 'pass')],
      comments: [],
      consumedCommentIds: [],
      healAttempts: 0,
      consecutiveFails: 0,
      threadTitle: 'login',
    });
    assert.equal(action.kind, 'none');
  });

  it('heals on a failed check', () => {
    const action = decideHealAction({
      prRef: '7',
      prState: 'open',
      checks: [check('build', 'fail')],
      comments: [],
      consumedCommentIds: [],
      healAttempts: 0,
      consecutiveFails: 0,
      threadTitle: 'login',
    });
    assert.equal(action.kind, 'heal');
    assert.match(action.kind === 'heal' ? action.prompt : '', /build/);
  });

  it('heals on an unconsumed review comment even when checks pass', () => {
    const action = decideHealAction({
      prRef: '7',
      prState: 'open',
      checks: [check('build', 'pass')],
      comments: [comment('c1')],
      consumedCommentIds: [],
      healAttempts: 0,
      consecutiveFails: 0,
      threadTitle: 'login',
    });
    assert.equal(action.kind, 'heal');
  });

  it('does not re-heal an already consumed comment', () => {
    const action = decideHealAction({
      prRef: '7',
      prState: 'open',
      checks: [check('build', 'pass')],
      comments: [comment('c1')],
      consumedCommentIds: ['c1'],
      healAttempts: 1,
      consecutiveFails: 1,
      threadTitle: 'login',
    });
    assert.equal(action.kind, 'none');
  });

  it('escalates once the attempt budget is spent, even with fresh failures', () => {
    const action = decideHealAction({
      prRef: '7',
      prState: 'open',
      checks: [check('build', 'fail')],
      comments: [],
      consumedCommentIds: [],
      healAttempts: MAX_HEAL_ATTEMPTS,
      consecutiveFails: MAX_HEAL_ATTEMPTS,
      threadTitle: 'login',
    });
    assert.equal(action.kind, 'escalate');
    assert.match(action.kind === 'escalate' ? action.question : '', /login/);
  });

  it('still settles a merged PR after the budget is spent', () => {
    // Settling is not a heal: refusing to close a merged PR because attempts ran out
    // would strand a finished thread in the panel forever.
    const action = decideHealAction({
      prRef: '7',
      prState: 'merged',
      checks: [check('build', 'fail')],
      comments: [],
      consumedCommentIds: [],
      healAttempts: MAX_HEAL_ATTEMPTS,
      consecutiveFails: MAX_HEAL_ATTEMPTS,
      threadTitle: 'login',
    });
    assert.equal(action.kind, 'transition');
  });

  it('treats an unknown PR state as open rather than guessing an ending', () => {
    const action = decideHealAction({
      prRef: '7',
      prState: 'unknown',
      checks: [check('build', 'fail')],
      comments: [],
      consumedCommentIds: [],
      healAttempts: 0,
      consecutiveFails: 0,
      threadTitle: 'login',
    });
    assert.equal(action.kind, 'heal');
  });
});

describe('hasActionableSignal', () => {
  it('is true only for failures and new comments', () => {
    assert.equal(hasActionableSignal(green({ checks: [check('a', 'fail')] })), true);
    assert.equal(hasActionableSignal(green({ comments: [comment('c')] })), true);
    assert.equal(hasActionableSignal(green({ comments: [comment('c')], consumedCommentIds: ['c'] })), false);
    assert.equal(hasActionableSignal(green({ checks: [check('a', 'pending')] })), false);
  });
});

describe('buildHealPrompt', () => {
  const base = {
    prRef: '7',
    prState: 'open' as const,
    checks: [],
    comments: [],
    consumedCommentIds: [],
    healAttempts: 1,
    consecutiveFails: 1,
    threadTitle: 'login',
  };

  it('names each failing check and each comment', () => {
    const prompt = buildHealPrompt(base, [check('build', 'fail'), check('unit', 'fail')], [comment('c1', 'rename it')]);
    assert.match(prompt, /build/);
    assert.match(prompt, /unit/);
    assert.match(prompt, /rename it/);
  });

  it('forbids opening a second PR and forbids weakening the tests', () => {
    // These two are the ways an auto-healer causes real damage: a PR per retry floods
    // review, and deleting an assertion turns red into green without fixing anything.
    const prompt = buildHealPrompt(base, [check('build', 'fail')], []);
    assert.match(prompt, /same branch/i);
    assert.match(prompt, /do not (?:weaken|delete)/i);
  });

  it('includes the log excerpt it is given, verbatim', () => {
    // Trimming to a tail is `tailLines`' job (tested in vcs.test.ts); the prompt must not
    // second-guess the excerpt it was handed, or the two cut-offs disagree and the thread
    // sees a different failure than the one that was classified.
    const prompt = buildHealPrompt(base, [check('build', 'fail')], [], 'line 1\nAssertionError: expected 2');
    assert.match(prompt, /AssertionError: expected 2/);
    assert.match(prompt, /```/);
  });

  it('omits the log section entirely when no excerpt is available', () => {
    const prompt = buildHealPrompt(base, [check('build', 'fail')], [], '   ');
    assert.equal(prompt.includes('Failing log excerpt'), false);
  });

  it('states the isolation context so the thread does not wander out of its branch', () => {
    const prompt = buildHealPrompt(base, [check('build', 'fail')], []);
    assert.match(prompt, /branch/i);
  });
});

describe('mergeSnapshot / consumeComments', () => {
  it('preserves consumed ids across a merge', () => {
    const merged = mergeSnapshot(
      { prRef: '7', state: 'open', checks: [], comments: [], consumedCommentIds: ['c1'], observedAt: 1 },
      {
        prRef: '7',
        state: 'open',
        checks: [],
        comments: [comment('c2')],
        now: 2,
      },
    );
    assert.deepEqual(merged.consumedCommentIds, ['c1']);
    assert.equal(merged.comments.length, 1);
    assert.equal(merged.observedAt, 2);
  });

  it('carries the PR link when GitHub reported one', () => {
    const merged = mergeSnapshot(undefined, {
      prRef: '7',
      prUrl: 'https://github.com/o/r/pull/7',
      state: 'open',
      checks: [],
      comments: [],
      now: 2,
    });
    assert.equal(merged.prUrl, 'https://github.com/o/r/pull/7');
  });

  it('accumulates consumed ids without duplicating them', () => {
    const first = consumeComments(green({ comments: [comment('a'), comment('b')] }), [
      comment('a'),
      comment('b'),
    ]);
    assert.deepEqual([...first].sort(), ['a', 'b']);
    const second = consumeComments(green({ comments: [comment('b')], consumedCommentIds: first }), [
      comment('b'),
      comment('c'),
    ]);
    assert.deepEqual([...second].sort(), ['a', 'b', 'c']);
  });
});

describe('failureSignature', () => {
  it('names the failing checks in a stable order', () => {
    assert.equal(failureSignature([check('unit', 'fail'), check('build', 'fail')]), 'build|unit');
    // Reversing the input must not look like a different problem.
    assert.equal(failureSignature([check('build', 'fail'), check('unit', 'fail')]), 'build|unit');
  });

  it('ignores checks that are passing, pending or skipped', () => {
    assert.equal(
      failureSignature([check('build', 'pass'), check('unit', 'pending'), check('lint', 'skipped')]),
      '',
    );
  });

  it('changes when one more check starts failing', () => {
    assert.notEqual(failureSignature([check('build', 'fail')]), failureSignature([check('build', 'fail'), check('unit', 'fail')]));
  });

  it('is empty for an empty list', () => {
    assert.equal(failureSignature([]), '');
  });
});

describe('decideHealAction: consecutive-failure budget', () => {
  it('escalates once the same failure has survived the budget', () => {
    const action = decideHealAction({
      prRef: '7',
      prState: 'open',
      checks: [check('build', 'fail')],
      comments: [],
      consumedCommentIds: [],
      healAttempts: MAX_HEAL_ATTEMPTS,
      consecutiveFails: MAX_HEAL_ATTEMPTS,
      threadTitle: 'login',
    });
    assert.equal(action.kind, 'escalate');
    assert.match(action.kind === 'escalate' ? action.question : '', /same failure/);
    assert.match(action.kind === 'escalate' ? action.reason : '', /survived/);
  });

  it('keeps healing while the lifetime count is high but the streak is low', () => {
    // Six review rounds, each one new: a lifetime budget would have given up here, which
    // is exactly the case this split exists for.
    const action = decideHealAction({
      prRef: '7',
      prState: 'open',
      checks: [check('build', 'fail')],
      comments: [comment('c9')],
      consumedCommentIds: [],
      healAttempts: 9,
      consecutiveFails: 0,
      threadTitle: 'login',
    });
    assert.equal(action.kind, 'heal');
  });

  it('names the streak length honestly when escalating', () => {
    const action = decideHealAction({
      prRef: '7',
      prState: 'open',
      checks: [check('build', 'fail'), check('unit', 'fail')],
      comments: [],
      consumedCommentIds: [],
      healAttempts: 7,
      consecutiveFails: 3,
      threadTitle: 'login',
    });
    assert.equal(action.kind, 'escalate');
    const question = action.kind === 'escalate' ? action.question : '';
    assert.match(question, /3 automatic repairs in a row/);
    assert.match(question, /7 round\(s\) total/);
    assert.match(question, /build, unit/);
  });
});
