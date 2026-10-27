/**
 * Prompt assembly for threads.
 *
 * Layout matters for cost, not just clarity. The block is split so that the part
 * shared by *every* agent in the project (and therefore every child session) is
 * byte-identical:
 *
 * - {@link renderProjectCharter} goes into a global system-prompt section. All
 *   threads and the coordinator share it, so their prefixes match and a
 *   provider-side prompt cache can be reused across sessions.
 * - The per-thread task block goes into the child's first user message.
 *
 * Nothing time-varying is allowed in the charter: no timestamps, no counters, no
 * thread ids. Those belong in the task block.
 */

import { renderMemoryPrefix } from './memory.js';
import type { ProjectManifest, ProjectThreadDescriptor } from '../types.js';

/** Read-only facts the charter needs about the project. */
export interface CharterInput {
  manifest: ProjectManifest;
  /** Contents of the project instructions file, already read from disk. */
  instructions?: string;
  /** Absolute paths of bound knowledge files/folders that exist. */
  knowledgePaths: readonly string[];
}

/**
 * Render the shared project charter.
 *
 * Deterministic: identical manifest + instructions produce identical bytes, which
 * is exactly what the cache-stability guarantee requires.
 */
export function renderProjectCharter(input: CharterInput): string {
  const { manifest } = input;
  const blocks: string[] = [];
  blocks.push(`# Project: ${manifest.name}`);
  blocks.push('');
  blocks.push('You are working inside a coordinated project. Several threads may be working in parallel on different branches of the same repository, so your changes must stay inside your assigned scope and must not revert work you did not make.');
  blocks.push('');

  const memory = renderMemoryPrefix(manifest);
  if (memory.length > 0) {
    blocks.push(memory);
    blocks.push('');
  }

  if (input.instructions !== undefined && input.instructions.trim().length > 0) {
    blocks.push('## Project instructions');
    blocks.push('');
    blocks.push(input.instructions.trim());
    blocks.push('');
  }

  if (input.knowledgePaths.length > 0) {
    blocks.push('## Bound project knowledge');
    blocks.push('');
    blocks.push('Read these before making design decisions. They are the authoritative context for this project:');
    for (const path of input.knowledgePaths) blocks.push(`- \`${path}\``);
    blocks.push('');
  }

  blocks.push('## Working agreement');
  blocks.push('');
  blocks.push('- Work only on your assigned task; do not start unrelated refactors.');
  blocks.push('- Keep the repository buildable: if you break the build, fixing it is part of the task.');
  blocks.push('- Never revert or overwrite changes that another thread made unless the task explicitly requires it.');
  blocks.push('- When you finish, summarize what you changed and what you verified.');
  return blocks.join('\n');
}

/** Per-thread task block, injected as the child's first user message. */
export function renderThreadTask(
  thread: ProjectThreadDescriptor,
  options: {
    /** Absolute checkout path when the thread has its own worktree. */
    worktreePath?: string;
    /** Shared-memory keys this thread must treat as binding. */
    memoryKeys?: readonly string[];
  } = {},
): string {
  const blocks: string[] = [];
  blocks.push(`# Task: ${thread.title}`);
  blocks.push('');
  blocks.push(thread.objective.trim());
  blocks.push('');
  blocks.push('## Your assignment');
  blocks.push('');
  blocks.push(`- thread id: \`${thread.threadId}\``);
  blocks.push(`- isolation: ${thread.branch === undefined ? `scope \`${thread.branchOrScope}\`` : `branch \`${thread.branch}\` from \`${thread.baseCommit ?? 'HEAD'}\``}`);
  if (options.worktreePath !== undefined) {
    blocks.push(`- checkout: \`${options.worktreePath}\` (your own worktree — do not switch branches or touch the main checkout)`);
  }
  if (options.memoryKeys !== undefined && options.memoryKeys.length > 0) {
    blocks.push(`- binding decisions: ${options.memoryKeys.map((key) => `\`${key}\``).join(', ')}`);
  }
  blocks.push('');
  blocks.push('## How to finish');
  blocks.push('');
  blocks.push('1. Implement the task in your scope.');
  blocks.push('2. Run the project\'s own verification (tests, typecheck, lint) for the code you touched.');
  blocks.push('3. Commit the work on your branch with a message that states what changed and why.');
  if (thread.branch !== undefined) {
    blocks.push(`4. Push the branch and open a pull request: \`git push -u origin ${thread.branch}\` then \`gh pr create --head ${thread.branch} --fill\`.`);
    blocks.push('5. Report the pull request URL and the verification you ran.');
  } else {
    blocks.push('4. Report exactly which files you changed and the verification you ran.');
  }
  blocks.push('');
  blocks.push('Do not merge your own pull request. Stop and report if you are blocked on a decision only the user can make.');
  return blocks.join('\n');
}

/** Prompt used when steering a live thread with new shared memory. */
export function renderMemorySteer(delta: string): string {
  return delta.trim();
}

/** Prompt used to ask a thread to answer a user decision. */
export function renderFeedbackAnswer(thread: ProjectThreadDescriptor, answer: string): string {
  const blocks: string[] = [];
  blocks.push('[project] The user answered your blocking question.');
  if (thread.feedbackPrompt !== undefined) {
    blocks.push('');
    blocks.push(`Question: ${thread.feedbackPrompt}`);
  }
  blocks.push('');
  blocks.push(`Answer: ${answer.trim()}`);
  blocks.push('');
  blocks.push('Continue the task with this decision. Do not ask the same question again.');
  return blocks.join('\n');
}
