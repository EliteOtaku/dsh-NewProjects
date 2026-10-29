import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isLockConflict,
  LOCK_EXHAUSTED_NOTE,
  LOCK_RETRY_ATTEMPTS,
  withLockRetry,
} from '../../src/core/exec.js';
import type { CommandResult, CommandRunner, CommandSpec } from '../../src/core/exec.js';

const SPEC: CommandSpec = { argv: ['git', 'commit', '-m', 'x'], cwd: '/repo' };

function ok(stdout = ''): CommandResult {
  return { exitCode: 0, stdout, stderr: '' };
}

function failed(stderr: string): CommandResult {
  return { exitCode: 1, stdout: '', stderr };
}

/** A runner that answers from a scripted list and records every spec it saw. */
function scripted(answers: CommandResult[]): CommandRunner & { calls: CommandSpec[] } {
  const calls: CommandSpec[] = [];
  return {
    calls,
    run(spec: CommandSpec): Promise<CommandResult> {
      calls.push(spec);
      const next = answers.shift();
      if (next === undefined) throw new Error('scripted runner ran out of answers');
      return Promise.resolve(next);
    },
  };
}

const GIT_LOCK = "error: cannot lock ref 'refs/heads/project/demo/1-x': Unable to create '/repo/.git/refs/heads/x.lock': File exists.";

describe('isLockConflict', () => {
  it('recognises the shapes git actually prints', () => {
    assert.equal(isLockConflict(failed(GIT_LOCK)), true);
    assert.equal(isLockConflict(failed('fatal: Unable to create \'/repo/.git/index.lock\': File exists.')), true);
    assert.equal(isLockConflict(failed('error: could not lock the index')), true);
    assert.equal(isLockConflict(failed('fatal: Another git process seems to be running in this repository')), true);
  });

  it('does not treat a real rejection as contention', () => {
    // Retrying these would only delay the truth.
    assert.equal(isLockConflict(failed('! [rejected] main -> main (non-fast-forward)')), false);
    assert.equal(isLockConflict(failed('fatal: Authentication failed for repository')), false);
    assert.equal(isLockConflict(ok()), false);
  });
});

describe('withLockRetry', () => {
  it('retries a lock conflict and returns the eventual success', async () => {
    const inner = scripted([failed(GIT_LOCK), failed(GIT_LOCK), ok('committed')]);
    const runner = withLockRetry(inner, { sleep: () => Promise.resolve() });
    const result = await runner.run(SPEC);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'committed');
    assert.equal(inner.calls.length, 3);
  });

  it('reports contention, not a bad change, once attempts run out', async () => {
    const inner = scripted([failed(GIT_LOCK), failed(GIT_LOCK), failed(GIT_LOCK)]);
    const retried: number[] = [];
    const runner = withLockRetry(inner, {
      sleep: () => Promise.resolve(),
      onRetry: (attempt) => retried.push(attempt),
    });
    const result = await runner.run(SPEC);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /cannot lock ref/);
    assert.match(result.stderr, /busy with another thread/);
    assert.ok(result.stderr.includes(LOCK_EXHAUSTED_NOTE), result.stderr);
    assert.deepEqual(retried, [1, 2]);
    assert.equal(inner.calls.length, LOCK_RETRY_ATTEMPTS);
  });

  it('does not retry a genuine failure', async () => {
    const inner = scripted([failed('! [rejected] main -> main (non-fast-forward)')]);
    const runner = withLockRetry(inner, { sleep: () => Promise.resolve() });
    const result = await runner.run(SPEC);
    assert.equal(result.exitCode, 1);
    assert.doesNotMatch(result.stderr, /busy with another thread/);
    assert.equal(inner.calls.length, 1);
  });

  it('honours a caller-chosen attempt count', async () => {
    const inner = scripted([failed(GIT_LOCK), failed(GIT_LOCK)]);
    const runner = withLockRetry(inner, { attempts: 2, sleep: () => Promise.resolve() });
    const result = await runner.run(SPEC);
    assert.notEqual(result.exitCode, 0);
    assert.equal(inner.calls.length, 2);
  });

  it('disables retrying when attempts is 1', async () => {
    const inner = scripted([failed(GIT_LOCK)]);
    const runner = withLockRetry(inner, { attempts: 1, sleep: () => Promise.resolve() });
    const result = await runner.run(SPEC);
    assert.match(result.stderr, /busy with another thread/);
    assert.equal(inner.calls.length, 1);
  });

  it('returns a spawn failure without retrying or blaming the repository', async () => {
    // A missing executable is not contention; retrying it would only multiply the wait.
    const inner = scripted([{ exitCode: null, stdout: '', stderr: '', spawnError: 'spawn git ENOENT' }]);
    const runner = withLockRetry(inner, { sleep: () => Promise.resolve() });
    const result = await runner.run(SPEC);
    assert.equal(result.spawnError, 'spawn git ENOENT');
    assert.doesNotMatch(result.stderr, /busy with another thread/);
    assert.equal(inner.calls.length, 1);
  });
});
