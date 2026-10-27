/**
 * The `/project` command family.
 *
 * Command handlers do not pass through the model, so every verb here is deterministic and
 * cheap: reading state, rendering the overview, writing a decision. Anything that needs
 * judgement (decomposing a goal) is delegated to the model through a tool instead — the
 * `coordinate` verb exists only as a convenience that reuses the deterministic planner.
 */

import type { ProjectEngine } from '../core/engine.js';
import { describeThread } from '../core/engine.js';
import { describeError, isProjectError } from '../core/errors.js';
import { describeKnowledge } from '../core/knowledge.js';
import { renderOverviewMarkdown } from '../core/overview.js';
import type { HostCommandDefinition, HostCommandDefinition as CommandDef } from './hostTypes.js';

/** Where commands get their engine from. */
export interface CommandContextSource {
  /** Engine for a root, defaulting to the caller's workspace. */
  engineFor(agent: { readonly id: string }, rootDir: string | undefined): Promise<ProjectEngine>;
}

/** The command result shape the Host accepts. */
type Result = { kind: 'success'; text?: string } | { kind: 'error'; text: string };

/** Usage text, also serving as the discovery surface for the whole family. */
export const PROJECT_USAGE = [
  '`/project` verbs:',
  '- `/project` or `/project overview` — the four buckets plus daily quota',
  '- `/project init [name]` — create the project record for this workspace',
  '- `/project deinit` — delete the record; running threads keep running',
  '- `/project memory` — list shared decisions',
  '- `/project memory <key> = <decision>` — write one decision and broadcast it',
  '- `/project memory rm <key>` — delete one decision',
  '- `/project threads` — every thread with its status',
  '- `/project thread <id> [steer|respond|retry|interrupt|close|deliver] <text>` — act on one thread',
  '- `/project knowledge` — what is indexed and whether it is in context or retrieval mode',
  '- `/project knowledge add <path...>` — bind files or folders and reindex',
  '- `/project knowledge rm <path...>` — unbind paths and reindex',
  '- `/project knowledge rebuild` — re-read every bound file and rebuild the index',
  '- `/project heal` — poll CI and review comments once and act on what is found',
  '- `/project coordinate <goal>` — split a goal and start threads (deterministic; prefer the `project_coordinate` tool)',
].join('\n');

/** Split a raw argument line into verb and remainder. */
function splitVerb(raw: string): { verb: string; rest: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { verb: 'overview', rest: '' };
  const spaceAt = trimmed.search(/\s/);
  if (spaceAt < 0) return { verb: trimmed.toLowerCase(), rest: '' };
  return { verb: trimmed.slice(0, spaceAt).toLowerCase(), rest: trimmed.slice(spaceAt + 1).trim() };
}

/** Parse `key = decision` into its two halves. */
function parseAssignment(rest: string): { key: string; decision: string } | undefined {
  const eq = rest.indexOf('=');
  if (eq < 0) return undefined;
  const key = rest.slice(0, eq).trim();
  const decision = rest.slice(eq + 1).trim();
  if (key.length === 0 || decision.length === 0) return undefined;
  return { key, decision };
}

/**
 * The `/project knowledge` verb family.
 *
 * Split out because it needs the engine's knowledge surface rather than the thread surface,
 * and because a rebuild can fail on I/O in ways worth reporting one by one.
 */
