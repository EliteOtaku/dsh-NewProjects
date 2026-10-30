/**
 * The model-facing tools.
 *
 * Every tool resolves its project from an explicit `rootDir` argument, falling back to
 * the session's primary workspace. That keeps a single plugin usable across several
 * workspaces without pretending the Host gives us one global "current project".
 *
 * Output policy: each tool returns compact JSON and renders it as a single text block.
 * No tool throws for an expected state (`not initialised`, `no threads yet`); it returns
 * a normal result the model can act on, because a thrown error would end the turn.
 */

import type { ProjectEngine } from '../core/engine.js';
import { describeThread } from '../core/engine.js';
import { isProjectError, ProjectError, describeError } from '../core/errors.js';
import { describeKnowledge, renderHits } from '../core/knowledge.js';
import { renderOverviewMarkdown } from '../core/overview.js';
import type { ContentBlock, HostAgent, HostToolDefinition, HostToolRunContext } from './hostTypes.js';

/** Resolve a project engine and the parent agent a call runs under. */
export interface ToolContextSource {
  /**
   * Engine for a root, or the calling session's own directory when `rootDir` is omitted.
   *
   * The agent is part of the request because the Host resolves a session's directory per
   * session (`workingDirectory.ensure`); a tool that never said which session it runs as
   * could only fall back to the deployment directory, which is shared by every session.
   */
  engineFor(agent: HostAgent | undefined, rootDir: string | undefined): Promise<ProjectEngine>;
  /** The agent this call runs as, which owns any thread it starts. */
  parentOf(exec: HostToolRunContext): object;
}

