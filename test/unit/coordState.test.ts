import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  appendRecent,
  describeGoal,
  MAX_GOAL_CHARS,
  MAX_RECENT_MESSAGE_CHARS,
  newestFirst,
  normaliseGoal,
  RECENT_MESSAGE_LIMIT,
  renderGoalSection,
  renderRecentMessages,
} from '../../src/core/coordState.js';
import type { ProjectManifest } from '../../src/types.js';
import { makeManifest } from './manifestFixture.js';

describe('normaliseGoal', () => {
  it('collapses whitespace so a pasted multi-line goal is still one line', () => {
    assert.equal(normaliseGoal('  ship   the\n\n thing  '), 'ship the thing');
  });

  it('treats blank input as no goal', () => {
    assert.equal(normaliseGoal('   '), undefined);
    assert.equal(normaliseGoal(undefined), undefined);
  });

  it('caps the goal at the documented one-line budget', () => {
    const goal = normaliseGoal('x'.repeat(MAX_GOAL_CHARS + 40));
    assert.equal(goal?.length, MAX_GOAL_CHARS);
  });
});

describe('renderGoalSection', () => {
  it('renders nothing at all without a goal', () => {
    // An empty heading would tell every thread "this project has a goal, and it is blank".
    assert.equal(renderGoalSection(undefined), '');
    assert.equal(renderGoalSection('   '), '');
  });

  it('names the goal so a thread can judge scope against it', () => {
    const text = renderGoalSection('ship the beta');
    assert.match(text, /ship the beta/);
    assert.match(text, /goal/i);
  });
});

describe('describeGoal', () => {
  it('reports the manifest goal and says so when there is none', () => {
    assert.equal(describeGoal(makeManifest()), undefined);
    const withGoal: ProjectManifest = { ...makeManifest(), goal: 'ship it' };
    assert.equal(describeGoal(withGoal), 'ship it');
  });
});

describe('appendRecent', () => {
  it('keeps the ring bounded instead of growing forever', () => {
    let ring: ReturnType<typeof appendRecent> = [];
    for (let index = 0; index < RECENT_MESSAGE_LIMIT + 5; index += 1) {
      ring = appendRecent(ring, { at: index, role: 'coordinator', text: `message ${index}` });
    }
    assert.equal(ring.length, RECENT_MESSAGE_LIMIT);
    // The tail is what matters: the newest message must survive.
    assert.equal(ring[ring.length - 1]?.text, `message ${RECENT_MESSAGE_LIMIT + 4}`);
    assert.equal(ring[0]?.text, 'message 5');
  });

  it('caps a single long message so one paste cannot crowd out the rest', () => {
    const ring = appendRecent([], { at: 1, role: 'user', text: 'y'.repeat(MAX_RECENT_MESSAGE_CHARS + 100) });
    assert.equal(ring[0]?.text.length, MAX_RECENT_MESSAGE_CHARS);
  });

  it('ignores an empty message instead of storing a blank line', () => {
    assert.deepEqual(appendRecent([], { at: 1, role: 'user', text: '   ' }), []);
  });

  it('returns a new array so a concurrent writer cannot alias the previous snapshot', () => {
    const first = appendRecent([], { at: 1, role: 'user', text: 'one' });
    const second = appendRecent(first, { at: 2, role: 'user', text: 'two' });
    assert.equal(first.length, 1);
    assert.equal(second.length, 2);
  });
});

describe('describe recent messages', () => {
  it('reads newest first without reordering what is stored', () => {
    const stored = appendRecent(appendRecent([], { at: 1, role: 'user', text: 'one' }), {
      at: 2,
      role: 'coordinator',
      text: 'two',
    });
    assert.deepEqual(
      newestFirst(stored).map((message) => message.text),
      ['two', 'one'],
    );
    assert.deepEqual(
      stored.map((message) => message.text),
      ['one', 'two'],
    );
  });

  it('renders nothing when there is no history', () => {
    assert.equal(renderRecentMessages([]), '');
  });

  it('renders a bounded tail', () => {
    let ring: ReturnType<typeof appendRecent> = [];
    for (let index = 0; index < 10; index += 1) {
      ring = appendRecent(ring, { at: index, role: 'user', text: `m${index}` });
    }
    const text = renderRecentMessages(ring, 3);
    assert.match(text, /m9/);
    assert.match(text, /m7/);
    assert.doesNotMatch(text, /m6\b/);
  });
});