async function runKnowledge(engine: ProjectEngine, rest: string): Promise<Result> {
  const trimmed = rest.trim();
  const spaceAt = trimmed.search(/\s/);
  const verb = (spaceAt < 0 ? trimmed : trimmed.slice(0, spaceAt)).toLowerCase();
  const tail = spaceAt < 0 ? '' : trimmed.slice(spaceAt + 1).trim();

  if (verb.length === 0 || verb === 'list') {
    const { state } = await engine.knowledgeState();
    const manifest = await engine.requireManifest();
    const lines = [describeKnowledge(state), ''];
    if (manifest.knowledgePaths.length === 0) {
      lines.push('No bound paths yet. Bind a file or folder with `/project knowledge add <path>`.');
    } else {
      lines.push('Bound paths:');
      for (const path of manifest.knowledgePaths) lines.push(`- \`${path}\``);
    }
    if (state.warnings.length > 0) {
      lines.push('', 'Warnings:');
      for (const warning of state.warnings) lines.push(`- ${warning}`);
    }
    return success(lines.join('\n'));
  }

  if (verb === 'rebuild') {
    const state = await engine.buildKnowledge();
    const lines = [describeKnowledge(state)];
    if (state.warnings.length > 0) {
      lines.push('', 'Warnings:');
      for (const warning of state.warnings) lines.push(`- ${warning}`);
    }
    return success(lines.join('\n'));
  }

  if (verb === 'add' || verb === 'rm' || verb === 'remove') {
    const paths = tail.split(/\s+/).map((part) => part.trim()).filter((part) => part.length > 0);
    if (paths.length === 0) {
      return { kind: 'error', text: `usage: /project knowledge ${verb} <path> [path...]` };
    }
    if (verb === 'add') {
      const result = await engine.addKnowledgePaths(paths);
      const lines = [
        result.added.length === 0
          ? 'Nothing new to add; those paths were already bound.'
          : `Added ${String(result.added.length)} path(s): ${result.added.join(', ')}`,
        describeKnowledge(result.state),
      ];
      if (result.state.warnings.length > 0) {
        lines.push('', 'Warnings:');
        for (const warning of result.state.warnings) lines.push(`- ${warning}`);
      }
      return success(lines.join('\n'));
    }
    const result = await engine.removeKnowledgePaths(paths);
    const lines = [
      result.removed.length === 0
        ? 'None of those paths were bound.'
        : `Removed ${String(result.removed.length)} path(s): ${result.removed.join(', ')}`,
      describeKnowledge(result.state),
    ];
    return success(lines.join('\n'));
  }

  return { kind: 'error', text: `unknown knowledge verb "${verb}"\n${KNOWLEDGE_USAGE}` };
}

/** Usage for the knowledge verb family. */
const KNOWLEDGE_USAGE = [
  '`/project knowledge` verbs:',
  '- `/project knowledge` — what is indexed and which mode it is in',
  '- `/project knowledge add <path...>` — bind and index',
  '- `/project knowledge rm <path...>` — unbind and reindex',
  '- `/project knowledge rebuild` — re-read every bound file',
].join('\n');

