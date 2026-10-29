/**
 * The `/project` command family.
 *
 * Command handlers do not pass through the model, so every verb here is deterministic and
 * cheap: reading state, rendering the overview, writing a decision. Anything that needs
 * judgement (decomposing a goal) is delegated to the model through a tool instead — the
 * `coordinate` verb exists only as a convenience that reuses the deterministic planner, and
 * because that split is a guess it proposes threads rather than starting them.
 */
import { describeThread } from '../core/engine.js';
import { describeError, isProjectError } from '../core/errors.js';
import { describeKnowledge } from '../core/knowledge.js';
import { renderOverviewMarkdown } from '../core/overview.js';
import { renderUsageMarkdown } from '../core/usage.js';
const THREAD_VERBS = [
    'inspect',
    'steer',
    'respond',
    'retry',
    'interrupt',
    'close',
    'reopen',
    'watch',
    'unwatch',
    'merge',
    'conflicts',
    'review',
];
/** Usage text, also serving as the discovery surface for the whole family. */
export const PROJECT_USAGE = [
    '`/project` verbs:',
    '- `/project` or `/project overview` — the six buckets plus daily quota',
    '- `/project init [name]` — create the project record for this workspace',
    '- `/project deinit` — delete the record; running threads keep running',
    '- `/project deinit --purge` — also wipe `.dsh-project/` (your PROJECT_INSTRUCTIONS.md is saved first)',
    '- `/project goal` — the one line this project is working toward (and the recent coordinator messages)',
    '- `/project goal <text>` — set the goal; `/project goal clear` forgets it',
    '- `/project memory` — list shared decisions',
    '- `/project memory <key> = <decision>` — write one decision and broadcast it',
    '- `/project memory rm <key>` — delete one decision',
    '- `/project threads [--all]` — every thread with its status (resolved are hidden by default)',
    '- `/project thread <id> [steer|respond|retry|interrupt|close|reopen|deliver|watch|unwatch|merge|conflicts|review] [text]` — act on one thread',
    '- `/project knowledge` — what is indexed and whether it is in context or retrieval mode',
    '- `/project knowledge add <path...>` — bind files or folders and reindex',
    '- `/project knowledge rm <path...>` — unbind paths and reindex',
    '- `/project knowledge rebuild` — re-read every bound file and rebuild the index',
    '- `/project usage` — token spend per thread and per model',
    '- `/project library` — files the threads produced',
    '- `/project library read <path>` — one produced file, read out of its worktree',
    '- `/project heal` — poll CI and review comments once and act on what is found',
    '- `/project pause [reason]` — stop everything: no new threads, no sweeps, no delivery, live threads interrupted',
    '- `/project coordinate <goal>` — split a goal by its bullet markers and *propose* threads (deterministic; the `project_coordinate` tool with `tasks` is the real path)',
    '- `/project start [n...]` — start every proposed thread, or only the listed 1-based ones',
    '- `/project drop` — discard the proposed threads',
    '- `/project resume` — undo a pause; interrupted threads stay resumable',
    '- `/project archive` — stop everything and take the project out of the way',
    '- `/project unarchive` — bring it back; interrupted threads still need a retry or a steer',
].join('\n');
/** Split a raw argument line into verb and remainder. */
function splitVerb(raw) {
    const trimmed = raw.trim();
    if (trimmed.length === 0)
        return { verb: 'overview', rest: '' };
    const spaceAt = trimmed.search(/\s/);
    if (spaceAt < 0)
        return { verb: trimmed.toLowerCase(), rest: '' };
    return { verb: trimmed.slice(0, spaceAt).toLowerCase(), rest: trimmed.slice(spaceAt + 1).trim() };
}
/** Parse `key = decision` into its two halves. */
function parseAssignment(rest) {
    const eq = rest.indexOf('=');
    if (eq < 0)
        return undefined;
    const key = rest.slice(0, eq).trim();
    const decision = rest.slice(eq + 1).trim();
    if (key.length === 0 || decision.length === 0)
        return undefined;
    return { key, decision };
}
/**
 * `/project library` — what the threads produced.
 *
 * Reading is a separate verb because the list is metadata that outlives the worktree, while
 * the bytes do not: a row can legitimately exist with nothing behind it any more.
 */
