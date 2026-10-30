import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_INSTRUCTIONS_CHARS,
  instructionsOverBudget,
  memoryOverBudget,
  renderConflictRequest,
  renderMergeRequest,
  renderProjectCharter,
  renderThreadTask,
} from '../../src/core/prompt.js';
import { renderMemoryPrefix } from '../../src/core/memory.js';
import type { ProjectManifest, ProjectThreadDescriptor } from '../../src/types.js';
import { makeManifest } from './manifestFixture.js';

/** One shared-memory entry whose decision text is exactly `decision` long. */
function manifestWithMemory(decision: string): ProjectManifest {
  return {
    ...makeManifest(),
    memories: {
      'release-window': {
        key: 'release-window',
        decision,
        rationale: '',
        updatedAt: 0,
        revision: 1,
        authorThreadId: 'coordinator',
      },
    },
  };
}

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

describe('renderThreadTask', () => {
  it('carries the three OFFICIAL prohibitions into the first turn', () => {
    // OFFICIAL: "Don't merge, force-push, or change CI configuration without asking me in the
    // thread." The first turn is where a thread is most tempted to rewrite the branch to escape
    // a rebase, or to relax the workflow instead of fixing the code that fails it.
    const prompt = renderThreadTask(makeThread(), {});
    assert.match(prompt, /Do not force-push/);
    assert.match(prompt, /Do not change CI configuration/);
    assert.match(prompt, /Do not merge your own pull request/);
  });

  it('keeps threads out of the shared git configuration', () => {
    // Every worktree shares one `.git`: a `git config` written by one thread lands in the
    // user's repository and in every sibling thread at once.
    const prompt = renderThreadTask(makeThread(), {});
    assert.match(prompt, /Do not change git configuration/);
    assert.match(prompt, /git -c key=value/);
  });

  it('names the branch and the push/open commands when there is a branch', () => {
    const prompt = renderThreadTask(makeThread(), {});
    assert.match(prompt, /project\/demo\/1-add-the-settings-page/);
    assert.match(prompt, /gh pr create/);
  });

  it('drops the pull request steps for a scope-only thread', () => {
    // A scope thread has no branch to push, so promising a PR path would send it looking for
    // a remote that was never cut.
    const prompt = renderThreadTask(makeThread({ branch: undefined, branchOrScope: 'src/settings' }), {});
    assert.equal(prompt.includes('gh pr create'), false);
    assert.match(prompt, /Report exactly which files you changed/);
  });
});

describe('renderMergeRequest', () => {
  it('asks the thread to verify mergeability before merging', () => {
    const prompt = renderMergeRequest(makeThread({ prOrDeliverableRef: 'https://github.com/o/r/pull/7' }));
    assert.match(prompt, /https:\/\/github\.com\/o\/r\/pull\/7/);
    assert.match(prompt, /checks green/);
    assert.match(prompt, /Merge the pull request yourself/);
  });

  it('keeps force-push and CI edits forbidden on the merge path', () => {
    const prompt = renderMergeRequest(makeThread());
    assert.match(prompt, /Do not force-push/);
    assert.match(prompt, /not change CI configuration/);
  });
});

describe('renderConflictRequest', () => {
  it('lists the candidate files and says git decides the real ones', () => {
    const prompt = renderConflictRequest(makeThread(), { base: 'main', files: ['src/shared.ts'] });
    assert.match(prompt, /src\/shared\.ts/);
    assert.match(prompt, /candidate|likely/i);
    assert.match(prompt, /Git decides the real ones/);
  });

  it('omits the list when nothing overlaps but keeps the instruction', () => {
    // An empty intersection is not proof of a clean merge; a list of zero files would read as
    // "we already checked, nothing to do".
    const prompt = renderConflictRequest(makeThread(), { base: 'main', files: [] });
    assert.equal(prompt.includes('Files both sides touched'), false);
    assert.match(prompt, /Bring `main` into your branch/);
  });
});

describe('renderProjectCharter', () => {
  it('is byte-identical for the same manifest', () => {
    // The charter is the shared prefix; if two renders differ, no provider-side cache can hit.
    const manifest = makeManifest();
    const first = renderProjectCharter({ manifest, knowledgePaths: [] });
    const second = renderProjectCharter({ manifest, knowledgePaths: [] });
    assert.equal(first, second);
  });

  it('never leaks a per-thread detail into the shared prefix', () => {
    const manifest = makeManifest();
    const text = renderProjectCharter({ manifest, knowledgePaths: [] });
    assert.equal(text.includes('thr-1'), false);
    assert.equal(text.includes('child-1'), false);
  });
});

describe('standing-text budget', () => {
  it('measures instructions against the documented 16,000 characters', () => {
    assert.equal(MAX_INSTRUCTIONS_CHARS, 16_000);
    assert.equal(instructionsOverBudget(undefined), 0);
    assert.equal(instructionsOverBudget('   '), 0);
    assert.equal(instructionsOverBudget('x'.repeat(MAX_INSTRUCTIONS_CHARS)), 0);
    assert.equal(instructionsOverBudget('x'.repeat(MAX_INSTRUCTIONS_CHARS + 1)), 1);
    // Trimming means the ruler counts content, not the newline the editor left behind.
    assert.equal(instructionsOverBudget('x'.repeat(MAX_INSTRUCTIONS_CHARS) + String.fromCharCode(10)), 0);
  });

  it('measures shared memory with the same ruler, not a second number', () => {
    assert.equal(memoryOverBudget(makeManifest()), 0);

    // The renderer itself supplies the fixed header length, so this pins the *threshold*
    // instead of a hand-counted header that would drift the first time the wording changes.
    const header = renderMemoryPrefix(manifestWithMemory('')).length;
    const decision = 'x'.repeat(MAX_INSTRUCTIONS_CHARS - header);
    assert.equal(renderMemoryPrefix(manifestWithMemory(decision)).length, MAX_INSTRUCTIONS_CHARS);
    assert.equal(memoryOverBudget(manifestWithMemory(decision)), 0);
    assert.equal(memoryOverBudget(manifestWithMemory(decision + 'xxxxx')), 5);
  });
});
