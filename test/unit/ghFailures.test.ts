/**
 * Tests for `gh` failure classification.
 *
 * This is the boundary between "keep polling" and "this pull request is over". Getting it
 * wrong in one direction sticks a finished thread in `awaiting_review` forever; getting it
 * wrong in the other stops monitoring on a transient network blip and never resumes. Every
 * case below comes from a real message shape `gh` emits.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyGhFailure } from '../../src/core/vcs.js';

describe('classifyGhFailure', () => {
  it('treats a deleted branch as the end of monitoring', () => {
    assert.equal(classifyGhFailure('no pull requests found for branch "project/demo/1-one"'), 'terminal');
  });

  it('treats a missing pull request as terminal', () => {
    assert.equal(classifyGhFailure('GraphQL: Could not resolve to a PullRequest with the number of 7.'), 'terminal');
    assert.equal(classifyGhFailure('HTTP 404: Not Found (https://api.github.com/graphql)'), 'terminal');
  });

  it('treats a missing repository or remote as terminal', () => {
    assert.equal(classifyGhFailure('repository not found: acme/demo'), 'terminal');
    assert.equal(classifyGhFailure("fatal: no such remote 'origin'"), 'terminal');
  });

  it('keeps polling on an expired or missing token', () => {
    assert.equal(classifyGhFailure('HTTP 401: Bad credentials (https://api.github.com/graphql)'), 'retryable');
    assert.equal(classifyGhFailure('gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN'), 'retryable');
  });

  it('keeps polling on rate limits', () => {
    assert.equal(classifyGhFailure('HTTP 403: API rate limit exceeded for user ID 1.'), 'retryable');
    assert.equal(classifyGhFailure('You have exceeded a secondary rate limit.'), 'retryable');
  });

  it('keeps polling on network trouble', () => {
    assert.equal(classifyGhFailure('dial tcp 140.82.112.6:443: i/o timeout'), 'retryable');
    assert.equal(classifyGhFailure('connect: network is unreachable'), 'retryable');
    assert.equal(classifyGhFailure('net/http: TLS handshake timeout'), 'retryable');
  });

  it('treats a repository with no CI as benign rather than as a failure', () => {
    // `gh pr checks` exits non-zero here, and reading that as an error would report a
    // healthy pull request as broken on every single sweep.
    assert.equal(classifyGhFailure('no checks reported on the "project/demo/1-one" branch'), 'benign');
    assert.equal(classifyGhFailure('   '), 'benign');
    assert.equal(classifyGhFailure(''), 'benign');
  });

  it('defaults an unknown message to retryable', () => {
    // Never silently unsubscribe on a message nobody has classified: retrying is
    // recoverable, an unnoticed permanent stop is not.
    assert.equal(classifyGhFailure('some brand new failure phrasing'), 'retryable');
  });
});