async function runLibrary(engine, rest) {
    const trimmed = rest.trim();
    if (trimmed.length === 0 || trimmed === 'list') {
        const files = await engine.library();
        if (files.length === 0) {
            return success('no files yet. Threads appear here once they commit or open a pull request.');
        }
        const lines = [`${files.length} file(s) produced:`, ''];
        for (const file of files) {
            lines.push(`- \`${file.path}\` (${file.change}) — ${file.threads.join(', ')}`);
        }
        lines.push('', 'read one with: `/project library read <path>`');
        return success(lines.join('\n'));
    }
    const [verb, ...tail] = trimmed.split(/\s+/);
    if (verb !== 'read') {
        return { kind: 'error', text: `unknown library verb "${verb}"\n\n/library usage:\n- \`/project library\`\n- \`/project library read <path>\`` };
    }
    const path = tail.join(' ').trim();
    if (path.length === 0)
        return { kind: 'error', text: 'read needs a path' };
    const result = await engine.readOutputFile(path);
    if (!result.ok) {
        return { kind: 'error', text: `\`${result.path}\` is not readable: ${result.reason}` };
    }
    const header = [`# ${result.path}`, '', `- from: \`${result.source}\``, `- bytes: ${result.bytes ?? result.text.length}${result.truncated ? ' (truncated)' : ''}`, '']
        .join('\n');
    return success(header + result.text);
}
/**
 * The `/project knowledge` verb family.
 *
 * Split out because it needs the engine's knowledge surface rather than the thread surface,
 * and because a rebuild can fail on I/O in ways worth reporting one by one.
 */
