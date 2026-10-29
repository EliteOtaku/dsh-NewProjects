import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildUsage, formatTokens, renderUsageMarkdown, type RawThreadUsage } from '../../src/core/usage.js';
import { summariseSession } from '../../src/host/usage.js';
import type { HostSessionEvent } from '../../src/host/hostTypes.js';
import type { ProjectThreadDescriptor } from '../../src/types.js';

function makeThread(overrides: Partial<ProjectThreadDescriptor> = {}): ProjectThreadDescriptor {
  return {
    threadId: 'thr-1',
    childSessionId: 'child-1',
    title: 'add the settings page',
    objective: 'add the settings page and its validation',
    branchOrScope: 'project/demo/1-add-the-settings-page',
    status: 'running',
    branch: 'project/demo/1-add-the-settings-page',
    baseCommit: 'deadbeef',
    startedAt: Date.parse('2026-01-02T03:04:05Z'),
    updatedAt: Date.parse('2026-01-02T03:04:05Z'),
    ...overrides,
  };
}

function raw(overrides: Partial<RawThreadUsage> = {}): RawThreadUsage {
  return {
    calls: 2,
    inputTokens: 1_000,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    models: [{ provider: 'p', model: 'm', calls: 2, inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 }],
    ...overrides,
  };
}

describe('buildUsage', () => {
  it('reports nothing as unavailable rather than as zero when a thread was never measured', () => {
    const usage = buildUsage([makeThread()], new Map(), 5);
    assert.equal(usage.available, false);
    assert.match(usage.unavailable ?? '', /no usage record/);
    assert.equal(usage.threads[0]?.unavailable !== undefined, true);
    // The row still exists: a vanished thread must not silently drop out of the project total.
    assert.equal(usage.threads.length, 1);
    assert.equal(usage.totals.threads, 1);
  });

  it('takes the unavailable reason from the caller when the Host has no session log at all', () => {
    const usage = buildUsage([makeThread()], new Map(), 5, 'this Host exposes no session log');
    assert.match(usage.unavailable ?? '', /no session log/);
    assert.match(usage.threads[0]?.unavailable ?? '', /no session log/);
  });

  it('is available and additive when every thread measured', () => {
    const measured = new Map<string, RawThreadUsage>([
      ['thr-1', raw()],
      ['thr-2', raw({ calls: 1, inputTokens: 500, outputTokens: 100 })],
    ]);
    const usage = buildUsage([makeThread(), makeThread({ threadId: 'thr-2', title: 'second' })], measured, 7);
    assert.equal(usage.available, true);
    assert.equal(usage.unavailable, undefined);
    assert.equal(usage.totals.calls, 3);
    assert.equal(usage.totals.inputTokens, 1_500);
    assert.equal(usage.totals.outputTokens, 300);
    assert.equal(usage.observedAt, 7);
  });

  it('orders threads and models by spend so the expensive ones lead', () => {
    const measured = new Map<string, RawThreadUsage>([
      ['thr-1', raw()],
      ['thr-2', raw({ inputTokens: 9_000, outputTokens: 0, models: [{ provider: 'p', model: 'big', calls: 1, inputTokens: 9_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }] })],
    ]);
    const usage = buildUsage([makeThread(), makeThread({ threadId: 'thr-2', title: 'second' })], measured, 1);
    assert.equal(usage.threads[0]?.threadId, 'thr-2');
    assert.equal(usage.byModel[0]?.model, 'big');
  });

  it('keeps two providers apart even when the model name matches', () => {
    // Keying by model alone would merge `a/x` and `b/x` and make the per-model breakdown lie.
    const measured = new Map<string, RawThreadUsage>([
      ['thr-1', raw({ models: [{ provider: 'a', model: 'x', calls: 1, inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }] })],
      ['thr-2', raw({ models: [{ provider: 'b', model: 'x', calls: 1, inputTokens: 20, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }] })],
    ]);
    const usage = buildUsage([makeThread(), makeThread({ threadId: 'thr-2' })], measured, 1);
    assert.equal(usage.byModel.length, 2);
  });

  it('carries a per-thread gap without blanking the whole panel', () => {
    const measured = new Map<string, RawThreadUsage>([
      ['thr-1', raw()],
      ['thr-2', raw({ unavailable: 'session was pruned' })],
    ]);
    const usage = buildUsage([makeThread(), makeThread({ threadId: 'thr-2' })], measured, 1);
    assert.equal(usage.available, false);
    assert.match(usage.unavailable ?? '', /session was pruned/);
    // The measured thread still reports its numbers.
    assert.equal(usage.threads.find((row) => row.threadId === 'thr-1')?.inputTokens, 1_000);
  });
});

