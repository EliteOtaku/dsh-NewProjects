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
import {
  emptyIndex,
  renderKnowledgeIndexSection,
  resolveKnowledgeState,
  type KnowledgeIndex,
  type KnowledgeState,
} from './knowledge.js';
import type { ApprovalAction, ProjectManifest, ProjectThreadDescriptor } from '../types.js';

/**
 * Budget for project instructions, in characters.
 *
 * The one figure Projects documents for standing prompt text: instructions are "Text sent to
 * each new thread and to Claude in the project conversation, up to 16,000 characters". It is
 * enforced as a *warning*, never a truncation — silently dropping the tail of a user's brief
 * would replace one quiet failure (stale knowledge) with another, which is the opposite of
 * what this batch is for.
 */
export const MAX_INSTRUCTIONS_CHARS = 16_000;

/** Whether `instructions` exceeds the documented budget, and by how much. */
export function instructionsOverBudget(instructions: string | undefined): number {
  if (instructions === undefined) return 0;
  return Math.max(0, instructions.trim().length - MAX_INSTRUCTIONS_CHARS);
}

/** Read-only facts the charter needs about the project. */
export interface CharterInput {
  manifest: ProjectManifest;
  /** Contents of the project instructions file, already read from disk. */
  instructions?: string;
  /** Absolute paths of bound knowledge files/folders that exist. */
  knowledgePaths: readonly string[];
  /**
   * The built knowledge index, when one exists.
   *
   * Supplies the catalogue the charter lists — document paths and sizes, never bodies.
   * Absent means "never indexed", which is not the same as "no knowledge": the bound paths
   * are still listed so a thread can read them by hand.
   */
  knowledge?: { index: KnowledgeIndex; state: KnowledgeState };
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

  // Paths-first: the charter carries the catalogue, the thread reads the bodies off disk.
  // Nothing here varies with the model's context window, because no document body is in the
  // prefix at all — which is also why a file edited after the last rebuild cannot produce a
  // stale answer.
  const knowledge = renderKnowledge(input);
  if (knowledge.length > 0) {
    blocks.push(knowledge);
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

/**
 * The knowledge block, or an empty string when the project has no knowledge bound.
 *
 * An index, when one was built, is strictly better than the bare path list: it tells the
 * thread which documents exist and how large each is, so choosing what to read is one
 * decision instead of a directory walk. The bare list is the fallback for "bound but never
 * indexed", which is not the same as "no knowledge".
 */
function renderKnowledge(input: CharterInput): string {
  // One renderer for both cases, so "bound but never indexed" and "indexed but empty" cannot
  // drift into two differently worded sections saying the same thing.
  const index = input.knowledge?.index ?? emptyIndex(input.knowledgePaths);
  const state = input.knowledge?.state ?? resolveKnowledgeState(index);
  return renderKnowledgeIndexSection(index, state, {
    boundPaths: input.knowledgePaths,
    rootDir: input.manifest.rootDir,
  });
}

/** Per-thread task block, injected as the child's first user message. */
export function renderThreadTask(
  thread: ProjectThreadDescriptor,
  options: {
    /** Absolute checkout path when the thread has its own worktree. */
    worktreePath?: string;
    /** Shared-memory keys this thread must treat as binding. */
    memoryKeys?: readonly string[];
    /**
     * Actions this project wants a human to sign off on.
     *
     * When a publishing action is in the list the finish instructions change shape: the thread
     * must stop *before* it and say what it needs, because nothing inside a subagent can block
     * on a human.
     */
    approvals?: readonly ApprovalAction[];
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
    // Explicit permission to read from outside the checkout, because the charter tells the
    // thread to do exactly that for project knowledge. Without this line "do not touch the main
    // checkout" reads as a prohibition and a careful thread will skip the knowledge instead of
    // reading it.
    blocks.push(`- checkout: \`${options.worktreePath}\` (your own worktree — do not switch branches or change the main checkout. Reading project knowledge from the project root named in the project charter is expected; writing to it is not.)`);
  }
  if (options.memoryKeys !== undefined && options.memoryKeys.length > 0) {
    blocks.push(`- binding decisions: ${options.memoryKeys.map((key) => `\`${key}\``).join(', ')}`);
  }
  blocks.push('');
  const gated = options.approvals ?? [];
  const gatedPush = gated.includes('push') || gated.includes('pr');
  blocks.push('## How to finish');
  blocks.push('');
  blocks.push('1. Implement the task in your scope.');
  blocks.push('2. Run the project verification (tests, typecheck, lint) for the code you touched.');
  blocks.push('3. Commit the work on your branch with a message that states what changed and why.');
  if (thread.branch !== undefined && gatedPush) {
    // Nothing inside a subagent can block on a human, so the gate has to be a stop: the thread
    // ends its turn with the request and the coordinator asks the user. Telling it to "wait for
    // approval" without a place to wait would just make it push anyway.
    blocks.push(`4. **Stop before publishing.** This project asks for sign-off, so do not run \`git push\` or \`gh pr create\`. End your turn with the commit hash, the verification you ran, and one line: approve push and open a PR for ${thread.branch}.`);
    blocks.push('5. If you are sent an approval message, then push and open the pull request and report its URL.');
  } else if (thread.branch !== undefined) {
    blocks.push(`4. Push the branch and open a pull request: \`git push -u origin ${thread.branch}\` then \`gh pr create --head ${thread.branch} --fill\`.`);
    blocks.push('5. Report the pull request URL and the verification you ran.');
  } else {
    blocks.push('4. Report exactly which files you changed and the verification you ran.');
  }
  blocks.push('');
  // OFFICIAL: "Don't merge, force-push, or change CI configuration without asking me in the
  // thread." A first-turn thread faces the same three temptations as a healing one: rewriting
  // the branch to escape a rebase, and editing the workflow instead of the code failing it.
  blocks.push('Do not force-push: reviewers may already be reading this branch.');
  blocks.push("Do not change CI configuration (workflow files, which checks run, or a check's threshold) to make a check pass.");
  blocks.push('Do not merge your own pull request. Stop and report if you are blocked on a decision only the user can make.');
  return blocks.join('\n');
}