async function runKnowledge(engine, rest) {
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
        }
        else {
            lines.push('Bound paths:');
            for (const path of manifest.knowledgePaths)
                lines.push(`- \`${path}\``);
        }
        if (state.warnings.length > 0) {
            lines.push('', 'Warnings:');
            for (const warning of state.warnings)
                lines.push(`- ${warning}`);
        }
        return success(lines.join('\n'));
    }
    if (verb === 'rebuild') {
        const state = await engine.buildKnowledge();
        const lines = [describeKnowledge(state)];
        if (state.warnings.length > 0) {
            lines.push('', 'Warnings:');
            for (const warning of state.warnings)
                lines.push(`- ${warning}`);
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
                for (const warning of result.state.warnings)
                    lines.push(`- ${warning}`);
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
export function buildProjectCommand(source) {
    return {
        name: 'project',
        description: 'Project overview, shared memory, and background thread control.',
        input: { hint: '[overview|init|memory|threads|thread|knowledge|heal|coordinate|start|drop]' },
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
                        const purge = rest.split(/\s+/).includes('--purge');
                        const outcome = await engine.deinit({ purge });
                        const base = 'project record deleted. Threads already running keep running; their descriptors are gone.';
                        if (!purge) {
                            return {
                                kind: 'success',
                                text: `${base} Files under .dsh-project/ are still on disk; add --purge to remove them.`,
                            };
                        }
                        const saved = outcome.savedInstructions === undefined
                            ? ''
                            : ` Your PROJECT_INSTRUCTIONS.md was copied to ${outcome.savedInstructions} first.`;
                        return {
                            kind: 'success',
                            text: `${base} Purged ${String(outcome.purged.length)} path(s) under .dsh-project/.${saved}`,
                        };
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
                            if (!outcome.removed)
                                return { kind: 'error', text: `no shared decision named \`${key}\`` };
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
                        const lines = entries.map((entry) => `- \`${entry.key}\` (r${String(entry.revision)}, by ${entry.authorThreadId}): ${entry.decision}`);
                        return { kind: 'success', text: `shared decisions:\n${lines.join('\n')}` };
                    }
                    case 'threads': {
                        const engine = await source.engineFor(invocation.agent, undefined);
                        await requireReady(engine);
                        const all = rest.trim() === '--all';
                        const threads = await engine.listThreads();
                        // Resolved threads are hidden by default: they are the record of finished work,
                        // and a list that never shrinks stops being a list you scan.
                        const shown = all ? threads : threads.filter((thread) => thread.status !== 'resolved');
                        if (shown.length === 0) {
                            const hiddenCount = threads.length - shown.length;
                            return {
                                kind: 'success',
                                text: hiddenCount > 0
                                    ? `no open threads (${hiddenCount} resolved; \`/project threads --all\`)`
                                    : 'no threads yet.',
                            };
                        }
                        const lines = shown.map((thread) => `- ${describeThread(thread)}`);
                        const hiddenCount = threads.length - shown.length;
                        if (hiddenCount > 0)
                            lines.push(`- (${hiddenCount} resolved hidden; \`/project threads --all\`)`);
                        return { kind: 'success', text: lines.join('\n') };
                    }
                    case 'thread': {
                        const engine = await source.engineFor(invocation.agent, undefined);
                        await requireReady(engine);
                        const spaceAt = rest.search(/\s/);
                        const threadId = spaceAt < 0 ? rest : rest.slice(0, spaceAt);
                        const tail = spaceAt < 0 ? '' : rest.slice(spaceAt + 1).trim();
                        if (threadId.length === 0)
                            return { kind: 'error', text: 'usage: `/project thread <id> [action] [text]`' };
                        const inner = splitVerb(tail);
                        const action = inner.verb === 'overview' || inner.verb.length === 0 ? 'inspect' : inner.verb;
                        if (action === 'approve') {
                            if (inner.rest.length === 0) {
                                return { kind: 'error', text: `usage: \`/project thread <id> approve <push|pr|merge|force-push>\`` };
                            }
                            const approved = await engine.approve(threadId, inner.rest.split(/\s+/)[0]);
                            return { kind: 'success', text: `approved ${inner.rest.trim()} for ${threadId}\n${describeThread(approved)}` };
                        }
                        if (action === 'deliver') {
                            const delivered = await engine.deliverThread(threadId, inner.rest.length === 0 ? {} : { body: inner.rest });
                            return { kind: 'success', text: delivered.message };
                        }
                        // Validate here instead of casting: an unknown verb used to reach the engine,
                        // whose switch has no default, and the caller then dereferenced `undefined`.
                        if (!THREAD_VERBS.includes(action)) {
                            return { kind: 'error', text: `unknown thread action \`${action}\`\n${PROJECT_USAGE}` };
                        }
                        const outcome = await engine.manageThread(invocation.agent, threadId, action, inner.rest.length === 0 ? undefined : inner.rest, invocation.signal);
                        return { kind: 'success', text: `${outcome.message}\n${describeThread(outcome.thread)}` };
                    }
                    case 'knowledge': {
                        const engine = await source.engineFor(invocation.agent, undefined);
                        await requireReady(engine);
                        return await runKnowledge(engine, rest);
                    }
                    case 'library': {
                        const engine = await source.engineFor(invocation.agent, undefined);
                        await requireReady(engine);
                        return await runLibrary(engine, rest);
                    }
                    case 'pause': {
                        const engine = await source.engineFor(invocation.agent, undefined);
                        await requireReady(engine);
                        const result = await engine.pause(invocation.agent, rest.length === 0 ? undefined : rest);
                        const interrupted = result.interrupted.length === 0 ? 'no live threads to interrupt' : `interrupted ${result.interrupted.join(', ')}`;
                        return {
                            kind: 'success',
                            text: `paused${rest.length === 0 ? '' : `: ${rest}`} — ${interrupted}. Nothing starts or advances until \`/project resume\`.`,
                        };
                    }
                    case 'archive': {
                        const engine = await source.engineFor(invocation.agent, undefined);
                        await requireReady(engine);
                        const result = await engine.archive(invocation.agent);
                        const interrupted = result.interrupted.length === 0 ? 'no live threads to interrupt' : `interrupted ${result.interrupted.join(', ')}`;
                        return {
                            kind: 'success',
                            text: result.wasArchived
                                ? `already archived — ${interrupted}`
                                : `archived — ${interrupted}. Nothing runs and nothing polls until \`/project unarchive\`.`,
                        };
                    }
                    case 'unarchive': {
                        const engine = await source.engineFor(invocation.agent, undefined);
                        await requireReady(engine);
                        const result = await engine.unarchive(invocation.agent);
                        return {
                            kind: 'success',
                            text: result.wasArchived
                                ? 'unarchived — interrupted threads stay put until you retry or steer them'
                                : 'not archived; nothing to unarchive',
                        };
                    }
                    case 'resume': {
                        const engine = await source.engineFor(invocation.agent, undefined);
                        await requireReady(engine);
                        const result = await engine.resume(invocation.agent);
                        return {
                            kind: 'success',
                            text: result.wasPaused ? 'resumed — interrupted threads are resumable again' : 'not paused; nothing to resume',
                        };
                    }
                    case 'goal': {
                        const engine = await source.engineFor(invocation.agent, undefined);
                        await requireReady(engine);
                        if (rest.length > 0) {
                            const clear = rest.toLowerCase() === 'clear' || rest.toLowerCase() === 'none';
                            const result = await engine.setGoal(clear ? undefined : rest);
                            if (!result.changed) {
                                return { kind: 'success', text: `goal unchanged: ${result.goal ?? '(none)'}` };
                            }
                            return {
                                kind: 'success',
                                text: result.goal === undefined
                                    ? 'goal cleared. The coordinator works from the tasks you send.'
                                    : `goal set: ${result.goal}\nevery new thread starts with it in the shared charter`,
                            };
                        }
                        const goal = await engine.goal();
                        const recent = await engine.recentMessages();
                        const lines = [goal === undefined ? 'no goal set. `/project goal <text>` to add one.' : `goal: ${goal}`];
                        const tail = recent.slice(-5).reverse();
                        if (tail.length > 0) {
                            lines.push('', 'recent coordinator messages:');
                            for (const message of tail)
                                lines.push(`- ${new Date(message.at).toISOString()} ${message.role}: ${message.text}`);
                        }
                        return { kind: 'success', text: lines.join('\n') };
                    }
                    case 'usage': {
                        const engine = await source.engineFor(invocation.agent, undefined);
                        await requireReady(engine);
                        return { kind: 'success', text: renderUsageMarkdown(await engine.usageSummary()) };
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
                        if (sweep.timedOut.length > 0) {
                            // Named separately from "healed": a timeout is a policy event the user may need to
                            // revisit (raise the budget), not a repair the engine performed.
                            parts.push(`timed out ${sweep.timedOut.map((thread) => thread.threadId).join(', ')}`);
                        }
                        if (sweep.errors.length > 0) {
                            parts.push(`errors: ${sweep.errors.map((error) => `${error.threadId}: ${error.message}`).join('; ')}`);
                        }
                        if (sweep.paused !== undefined)
                            parts.push(`paused: ${sweep.paused}`);
                        return { kind: 'success', text: parts.join(', ') };
                    }
                    case 'coordinate': {
                        const engine = await source.engineFor(invocation.agent, undefined);
                        await requireReady(engine);
                        if (rest.length === 0)
                            return { kind: 'error', text: 'usage: `/project coordinate <goal>`' };
                        // The command bypasses the model, so there is no task list to hand over: this is
                        // always the fallback split, and it is always proposed rather than started.
                        const result = await engine.coordinate(invocation.agent, rest, {}, invocation.signal);
                        const lines = [
                            `planned ${String(result.planned.length)}, started ${String(result.started.length)}, skipped ${String(result.skipped.length)}`,
                            `quota ${String(result.quota.created)}/${String(result.quota.max)} for ${result.quota.day}`,
                        ];
                        if (result.planNote !== undefined)
                            lines.push('', result.planNote);
                        if (result.planOnly) {
                            for (const [ordinal, task] of result.suggested.entries()) {
                                lines.push(`${String(ordinal + 1)}. ${task.title} — ${task.objective}`);
                            }
                            lines.push('', 'nothing started. `/project start` for all, `/project start 1 3` for some, `/project drop` to discard.');
                        }
                        for (const thread of result.started) {
                            lines.push(`- started \`${thread.threadId}\`: ${thread.title}${thread.branch === undefined ? '' : ` on ${thread.branch}`}`);
                        }
                        for (const entry of result.skipped)
                            lines.push(`- skipped "${entry.task.title}": ${entry.reason}`);
                        return { kind: 'success', text: lines.join('\n') };
                    }
                    case 'start': {
                        const engine = await source.engineFor(invocation.agent, undefined);
                        await requireReady(engine);
                        const indices = rest
                            .split(/[\s,]+/)
                            .map((token) => Number.parseInt(token, 10))
                            .filter((value) => Number.isInteger(value));
                        const result = await engine.startSuggested(invocation.agent, indices.length === 0 ? {} : { indices }, invocation.signal);
                        const lines = [
                            `started ${String(result.started.length)}, skipped ${String(result.skipped.length)}, still proposed ${String(result.remaining.length)}`,
                            `quota ${String(result.quota.created)}/${String(result.quota.max)} for ${result.quota.day}`,
                        ];
                        for (const thread of result.started) {
                            lines.push(`- started \`${thread.threadId}\`: ${thread.title}${thread.branch === undefined ? '' : ` on ${thread.branch}`}`);
                        }
                        for (const entry of result.skipped)
                            lines.push(`- skipped "${entry.task.title}": ${entry.reason}`);
                        return { kind: 'success', text: lines.join('\n') };
                    }
                    case 'drop': {
                        const engine = await source.engineFor(invocation.agent, undefined);
                        await requireReady(engine);
                        const dropped = await engine.discardSuggested();
                        return {
                            kind: 'success',
                            text: dropped.discarded === 0
                                ? 'no proposed threads to discard'
                                : `discarded ${String(dropped.discarded)} proposed thread(s)`,
                        };
                    }
                    default:
                        return { kind: 'error', text: `unknown verb "${verb}".\n\n${PROJECT_USAGE}` };
                }
            }
            catch (error) {
                return { kind: 'error', text: isProjectError(error) ? `${error.code}: ${error.message}` : describeError(error) };
            }
        },
    };
}
/** Reject a verb that needs an existing project record. */
async function requireReady(engine) {
    if (await engine.isInitialised())
        return;
    throw new Error(`no project at ${engine.rootDir}; run \`/project init\` first`);
}
/** Build every command this plugin adds. */
export function buildCommands(source) {
    return [buildProjectCommand(source)];
}
/** Result helper used by tests to keep the union narrow. */
export function success(text) {
    return { kind: 'success', text };
}