describe('formatTokens', () => {
  it('compacts thousands and millions without inventing precision', () => {
    assert.equal(formatTokens(0), '0');
    assert.equal(formatTokens(-5), '0');
    assert.equal(formatTokens(999), '999');
    assert.equal(formatTokens(1_234), '1.2k');
    assert.equal(formatTokens(12_345), '12k');
    assert.equal(formatTokens(1_500_000), '1.5M');
  });
});

describe('renderUsageMarkdown', () => {
  it('leads with the unavailable notice so a table of zeros is not read as free', () => {
    const usage = buildUsage([makeThread()], new Map(), 1, 'no session log');
    const text = renderUsageMarkdown(usage);
    assert.match(text, /^## Usage\n- not reported: no session log/);
    assert.match(text, /nothing to break down/);
  });

  it('lists each thread with its split, and caches only when present', () => {
    const measured = new Map<string, RawThreadUsage>([['thr-1', raw({ cacheReadTokens: 4_000 })]]);
    const text = renderUsageMarkdown(buildUsage([makeThread()], measured, 1));
    assert.match(text, /total: 1\.0k in \/ 200 out across 2 call\(s\)/);
    assert.match(text, /cache: 4\.0k read \/ 0 written/);
    assert.match(text, /\*\*add the settings page\*\* \(running\): 1\.0k in \/ 200 out \/ 4\.0k cached/);
    assert.match(text, /By model:/);
    assert.match(text, /p\/m: 1\.0k in \/ 200 out/);
  });

  it('marks an unmeasured thread inline instead of printing zeros', () => {
    // One measured thread keeps the table from collapsing into the "nothing to break down" form,
    // so this asserts the inline row a partially-read project produces.
    const measured = new Map<string, RawThreadUsage>([['thr-1', raw()]]);
    const text = renderUsageMarkdown(
      buildUsage(
        [makeThread(), makeThread({ threadId: 'thr-2', title: 'second' })],
        measured,
        1,
        'session log unavailable',
      ),
    );
    assert.match(text, /\*\*second\*\* \(running\): usage unavailable — session log unavailable/);
  });

  it('names the reason in the header when no thread reported anything', () => {
    const text = renderUsageMarkdown(buildUsage([makeThread()], new Map(), 1, 'session log unavailable'));
    assert.match(text, /not reported: .*session log unavailable/);
    assert.match(text, /nothing to break down/);
  });

  it('shows context pressure only when the meter reported it', () => {
    const measured = new Map<string, RawThreadUsage>([['thr-1', raw({ pressureTokens: 8_000 })]]);
    assert.match(renderUsageMarkdown(buildUsage([makeThread()], measured, 1)), /8\.0k in context/);
  });
});

describe('summariseSession', () => {
  function event(data: unknown, type = 'assistant/message'): HostSessionEvent {
    return { type, data };
  }

  it('sums the provider usage blocks and attributes them to the answering route', () => {
    const row = summariseSession([
      event({ usage: { inputTokens: 100, outputTokens: 10 }, message: { source: { kind: 'model', provider: 'a', model: 'm' } } }),
      event({ usage: { inputTokens: 50, outputTokens: 5, cacheReadTokens: 7 }, message: { source: { kind: 'model', provider: 'a', model: 'm' } } }),
      event({}, 'user/message'),
      { type: 'tool/call', data: {} },
    ]);
    assert.equal(row.calls, 2);
    assert.equal(row.inputTokens, 150);
    assert.equal(row.outputTokens, 15);
    assert.equal(row.cacheReadTokens, 7);
    assert.equal(row.models.length, 1);
    assert.equal(row.models[0]?.model, 'm');
  });

  it('counts a call even when the provider reported no usage', () => {
    const row = summariseSession([event({ message: { source: { kind: 'model', provider: 'a', model: 'm' } } })]);
    assert.equal(row.calls, 1);
    assert.equal(row.inputTokens, 0);
  });

  it('keeps the spend even when the message carries no route', () => {
    const row = summariseSession([event({ usage: { inputTokens: 9, outputTokens: 1 } })]);
    assert.equal(row.inputTokens, 9);
    assert.equal(row.models.length, 0);
  });

  it('splits one session across models when the route changed mid-thread', () => {
    const row = summariseSession([
      event({ usage: { inputTokens: 10, outputTokens: 1 }, message: { source: { kind: 'model', provider: 'a', model: 'x' } } }),
      event({ usage: { inputTokens: 20, outputTokens: 2 }, message: { source: { kind: 'model', provider: 'b', model: 'y' } } }),
    ]);
    assert.equal(row.models.length, 2);
    assert.equal(row.inputTokens, 30);
  });
});
