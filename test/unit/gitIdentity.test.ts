/**
 * The fallback identity is a retry, not a probe: git is asked first, and only its own
 * refusal brings the fallback in. Anything else that fails a commit must surface as is.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FALLBACK_GIT_IDENTITY, commitAll, isMissingGitIdentity } from '../../src/core/vcs.js';
import { FakeRunner } from '../helpers.js';

function dirtyRepo(): FakeRunner {
  const runner = new FakeRunner();
  runner.on('git status --porcelain', { stdout: ' M a.ts\n' });
  runner.on('git add', { exitCode: 0 });
  runner.on('git rev-parse HEAD', { stdout: 'abc1234\n' });
  return runner;
}

describe('commit identity fallback', () => {
  it('recognises the refusals git prints when it has no identity', () => {
    assert.ok(isMissingGitIdentity('*** Please tell me who you are.\n\nRun\n\n  git config --global user.email'));
    assert.ok(isMissingGitIdentity('fatal: empty ident name (for <>) not allowed'));
    assert.ok(isMissingGitIdentity("fatal: unable to auto-detect email address (got 'me@box.(none)')"));
    assert.ok(isMissingGitIdentity('fatal: no email was given and auto-detection is disabled'));
    assert.equal(isMissingGitIdentity('error: pathspec did not match'), false);
  });

  it('retries once under the fallback identity when git has none', async () => {
    const runner = dirtyRepo();
    runner.onCommand('git commit', (spec) =>
      spec.env === undefined ? { exitCode: 128, stderr: 'fatal: empty ident name (for <>) not allowed' } : { stdout: '[x abc1234] work\n' },
    );
    const result = await commitAll(runner, { cwd: '/repo', message: 'work' });
    assert.equal(result.committed, true);
    const commits = runner.callsFor('git commit');
    assert.equal(commits.length, 2);
    assert.equal(commits[1]?.env?.['GIT_AUTHOR_NAME'], FALLBACK_GIT_IDENTITY.name);
    assert.equal(commits[1]?.env?.['GIT_COMMITTER_EMAIL'], FALLBACK_GIT_IDENTITY.email);
    // No probe and no write: the fallback lives in one commit's environment, not in `.git/config`.
    assert.equal(runner.saw('git config'), false);
  });

  it('does not retry a commit that failed for another reason', async () => {
    const runner = dirtyRepo();
    runner.on('git commit', { exitCode: 1, stderr: 'error: gpg failed to sign the data' });
    await assert.rejects(() => commitAll(runner, { cwd: '/repo', message: 'work' }), /gpg failed/);
    assert.equal(runner.callsFor('git commit').length, 1);
  });

  it('keeps an identity the caller chose, even when git refuses it', async () => {
    const runner = dirtyRepo();
    runner.on('git commit', { exitCode: 128, stderr: 'fatal: empty ident name (for <>) not allowed' });
    await assert.rejects(() => commitAll(runner, { cwd: '/repo', message: 'work', authorName: 'Ada', authorEmail: 'ada@example.com' }));
    assert.equal(runner.callsFor('git commit').length, 1);
  });
});
