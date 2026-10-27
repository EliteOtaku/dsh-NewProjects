/**
 * The four model-facing tools.
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
import { renderOverviewMarkdown } from '../core/overview.js';
import type { ContentBlock, HostToolDefinition, HostToolRunContext } from './hostTypes.js';

/** Resolve a project engine and the parent agent a call runs under. */
export interface ToolContextSource {
  /** Engine for a root, or the primary engine when `rootDir` is omitted. */
  engineFor(rootDir: string | undefined): Promise<ProjectEngine>;
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
      'Split one high-level goal into non-blocking tasks and start one durable background thread per task, each bound to its own git branch. Threads keep running after this turn ends. Use for work that can proceed in parallel; use a single task when the steps must be sequential.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'The goal to decompose. Use a bulleted list to control the split; separate lines become separate tasks.' },
        rootDir: { type: 'string', description: 'Project root. Defaults to the current workspace.' },
        limit: { type: 'number', description: 'Maximum threads to start in this call.' },
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
        const engine = await source.engineFor(readString(args, 'rootDir'));
        const limit = readInt(args, 'limit');
        const scopeOnly = readBool(args, 'scopeOnly');
        const branchNamespace = readString(args, 'branchNamespace');
        const result = await engine.coordinate(
          source.parentOf(exec),
          goal,
          {
            ...(limit === undefined ? {} : { limit }),
            ...(scopeOnly === undefined ? {} : { scopeOnly }),
            ...(branchNamespace === undefined ? {} : { branchNamespace }),
          },
          exec.signal,
        );
        return {
          ok: true,
          projectId: result.projectId,
          planned: result.planned,
          started: result.started.map((thread) => ({
            threadId: thread.threadId,
            title: thread.title,
            status: thread.status,
            branch: thread.branch,
            childSessionId: thread.childSessionId,
          })),
          skipped: result.skipped.map((entry) => ({ title: entry.task.title, reason: entry.reason })),
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
        const engine = await source.engineFor(readString(args, 'rootDir'));
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
      'Inspect or intervene in one background thread. `respond` answers a thread that is waiting for a human decision and restarts it; `steer` adds mid-course guidance to a live thread; `retry` resumes a stopped thread on its existing branch; `deliver` commits, pushes, and opens a pull request; `heal` polls CI and review comments and fixes them.',
    parameters: {
      type: 'object',
      properties: {
        rootDir: { type: 'string', description: 'Project root. Defaults to the current workspace.' },
        threadId: { type: 'string', description: 'Target thread id. Omit to list every thread.' },
        action: {
          type: 'string',
          enum: ['list', 'inspect', 'steer', 'respond', 'retry', 'interrupt', 'close', 'deliver', 'heal'],
          description: 'What to do. Defaults to list.',
        },
        message: { type: 'string', description: 'The message for steer/respond, or the PR body/title text for deliver.' },
      },
      additionalProperties: false,
    },
    output: OBJECT_OUTPUT,
    async execute(args: unknown, exec: HostToolRunContext): Promise<unknown> {
      try {
        const engine = await source.engineFor(readString(args, 'rootDir'));
        const action = readString(args, 'action') ?? 'list';
        const threadId = readString(args, 'threadId');
        const message = readString(args, 'message');

        if (action === 'list') {
          const threads = await engine.listThreads();
          return { ok: true, threads: threads.map((thread) => ({ ...thread, summary: describeThread(thread) })) };
        }
        if (action === 'heal') {
          const sweep = await engine.healSweep(source.parentOf(exec), exec.signal);
          return { ok: true, ...sweep };
        }
        if (threadId === undefined) {
          return { ok: false, code: 'INVALID_INPUT', message: `action "${action}" requires threadId` };
        }
        if (action === 'deliver') {
          const delivered = await engine.deliverThread(threadId, message === undefined ? {} : { body: message });
          return { ok: true, prRef: delivered.prRef, message: delivered.message, thread: delivered.thread };
        }
        if (action === 'inspect' || action === 'steer' || action === 'respond' || action === 'retry' || action === 'interrupt' || action === 'close') {
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
      'Return the project overview: completed threads, pull requests awaiting review, threads waiting for a human decision, threads running or self-healing, and how many of the daily thread quota are used.',
    parameters: {
      type: 'object',
      properties: {
        rootDir: { type: 'string', description: 'Project root. Defaults to the current workspace.' },
        markdown: { type: 'boolean', description: 'Also return a rendered Markdown summary.' },
      },
      additionalProperties: false,
    },
    output: OBJECT_OUTPUT,
    async execute(args: unknown, exec: HostToolRunContext): Promise<unknown> {
      void exec;
      try {
        const engine = await source.engineFor(readString(args, 'rootDir'));
        const json = await engine.overviewJson();
        if (readBool(args, 'markdown') === true) {
          const structured = await engine.overview();
          return { ok: true, ...json, markdown: renderOverviewMarkdown(structured) };
        }
        return { ok: true, ...json };
      } catch (error) {
        return asToolResult(error);
      }
    },
  };

  return [coordinate, memory, manage, overview];
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