/** Prompt used when steering a live thread with new shared memory. */
export function renderMemorySteer(delta: string): string {
  return delta.trim();
}

/** Prompt used to ask a thread to answer a user decision. */
/**
 * Ask the thread to merge its own pull request.
 *
 * The Host never runs `gh pr merge` itself. The thread is the only party that knows its
 * branch state, whether it needs a rebase first, and what to clean up afterwards — a host
 * that merged behind its back would report success on a branch the thread still thinks is
 * unmerged.
 */
export function renderMergeRequest(thread: ProjectThreadDescriptor, options: { prUrl?: string } = {}): string {
  const target = options.prUrl ?? thread.prOrDeliverableRef ?? 'your pull request';
  const blocks: string[] = [];
  blocks.push(`[project] The user asked you to merge ${target}.`);
  blocks.push('');
  blocks.push('## What to do');
  blocks.push('1. Confirm the pull request is mergeable right now: checks green, no merge conflicts, and review requirements met. If it is not, fix or say what is missing — do not force a merge.');
  blocks.push('2. If the branch is behind its base branch, update it first (rebase or merge, your call) and re-run the checks.');
  blocks.push('3. Merge the pull request yourself.');
  blocks.push('4. Report the merge commit and anything that needs cleaning up (stale branch, follow-up work).');
  blocks.push('');
  blocks.push('Do not force-push and do not change CI configuration to get the merge through.');
  return blocks.join('\n');
}

/**
 * Ask the thread to resolve conflicts with its base branch.
 *
 * The file list is a list of *candidates*: files both sides touched since they diverged. Git
 * only knows the real conflicts once it tries the merge, so the prompt says so instead of
 * implying these files definitely conflict.
 */
export function renderConflictRequest(
  thread: ProjectThreadDescriptor,
  options: { base: string; files: string[]; prUrl?: string },
): string {
  const target = options.prUrl ?? thread.prOrDeliverableRef ?? 'your pull request';
  const blocks: string[] = [];
  blocks.push(`[project] The user asked you to resolve conflicts between ${target} and \`${options.base}\`.`);
  blocks.push('');
  blocks.push(`Merge \`${options.base}\` into your branch, resolve every conflict, re-run the tests, then push.`);
  if (options.files.length > 0) {
    blocks.push('');
    blocks.push('## Files both sides touched since they diverged');
    blocks.push('These are the likely conflict sites. Git decides the real ones when it tries the merge:');
    for (const file of options.files) blocks.push(`- ${file}`);
  }
  blocks.push('');
  blocks.push('## What to do');
  blocks.push('1. Bring `' + options.base + '` into your branch.');
  blocks.push('2. Resolve each conflict so that both intents survive. Deleting the other side to make the merge go through is not a resolution.');
  blocks.push('3. Re-run the tests the merge touched, then push.');
  blocks.push('4. If a conflict is a genuine product decision (two incompatible designs), stop and say exactly what needs deciding.');
  blocks.push('');
  blocks.push('Do not force-push and do not merge the pull request yourself.');
  return blocks.join('\n');
}

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