/** Build the `/project` command. */
export function buildProjectCommand(source: CommandContextSource): CommandDef {
  return {
    name: 'project',
    description: 'Project overview, shared memory, and background thread control.',
    input: { hint: '[overview|init|memory|threads|thread|heal|coordinate]' },
    async handler(invocation) {
      const { verb, rest } = splitVerb(invocation.rawInput);
      try {
        switch (verb) {
          case 'help':
            return { kind: 'success', text: PROJECT_USAGE };
          case 'init': {
            const engine = await source.engineFor(invocation.agent, undefined);
            const manifest = await engine.init(rest.length === 0 ? {} : { name: rest });
            return {
              kind: 'success',
              text: `initialised project \`${manifest.name}\` (${manifest.projectId}) at ${manifest.rootDir}\nrecord: ${engine.paths.manifestPath}\nnext: \`/project memory <key> = <decision>\` or the \`project_coordinate\` tool`,
            };
          }
          case 'deinit': {
            const engine = await source.engineFor(invocation.agent, undefined);
            await engine.deinit();
            return { kind: 'success', text: 'project record deleted. Threads already running keep running; their descriptors are gone.' };
          }
          case 'overview': {
            const engine = await source.engineFor(invocation.agent, undefined);
            await requireReady(engine);
            return { kind: 'success', text: renderOverviewMarkdown(await engine.overview()) };
          }
          case 'memory': {
            const engine = await source.engineFor(invocation.agent, undefined);
            await requireReady(engine);
            if (rest.startsWith('rm ')) {
              const key = rest.slice(3).trim();
              const outcome = await engine.removeMemory(invocation.agent, key);
              if (!outcome.removed) return { kind: 'error', text: `no shared decision named \`${key}\`` };
              return {
                kind: 'success',
                text: `removed \`${key}\`; notified ${String(outcome.broadcast.delivered.length)} live thread(s)`,
              };
            }
            const assignment = parseAssignment(rest);
            if (assignment !== undefined) {
              const outcome = await engine.setMemory(invocation.agent, { key: assignment.key, decision: assignment.decision });
              const delivered = outcome.broadcast.delivered.length;
              const skipped = outcome.broadcast.skipped.length;
              return {
                kind: 'success',
                text: `stored \`${outcome.entry.key}\` (revision ${String(outcome.entry.revision)}); delivered to ${String(delivered)} live thread(s), ${String(skipped)} not live`,
              };
            }
            const entries = await engine.listMemory();
            if (entries.length === 0) {
              return { kind: 'success', text: 'no shared decisions yet. Write one with `/project memory <key> = <decision>`.' };
            }
            const lines = entries.map(
              (entry) => `- \`${entry.key}\` (r${String(entry.revision)}, by ${entry.authorThreadId}): ${entry.decision}`,
            );
            return { kind: 'success', text: `shared decisions:\n${lines.join('\n')}` };
          }
          case 'threads': {
            const engine = await source.engineFor(invocation.agent, undefined);
            await requireReady(engine);
            const threads = await engine.listThreads();
            if (threads.length === 0) return { kind: 'success', text: 'no threads yet.' };
            return { kind: 'success', text: threads.map((thread) => `- ${describeThread(thread)}`).join('\n') };
          }
          case 'thread': {
            const engine = await source.engineFor(invocation.agent, undefined);
            await requireReady(engine);
            const spaceAt = rest.search(/\s/);
            const threadId = spaceAt < 0 ? rest : rest.slice(0, spaceAt);
            const tail = spaceAt < 0 ? '' : rest.slice(spaceAt + 1).trim();
            if (threadId.length === 0) return { kind: 'error', text: 'usage: `/project thread <id> [action] [text]`' };
            const inner = splitVerb(tail);
            const action = inner.verb === 'overview' || inner.verb.length === 0 ? 'inspect' : inner.verb;
            if (action === 'deliver') {
              const delivered = await engine.deliverThread(threadId, inner.rest.length === 0 ? {} : { body: inner.rest });
              return { kind: 'success', text: delivered.message };
            }
            const outcome = await engine.manageThread(
              invocation.agent,
              threadId,
              action as 'inspect' | 'steer' | 'respond' | 'retry' | 'interrupt' | 'close',
              inner.rest.length === 0 ? undefined : inner.rest,
              invocation.signal,
            );
            return { kind: 'success', text: `${outcome.message}\n${describeThread(outcome.thread)}` };
          }
          case 'knowledge': {
            const engine = await source.engineFor(invocation.agent, undefined);
            await requireReady(engine);
            return await runKnowledge(engine, rest);
          }
          case 'heal': {
            const engine = await source.engineFor(invocation.agent, undefined);
            await requireReady(engine);
            const sweep = await engine.healSweep(invocation.agent, invocation.signal);
            const parts = [
              `observed ${String(sweep.observed)} thread(s)`,
              `healed ${String(sweep.healed.length)}`,
              `escalated ${String(sweep.escalated.length)}`,
              `settled ${String(sweep.settled.length)}`,
              `waiting ${String(sweep.waiting.length)}`,
            ];
            if (sweep.errors.length > 0) {
              parts.push(`errors: ${sweep.errors.map((error) => `${error.threadId}: ${error.message}`).join('; ')}`);
            }
            return { kind: 'success', text: parts.join(', ') };
          }
          case 'coordinate': {
            const engine = await source.engineFor(invocation.agent, undefined);
            await requireReady(engine);
            if (rest.length === 0) return { kind: 'error', text: 'usage: `/project coordinate <goal>`' };
            const result = await engine.coordinate(invocation.agent, rest, {}, invocation.signal);
            const lines = [
              `planned ${String(result.planned.length)}, started ${String(result.started.length)}, skipped ${String(result.skipped.length)}`,
              `quota ${String(result.quota.created)}/${String(result.quota.max)} for ${result.quota.day}`,
            ];
            for (const thread of result.started) {
              lines.push(`- started \`${thread.threadId}\`: ${thread.title}${thread.branch === undefined ? '' : ` on ${thread.branch}`}`);
            }
            for (const entry of result.skipped) lines.push(`- skipped "${entry.task.title}": ${entry.reason}`);
            return { kind: 'success', text: lines.join('\n') };
          }
          default:
            return { kind: 'error', text: `unknown verb "${verb}".\n\n${PROJECT_USAGE}` };
        }
      } catch (error) {
        return { kind: 'error', text: isProjectError(error) ? `${error.code}: ${error.message}` : describeError(error) };
      }
    },
  };
}

/** Reject a verb that needs an existing project record. */
async function requireReady(engine: ProjectEngine): Promise<void> {
  if (await engine.isInitialised()) return;
  throw new Error(`no project at ${engine.rootDir}; run \`/project init\` first`);
}

/** Re-exported so `index.ts` can iterate over every command this plugin adds. */
export type ProjectCommand = CommandDef;

/** Build every command this plugin adds. */
export function buildCommands(source: CommandContextSource): HostCommandDefinition[] {
  return [buildProjectCommand(source)];
}

/** Result helper used by tests to keep the union narrow. */
export function success(text: string): Result {
  return { kind: 'success', text };
}
