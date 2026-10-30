/**
 * The `subagents` adapter, exercised without a Host.
 *
 * The bug this file exists for: `markEnded` had no caller, so a real thread stayed
 * `running` after its first turn — no review bucket, no CI poll, no panel update. What the
 * adapter owns is exactly one mapping (one Host event to one engine outcome) and one
 * fan-out, so both are asserted here without a Host or a child process.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { HostSubagents } from '../../src/host/hostTypes.js';
import { SubagentThreadRuntime } from '../../src/host/subagents.js';

/** A runtime whose service is never touched; only launch/resume call it. */
function runtime(): SubagentThreadRuntime {
  const service = {
    getProvider: () => undefined,
    list: () => [],
  } as unknown as HostSubagents;
  return new SubagentThreadRuntime(service, 'spawn');
}

describe('SubagentThreadRuntime turn ends', () => {
  it('delivers a finished turn to every listener with the child session id', () => {
    const subject = runtime();
    const seen: Array<[string, string]> = [];
    subject.onSettled((childSessionId, outcome) => {
      seen.push([childSessionId, outcome.text]);
    });
    subject.onSettled((childSessionId, outcome) => {
      seen.push([`second:${childSessionId}`, outcome.stopReason]);
    });
    subject.markEnded('child-1', { stopReason: 'completed', text: 'done' });
    assert.deepEqual(seen, [
      ['child-1', 'done'],
      ['second:child-1', 'completed'],
    ]);
  });

  it('stops delivering once a listener unsubscribes', () => {
    const subject = runtime();
    let calls = 0;
    const detach = subject.onSettled(() => {
      calls += 1;
    });
    subject.markEnded('child-1', { stopReason: 'completed', text: 'first' });
    detach();
    subject.markEnded('child-1', { stopReason: 'completed', text: 'second' });
    assert.equal(calls, 1);
  });
});

describe('SubagentThreadRuntime.outcomeFromEnd', () => {
  it('flattens a content-block closing message', () => {
    const outcome = SubagentThreadRuntime.outcomeFromEnd({
      stopReason: 'completed',
      lastAssistantMessage: [
        { type: 'text', text: 'done' },
        { type: 'text', text: 'in two lines' },
      ],
    });
    assert.equal(outcome.text, 'done\nin two lines');
    assert.equal(outcome.stopReason, 'completed');
  });

  it('accepts the string shape older Hosts emitted', () => {
    // The field has been both a flattened string and content blocks; reading only one shape
    // would make every resumed turn look like it produced no answer.
    const outcome = SubagentThreadRuntime.outcomeFromEnd({
      stopReason: 'completed',
      lastAssistantMessage: 'all green',
    });
    assert.equal(outcome.text, 'all green');
  });

  it('reports an unknown stop reason instead of inventing success', () => {
    const outcome = SubagentThreadRuntime.outcomeFromEnd({});
    assert.equal(outcome.stopReason, 'unknown');
    assert.equal(outcome.text, '');
  });

  it('keeps the provider diagnostic', () => {
    const outcome = SubagentThreadRuntime.outcomeFromEnd({
      stopReason: 'error',
      diagnostic: 'provider refused the turn',
    });
    assert.equal(outcome.diagnostic, 'provider refused the turn');
  });
});

describe('SubagentThreadRuntime availability', () => {
  it('reports an unregistered provider instead of claiming threads work', () => {
    const subject = runtime();
    assert.equal(subject.available(), false);
    assert.match(subject.unavailableReason(), /not registered/);
  });

  it('requires a continuable provider, because a one-shot child cannot be resumed', () => {
    const service = {
      getProvider: () => ({ prepareContinuable: undefined }),
      list: () => ['spawn'],
    } as unknown as HostSubagents;
    const subject = new SubagentThreadRuntime(service, 'spawn');
    assert.equal(subject.available(), false);
    assert.match(subject.unavailableReason(), /cannot continue a child session/);
  });
});