/** Render a JSON value as one text block. */
function text(value: unknown): ContentBlock[] {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

/** The shared `{ type: 'object' }` schema used by every tool's output. */
const OBJECT_OUTPUT = {
  schema: { type: 'object' as const, additionalProperties: true },
  render: (_args: unknown, value: unknown): ContentBlock[] => text(value),
};

/** Read one string argument, trimmed, or `undefined` when absent/blank. */
function readString(args: unknown, key: string): string | undefined {
  if (args === null || typeof args !== 'object') return undefined;
  const value = (args as Record<string, unknown>)[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** Read one integer argument, or `undefined` when absent/not a number. */
function readInt(args: unknown, key: string): number | undefined {
  if (args === null || typeof args !== 'object') return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

/** Read one boolean argument. */
function readBool(args: unknown, key: string): boolean | undefined {
  if (args === null || typeof args !== 'object') return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'boolean' ? value : undefined;
}

/** Read an array of objects argument. */
function readArray(args: unknown, key: string): Record<string, unknown>[] {
  if (args === null || typeof args !== 'object') return [];
  const value = (args as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object');
}

/** Read a string array argument. */
function readStringArray(args: unknown, key: string): string[] {
  if (args === null || typeof args !== 'object') return [];
  const value = (args as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter((item) => item.length > 0);
}

/** Turn any failure into a model-readable result instead of a thrown turn-ending error. */
export function asToolResult(error: unknown): { ok: false; code: string; message: string; details?: unknown } {
  if (isProjectError(error)) {
    return { ok: false, code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) };
  }
  return { ok: false, code: 'INTERNAL', message: describeError(error) };
}

/** Build the four tool definitions. */
export function buildTools(source: ToolContextSource): HostToolDefinition[] {
  /** `project_coordinate` — split a goal and start parallel threads. */
  const coordinate: HostToolDefinition = {
    name: 'project_coordinate',
    description:
      'Split one high-level goal into non-blocking tasks and start one durable background thread per task, each bound to its own git branch. Threads keep running after this turn ends. Use for work that can proceed in parallel; use a single task when the steps must be sequential.\n\nALWAYS pass `tasks` yourself: you are the coordinator, so deciding the split is your judgement, not a text-parsing job. If you omit `tasks`, the goal is split by its bullet markers as a fallback and the result says so — and because that split is a guess, it is then proposed instead of started (see `planOnly`).',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'The goal being decomposed, in the user\'s words. Recorded with the plan and shown to every thread.' },
        tasks: {
          type: 'array',
          description: 'Your decomposition. Preferred over the fallback split. One thread starts per entry; order is preserved.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Short imperative title, used for the branch name.' },
              objective: { type: 'string', description: 'Complete, self-contained instruction for that thread — it does not see this conversation.' },
              scopeHint: { type: 'string', description: 'Optional path when the task is isolated by scope instead of a branch.' },
            },
            required: ['title', 'objective'],
            additionalProperties: false,
          },
        },
        planOnly: {
          type: 'boolean',
          description: 'Propose the threads instead of starting them. Defaults to true when `tasks` is omitted, because a bullet-split is a guess that otherwise costs one branch, worktree and session per line.',
        },
        rootDir: { type: 'string', description: 'Project root. Defaults to the current workspace.' },
        limit: {
          type: 'number',
          description:
            "Start at most this many threads in this call. Omit it to follow the project's concurrency preference (`/project concurrent`), which is a preference rather than a cap: a round still starts at least one thread, and the result reports `concurrency` and any `deferred` tasks. A value here can only narrow the round, never widen it past the preference.",
        },
        scopeOnly: { type: 'boolean', description: 'Isolate by scope only, without creating git branches.' },
        branchNamespace: { type: 'string', description: 'Branch name prefix, defaulting to the project slug.' },
      },
      required: ['goal'],
      additionalProperties: false,
    },
    output: OBJECT_OUTPUT,
    async execute(args: unknown, exec: HostToolRunContext): Promise<unknown> {
      try {
        const goal = readString(args, 'goal');
        if (goal === undefined) return { ok: false, code: 'INVALID_INPUT', message: 'goal is required' };
        const engine = await source.engineFor(exec.agent, readString(args, 'rootDir'));
        const limit = readInt(args, 'limit');
        const scopeOnly = readBool(args, 'scopeOnly');
        const branchNamespace = readString(args, 'branchNamespace');
        const planOnly = readBool(args, 'planOnly');
        const result = await engine.coordinate(
          source.parentOf(exec),
          goal,
          {
            ...(limit === undefined ? {} : { limit }),
            ...(scopeOnly === undefined ? {} : { scopeOnly }),
            ...(branchNamespace === undefined ? {} : { branchNamespace }),
            ...(planOnly === undefined ? {} : { planOnly }),
            tasks: readArray(args, 'tasks'),
          },
          exec.signal,
        );
        return {
          ok: true,
          projectId: result.projectId,
          planned: result.planned,
          planOnly: result.planOnly,
          planOrigin: result.planOrigin,
          ...(result.planNote === undefined ? {} : { planNote: result.planNote }),
          started: result.started.map((thread) => ({
            threadId: thread.threadId,
            title: thread.title,
            status: thread.status,
            branch: thread.branch,
            childSessionId: thread.childSessionId,
          })),
          skipped: result.skipped.map((entry) => ({ title: entry.task.title, reason: entry.reason })),
          ...(result.planOnly
            ? {
                suggested: result.suggested,
                next: 'Nothing was started. Show the user these titles, then start them with project_thread_manage action "start" (optionally with indices) once they agree.',
              }
            : {}),
          quota: result.quota,
        };
      } catch (error) {
        return asToolResult(error);
      }
    },
  };

  /** `project_memory_sync` — read or write the shared decision store. */
  const memory: HostToolDefinition = {
    name: 'project_memory_sync',
    description:
      "Read or write the project's shared memory of global decisions. A write is pushed to every live thread immediately and included in every thread started later, so this is how a decision reaches threads that are already running. Keep entries short and durable; do not store task progress here.",
    parameters: {
      type: 'object',
      properties: {
        rootDir: { type: 'string', description: 'Project root. Defaults to the current workspace.' },
        set: {
          type: 'array',
          description: 'Decisions to create or replace.',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', description: 'Stable identifier, e.g. "http-error-format".' },
              decision: { type: 'string', description: 'The rule every thread must follow.' },
              rationale: { type: 'string', description: 'Why, so a thread can judge an edge case.' },
            },
            required: ['key', 'decision'],
            additionalProperties: false,
          },
        },
        remove: { type: 'array', description: 'Keys to delete.', items: { type: 'string' } },
        list: { type: 'boolean', description: 'Return the current entries. Implied when nothing is written.' },
      },
      additionalProperties: false,
    },
    output: OBJECT_OUTPUT,
    async execute(args: unknown, exec: HostToolRunContext): Promise<unknown> {
      try {
        const engine = await source.engineFor(exec.agent, readString(args, 'rootDir'));
        const parent = source.parentOf(exec);
        const writes = readArray(args, 'set');
        const removals = readStringArray(args, 'remove');
        const written: Array<{ key: string; revision: number; deliveredTo: string[]; skipped: string[] }> = [];
        for (const entry of writes) {
          const key = typeof entry.key === 'string' ? entry.key.trim() : '';
          const decision = typeof entry.decision === 'string' ? entry.decision.trim() : '';
          if (key.length === 0 || decision.length === 0) continue;
          const rationale = typeof entry.rationale === 'string' ? entry.rationale.trim() : undefined;
          const outcome = await engine.setMemory(parent, {
            key,
            decision,
            ...(rationale === undefined || rationale.length === 0 ? {} : { rationale }),
          });
          written.push({
            key: outcome.entry.key,
            revision: outcome.entry.revision,
            deliveredTo: outcome.broadcast.delivered,
            skipped: outcome.broadcast.skipped.map((item) => item.threadId),
          });
        }
        const removed: string[] = [];
        for (const key of removals) {
          const outcome = await engine.removeMemory(parent, key);
          if (outcome.removed) removed.push(key);
        }
        const entries = await engine.listMemory();
        return {
          ok: true,
          written,
          removed,
          entries: entries.map((entry) => ({
            key: entry.key,
            decision: entry.decision,
            rationale: entry.rationale,
            revision: entry.revision,
            author: entry.authorThreadId,
          })),
        };
      } catch (error) {
        return asToolResult(error);
      }
    },
  };

  /** `project_thread_manage` — inspect, steer, answer, retry, interrupt, deliver. */
  const manage: HostToolDefinition = {
    name: 'project_thread_manage',
    description:
      'Inspect or intervene in one background thread. `respond` answers a thread that is waiting for a human decision and restarts it; `steer` adds mid-course guidance to a live thread; `retry` resumes a stopped thread on its existing branch; `deliver` commits, pushes, and opens a pull request; `heal` polls CI and review comments and fixes them; `unwatch` stops polling a thread for CI and review state while keeping its branch, pull request, and record; `watch` resumes that polling; `approve` records a human sign-off for one gated action (`push`, `pr`, `merge`, `force-push`) in projects configured to require it. `start` launches threads from the proposed plan (all of them, or the 1-based `indices` given); `drop` discards that plan.',
    parameters: {
      type: 'object',
      properties: {
        rootDir: { type: 'string', description: 'Project root. Defaults to the current workspace.' },
        threadId: { type: 'string', description: 'Target thread id. Omit to list every thread.' },
        action: {
          type: 'string',
          enum: [
            'list',
            'inspect',
            'steer',
            'respond',
            'retry',
            'interrupt',
            'close',
            'reopen',
            'deliver',
            'heal',
            'start',
            'drop',
            'watch',
            'unwatch',
            'merge',
            'conflicts',
            'review',
            'approve',
          ],
          description: 'What to do. Defaults to list.',
        },
        message: { type: 'string', description: 'The message for steer/respond, or the PR body/title text for deliver.' },
        approval: {
          type: 'string',
          enum: ['push', 'pr', 'merge', 'force-push'],
          description: 'For action "approve": the gated action you are signing off on.',
        },
        indices: {
          type: 'array',
          description: 'For action "start": 1-based positions from the proposed plan. Omit to start all of them.',
          items: { type: 'number' },
        },
      },
      additionalProperties: false,
    },
    output: OBJECT_OUTPUT,
    async execute(args: unknown, exec: HostToolRunContext): Promise<unknown> {
      try {
        const engine = await source.engineFor(exec.agent, readString(args, 'rootDir'));
        const action = readString(args, 'action') ?? 'list';
        const threadId = readString(args, 'threadId');
        const message = readString(args, 'message');
        const approval = readString(args, 'approval');

        if (action === 'list') {
          const threads = await engine.listThreads();
          const pending = await engine.pendingPlan();
          return {
            ok: true,
            threads: threads.map((thread) => ({ ...thread, summary: describeThread(thread) })),
            suggested: pending.plan?.tasks ?? [],
            suggestedExpired: pending.expired,
          };
        }
        if (action === 'heal') {
          const sweep = await engine.healSweep(source.parentOf(exec), exec.signal);
          return { ok: true, ...sweep };
        }
        if (action === 'start') {
          const indices = readArray(args, 'indices')
            .map((value) => (typeof value === 'number' ? value : Number.parseInt(String(value), 10)))
            .filter((value) => Number.isInteger(value));
          const result = await engine.startSuggested(
            source.parentOf(exec),
            indices.length === 0 ? {} : { indices },
            exec.signal,
          );
          return {
            ok: true,
            started: result.started.map((thread) => ({
              threadId: thread.threadId,
              title: thread.title,
              status: thread.status,
              branch: thread.branch,
            })),
            skipped: result.skipped.map((entry) => ({ title: entry.task.title, reason: entry.reason })),
            remaining: result.remaining,
            quota: result.quota,
          };
        }
        if (action === 'drop') {
          const dropped = await engine.discardSuggested();
          return { ok: true, discarded: dropped.discarded };
        }
        if (threadId === undefined) {
          return { ok: false, code: 'INVALID_INPUT', message: `action "${action}" requires threadId` };
        }
        if (action === 'deliver') {
          const delivered = await engine.deliverThread(threadId, message === undefined ? {} : { body: message });
          return { ok: true, prRef: delivered.prRef, message: delivered.message, thread: delivered.thread };
        }
        if (action === 'approve') {
          if (threadId === undefined) {
            return { ok: false, code: 'INVALID_INPUT', message: 'approve needs a threadId' };
          }
          if (
            approval !== 'push' &&
            approval !== 'pr' &&
            approval !== 'merge' &&
            approval !== 'force-push'
          ) {
            return {
              ok: false,
              code: 'INVALID_INPUT',
              message: 'approve needs an approval action: push, pr, merge, or force-push',
            };
          }
          const approved = await engine.approve(threadId, approval);
          return { ok: true, message: `approved ${approval} for ${threadId}`, thread: approved };
        }
        if (
          action === 'inspect' ||
          action === 'steer' ||
          action === 'respond' ||
          action === 'retry' ||
          action === 'interrupt' ||
          action === 'close' ||
          action === 'reopen' ||
          action === 'watch' ||
          action === 'unwatch' ||
          action === 'merge' ||
          action === 'conflicts' ||
          action === 'review'
        ) {
          const outcome = await engine.manageThread(source.parentOf(exec), threadId, action, message, exec.signal);
          return { ok: true, message: outcome.message, thread: outcome.thread };
        }
        return { ok: false, code: 'INVALID_INPUT', message: `unknown action "${action}"` };
      } catch (error) {
        return asToolResult(error);
      }
    },
  };

  /** `project_overview` — the four buckets plus quota. */
  const overview: HostToolDefinition = {
    name: 'project_overview',
    description:
      'Return the project overview: completed threads, pull requests awaiting review, threads waiting for a human decision, threads running or self-healing, and how many of the daily thread quota are used. Includes any decomposition that was proposed but not started.',
    parameters: {
      type: 'object',
      properties: {
        rootDir: { type: 'string', description: 'Project root. Defaults to the current workspace.' },
        markdown: { type: 'boolean', description: 'Also return a rendered Markdown summary.' },
        includeResolved: {
          type: 'boolean',
          description: 'Also list threads that are resolved. They are hidden by default.',
        },
        usage: {
          type: 'boolean',
          description:
            'Also return token spend per thread and per model. Costs one read of each thread session log, so it is off by default.',
        },
      },
      additionalProperties: false,
    },
    output: OBJECT_OUTPUT,
    async execute(args: unknown, exec: HostToolRunContext): Promise<unknown> {
      void exec;
      try {
        const engine = await source.engineFor(exec.agent, readString(args, 'rootDir'));
        const includeResolved = readBool(args, 'includeResolved') === true;
        const includeUsage = readBool(args, 'usage') === true;
        const json = await engine.overviewJson({ includeResolved, includeUsage });
        if (readBool(args, 'markdown') === true) {
          const structured = await engine.overview([], { includeResolved });
          return { ok: true, ...json, markdown: renderOverviewMarkdown(structured) };
        }
        return { ok: true, ...json };
      } catch (error) {
        return asToolResult(error);
      }
    },
  };


  /**
   * `project_knowledge_search` — ranked entry point into the bound documents.
   *
   * A convenience, not the mechanism: the charter lists every document and a thread can read
   * any of them directly. This tool exists for the case where the thread does not yet know
   * which file to open, and its hits cite `path:line` so the next step is a file read.
   */
  const knowledgeSearch: HostToolDefinition = {
    name: 'project_knowledge_search',
    description:
      'Search the project knowledge base and return the most relevant passages, each cited as path:line. Use it when you do not know which of the documents listed in the project charter answers your question; then read that file, which is authoritative over this index.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to find. Use meaning-bearing words, not just a file name.' },
        limit: { type: 'integer', description: 'Maximum passages to return (1-20, default 5).' },
        rootDir: { type: 'string', description: 'Project root. Defaults to the current workspace.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: OBJECT_OUTPUT,
    async execute(args: unknown, exec: HostToolRunContext): Promise<unknown> {
      try {
        const engine = await source.engineFor(exec.agent, readString(args, 'rootDir'));
        // A search does not mutate anything, but honouring the cancellation signal keeps a
        // cancelled turn from finishing a scan of a large index for no reader.
        if (exec.signal.aborted) return asToolResult(new Error('the turn was cancelled'));
        const query = readString(args, 'query');
        if (query === undefined || query.trim().length === 0) {
          return { ok: false, code: 'INVALID_INPUT', message: 'query must not be empty' };
        }
        const limit = readInt(args, 'limit');
        const result = await engine.searchProjectKnowledge(query, limit === undefined ? {} : { limit });
        return {
          ok: true,
          query,
          root: result.rootDir,
          hits: result.hits,
          text: renderHits(result.hits),
          hint: `Cited paths are relative to the project root \`${result.rootDir}\`, not to your working directory — your checkout is a worktree that holds only what was committed when your branch was cut. Open the cited file under the project root for its current contents; the index is rebuilt automatically before each search, so a hit cites the file as it was for this query. To find a file without a keyword, call \`project_knowledge\` with action "tree", then action "read".`,
        };
      } catch (error) {
        return asToolResult(error);
      }
    },
  };

  /** `project_knowledge` — bind, browse, list, rebuild, or drop the knowledge base. */
  const knowledgeManage: HostToolDefinition = {
    name: 'project_knowledge',
    description:
      'Work with the project knowledge base: `list` what is indexed, `tree` a directory and `read` a line window of any file under the project root, `add` or `remove` bound files/folders, or force a `rebuild` (rarely needed — searching rebuilds by itself once the bound files change). Bound knowledge is a folder on disk, so `tree` and `read` reach files that a search never pointed at; the file itself is authoritative.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'add', 'remove', 'rebuild', 'tree', 'read'],
          description: 'list (default), add, remove, rebuild, tree, or read.',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files or folders to add/remove, relative to the project root or absolute.',
        },
        path: {
          type: 'string',
          description: 'For tree and read: a file or folder relative to the project root. Defaults to the root for tree.',
        },
        depth: { type: 'integer', description: 'tree only: directory levels to expand (1-4, default 2).' },
        limit: { type: 'integer', description: 'tree only: maximum entries to return (1-500, default 200).' },
        from: { type: 'integer', description: 'read only: first line to return, 1-based (default 1).' },
        lines: { type: 'integer', description: 'read only: how many lines to return (1-2000, default 200).' },
        rootDir: { type: 'string', description: 'Project root. Defaults to the current workspace.' },
      },
      additionalProperties: false,
    },
    output: OBJECT_OUTPUT,
    async execute(args: unknown, exec: HostToolRunContext): Promise<unknown> {
      try {
        const engine = await source.engineFor(exec.agent, readString(args, 'rootDir'));
        await requireInit(engine);
        const action = readString(args, 'action') ?? 'list';
        const paths = readStringArray(args, 'paths');

        if (action === 'list') {
          const { state } = await engine.knowledgeState();
          const manifest = await engine.requireManifest();
          return {
            ok: true,
            paths: manifest.knowledgePaths,
            state,
            summary: describeKnowledge(state),
          };
        }
        if (action === 'add') {
          if (paths.length === 0) {
            return { ok: false, code: 'INVALID_INPUT', message: 'add needs at least one path' };
          }
          const result = await engine.addKnowledgePaths(paths);
          return { ok: true, added: result.added, state: result.state, summary: describeKnowledge(result.state) };
        }
        if (action === 'remove') {
          if (paths.length === 0) {
            return { ok: false, code: 'INVALID_INPUT', message: 'remove needs at least one path' };
          }
          const result = await engine.removeKnowledgePaths(paths);
          return { ok: true, removed: result.removed, state: result.state, summary: describeKnowledge(result.state) };
        }
        if (action === 'rebuild') {
          const state = await engine.buildKnowledge({ signal: exec.signal });
          return { ok: true, state, summary: describeKnowledge(state) };
        }
        if (action === 'tree') {
          const target = readString(args, 'path');
          const depth = readInt(args, 'depth');
          const limit = readInt(args, 'limit');
          const tree = await engine.knowledgeTree({
            ...(target === undefined ? {} : { path: target }),
            ...(depth === undefined ? {} : { depth }),
            ...(limit === undefined ? {} : { limit }),
          });
          const manifest = await engine.requireManifest();
          return {
            ok: true,
            ...tree,
            // A cut tree that does not say it was cut reads as the complete picture, and the
            // model stops looking. State the limit in the result, not only in the docs.
            hint: tree.truncated
              ? `Incomplete: ${tree.note}. The entries above are real, but do not assume the tree is complete.`
              : `Paths are relative to the project root \`${manifest.rootDir}\`; pass one to action "read" for its contents.`,
          };
        }
        if (action === 'read') {
          const target = readString(args, 'path');
          if (target === undefined) {
            return { ok: false, code: 'INVALID_INPUT', message: 'read needs a path' };
          }
          const from = readInt(args, 'from');
          const lines = readInt(args, 'lines');
          const slice = await engine.knowledgeRead({
            path: target,
            ...(from === undefined ? {} : { from }),
            ...(lines === undefined ? {} : { lines }),
          });
          return {
            ok: true,
            ...slice,
            hint: slice.truncated
              ? `Lines ${slice.from}-${slice.to} of ${slice.totalLines}; call again with from: ${slice.to + 1} for the rest.`
              : `All ${slice.totalLines} line(s) of \`${slice.path}\` are in this result.`,
          };
        }
        return { ok: false, code: 'INVALID_INPUT', message: `unknown action "${action}"` };
      } catch (error) {
        return asToolResult(error);
      }
    },
  };

  /**
   * `project_library` — what the threads produced, and the bytes of one item.
   *
   * The list is metadata: it survives the worktree being reclaimed, so it can answer "what did
   * this project produce" long after the bytes are gone. `read` therefore reports a missing file
   * as missing rather than returning an empty body.
   */
  const library: HostToolDefinition = {
    name: 'project_library',
    description:
      'List the files the project threads produced, or read one of them. Paths are relative to the project root; the bytes come from the producing thread\'s worktree and may be gone if it was reclaimed.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'read'],
          description: 'list (default) or read one file.',
        },
        path: { type: 'string', description: 'File to read, as listed by `list`.' },
        threadId: {
          type: 'string',
          description: 'Read from this thread\'s worktree instead of whichever thread touched the path last.',
        },
        rootDir: { type: 'string', description: 'Project root. Defaults to the current workspace.' },
      },
      additionalProperties: false,
    },
    output: OBJECT_OUTPUT,
    async execute(args: unknown, exec: HostToolRunContext): Promise<unknown> {
      try {
        const engine = await source.engineFor(exec.agent, readString(args, 'rootDir'));
        await requireInit(engine);
        const action = readString(args, 'action') ?? 'list';

        if (action === 'list') {
          const files = await engine.library();
          return {
            ok: true,
            files,
            total: files.length,
            ...(files.length === 0
              ? { hint: 'no thread has delivered yet; files appear once a thread commits or opens a pull request' }
              : {}),
          };
        }
        if (action === 'read') {
          const path = readString(args, 'path');
          if (path === undefined || path.trim().length === 0) {
            return { ok: false, code: 'INVALID_INPUT', message: 'read needs a path' };
          }
          if (exec.signal.aborted) return { ok: false, code: 'ABORTED', message: 'cancelled' };
          const result = await engine.readOutputFile(path, readString(args, 'threadId'));
          return result.ok
            ? { ok: true, path: result.path, source: result.source, text: result.text, truncated: result.truncated }
            : { ok: false, code: 'NOT_READABLE', path: result.path, message: result.reason };
        }
        return { ok: false, code: 'INVALID_INPUT', message: `unknown action "${action}"` };
      } catch (error) {
        return asToolResult(error);
      }
    },
  };

  return [coordinate, memory, manage, overview, knowledgeSearch, knowledgeManage, library];
}

/** Throw the standard uninitialised error, used by command handlers. */
export function requireInit(engine: ProjectEngine): Promise<void> {
  return engine.isInitialised().then((ready) => {
    if (!ready) {
      throw new ProjectError(
        'PROJECT_NOT_INITIALIZED',
        `no project at ${engine.rootDir}; run \`/project init\` first`,
      );
    }
  });
}
