/**
 * Plugin entry: wires the orchestration core onto Host services.
 *
 * Composition rules this file follows:
 *
 * - **`subprocess` is a declared dependency; everything else is optional.** Git and GitHub
 *   are the core's only external world, so the plugin must not activate before a runner
 *   exists — and it must not silently claim isolation it cannot provide. Everything else is
 *   acquired with `ctx.inject`, which defers the registration until the service is actually
 *   available: `ctx.get` only samples the registry at the instant `apply` runs, so a service
 *   that mounts later would be missed forever.
 * - **Every registration is an effect.** The Host disposes them on unload, so Creator Mode
 *   reloads leave nothing behind — no timer, no tool, no prompt section.
 * - **Engines are cached per root directory.** A tool call names its project; the session
 *   workspace is only the default. One engine per root also means one turn-end
 *   subscription per root instead of one per call.
 *
 * @module dsh-newprojects
 */

import { isAbsolute, resolve } from 'node:path';

import {
  DEFAULT_CI_POLL_INTERVAL_MS,
  MIN_CI_POLL_INTERVAL_MS,
  ProjectEngine,
  normalisePollInterval,
} from './core/engine.js';
import { SwappableThreadRuntime, UnavailableThreadRuntime, type ThreadRuntime } from './core/threads.js';
import { createCommandRunner } from './host/commandRunner.js';
import { buildCommands, type CommandContextSource } from './host/commands.js';
import { SubagentThreadRuntime } from './host/subagents.js';
import { buildTools, type ToolContextSource } from './host/tools.js';
import type {
  HostCommands,
  HostContext,
  HostSubagents,
  HostSubprocess,
  HostSystemPrompt,
  HostTimer,
  HostToolRunContext,
  HostTools,
  HostWorkingDirectory,
} from './host/hostTypes.js';

/**
 * Declared dependencies.
 *
 * `subprocess` only: without it there is no git and no `gh`, and coordination would claim
 * to isolate work it cannot isolate. Naming it here makes Cordis hold the plugin inactive
 * until the service is up instead of racing the rest of the profile.
 */
export const inject = ['subprocess'] as const;

/** Plugin configuration, settable from the profile's `cordis.patch.yml`. */
export interface ProjectBetaConfig {
  /** Subagent provider used for durable threads. */
  subagentProvider?: string;
  /** CI/review poll cadence in milliseconds; `0` disables the background watcher. */
  ciPollIntervalMs?: number;
  /** Order of the shared-memory system-prompt section. */
  promptSectionOrder?: number;
  /**
   * Where the user-wide daily thread ledger lives.
   *
   * The enforced quota is "200 new threads per day across your projects", so the counter is
   * shared by every project on this machine. Configurable because one machine may run
   * several Harness profiles that should not share a budget.
   */
  quotaLedgerPath?: string;
}

/**
 * Prompt-section order.
 *
 * Any finite integer is legal for a plugin section. This one lands in the Host's free gap
 * between its tool sections (which end at 5000) and its deliverable/output sections (which
 * start at 9000): shared project decisions then sit after the tool descriptions they
 * qualify and before per-response output scaffolding.
 */
const DEFAULT_PROMPT_SECTION_ORDER = 5_100;

/** Name of the injected shared-memory section. */
const PROMPT_SECTION_NAME = 'project-beta-charter';

/** Per-activation state shared by the tool, command, and watcher registrations. */
interface Runtime {
  /** Engine for one root, created on first use. */
  engineFor(rootDir: string | undefined): ProjectEngine;
  /** Every engine created so far, in creation order. */
  engines(): Iterable<ProjectEngine>;
  /** Drop every cached engine and turn-end subscription. */
  dispose(): void;
}

function createRuntime(options: {
  root: () => string;
  runner: ReturnType<typeof createCommandRunner>;
  threads: ThreadRuntime;
  quotaLedgerPath?: string;
}): Runtime {
  const engines = new Map<string, ProjectEngine>();
  const detaches = new Map<string, () => void>();

  const resolveRoot = (rootDir: string | undefined): string => {
    const chosen = rootDir ?? options.root();
    return isAbsolute(chosen) ? chosen : resolve(chosen);
  };

  const engineFor = (rootDir: string | undefined): ProjectEngine => {
    const root = resolveRoot(rootDir);
    const existing = engines.get(root);
    if (existing !== undefined) return existing;
    const engine = new ProjectEngine(root, {
      runner: options.runner,
      threads: options.threads,
      ...(options.quotaLedgerPath === undefined ? {} : { quotaLedgerPath: options.quotaLedgerPath }),
    });
    engines.set(root, engine);
    // Attach once per root, here, so exactly one listener exists no matter how many tool
    // calls touch the same project.
    detaches.set(root, engine.attach());
    return engine;
  };

  return {
    engineFor,
    engines: () => engines.values(),
    dispose: () => {
      for (const detach of detaches.values()) detach();
      detaches.clear();
      engines.clear();
    },
  };
}

/**
 * Activate the plugin.
 *
 * `ctx` is typed structurally rather than imported from the Host: this package lives
 * outside the Host's module tree, so it cannot resolve the Host's own packages, and
 * duplicating the entire Cordis surface would be worse than declaring what is used.
 */
export function apply(ctx: HostContext, config: ProjectBetaConfig = {}): void {
  const subprocess = ctx.get('subprocess') as HostSubprocess | undefined;
  if (subprocess === undefined) {
    // `inject` should have held activation back, so reaching here means the Host resolved
    // the dependency but did not expose it. Failing loudly beats coordinating blind.
    throw new Error('dsh-newprojects needs the "subprocess" service to run git and gh');
  }

  const pollIntervalMs = normalisePollInterval(
    config.ciPollIntervalMs ?? DEFAULT_CI_POLL_INTERVAL_MS,
  );

  // The thread runtime is shared by every engine, so it outlives individual root records.
  // It starts unavailable and is swapped when `subagents` arrives: a Host can mount that
  // service after this plugin, and an engine that captured the placeholder would never see
  // a finished turn again.
  const threads = new SwappableThreadRuntime(
    new UnavailableThreadRuntime(
      'the "subagents" service is not available, so background threads cannot start',
    ),
  );
  ctx.effect(() => () => threads.dispose());
  ctx.inject(['subagents'], (scoped) => {
    const subagents = scoped.get('subagents') as HostSubagents | undefined;
    if (subagents === undefined) return;
    threads.replace(new SubagentThreadRuntime(subagents, config.subagentProvider ?? 'spawn'));
  });

  const runtime = createRuntime({
    root: () =>
      (ctx.get('workingDirectory') as HostWorkingDirectory | undefined)?.defaultDirectory ??
      process.cwd(),
    runner: createCommandRunner(subprocess),
    threads,
    ...(config.quotaLedgerPath === undefined ? {} : { quotaLedgerPath: config.quotaLedgerPath }),
  });
  ctx.effect(() => runtime.dispose);

  ctx.inject(['tools'], (scoped) => {
    const tools = scoped.get('tools') as HostTools | undefined;
    if (tools === undefined) return;
    const source: ToolContextSource = {
      async engineFor(rootDir) {
        return runtime.engineFor(rootDir);
      },
      parentOf(exec: HostToolRunContext): object {
        if (exec.agent === undefined) {
          throw new Error('project tools must run for an agent, so their threads have an owner');
        }
        return exec.agent;
      },
    };
    scoped.effect(() => {
      const disposers = buildTools(source).map((definition) => tools.register(definition));
      return () => {
        for (const dispose of disposers) dispose();
      };
    });
  });

  ctx.inject(['commands'], (scoped) => {
    const commands = scoped.get('commands') as HostCommands | undefined;
    if (commands === undefined) return;
    const source: CommandContextSource = {
      async engineFor(_agent, rootDir) {
        return runtime.engineFor(rootDir);
      },
    };
    scoped.effect(() => {
      const disposers = buildCommands(source).map((definition) => commands.register(definition));
      return () => {
        for (const dispose of disposers) dispose();
      };
    });
  });

  ctx.inject(['systemPrompt'], (scoped) => {
    const systemPrompt = scoped.get('systemPrompt') as HostSystemPrompt | undefined;
    if (systemPrompt === undefined) return;
    scoped.effect(() =>
      systemPrompt.section({
        name: PROMPT_SECTION_NAME,
        order: config.promptSectionOrder ?? DEFAULT_PROMPT_SECTION_ORDER,
        // Read synchronously from the render cache and schedule a refresh. The text is
        // free of timestamps, counters, and ids, so repeated assemblies produce an
        // identical prefix and the provider's prompt cache keeps hitting.
        text: () => charterText(runtime),
      }),
    );
  });

  // Background self-healing needs both a clock and a real thread runtime: healing means
  // waking a child session, so without `subagents` there is nothing to wake.
  if (config.ciPollIntervalMs !== 0) {
    ctx.inject(['timer', 'subagents'], (scoped) => {
      const timer = scoped.get('timer') as HostTimer | undefined;
      if (timer === undefined) return;
      scoped.effect(() => startWatcher({ timer, threads, runtime, pollIntervalMs }));
    });
  }
}

/**
 * Concatenate every project's cached charter for the prompt section.
 *
 * Also schedules a refresh so the next assembly reflects the newest decisions. Doing the
 * read here is impossible (the hook is synchronous) and blocking on it is worse, so the
 * cost is one stale assembly, not one stale session.
 */
function charterText(runtime: Runtime): string {
  const parts: string[] = [];
  for (const engine of runtime.engines()) {
    const cached = engine.cachedCharter();
    if (cached.length > 0) parts.push(cached);
    void engine.renderCharter().catch(() => undefined);
  }
  return parts.join('\n\n');
}

interface WatcherDeps {
  timer: HostTimer;
  threads: ThreadRuntime;
  runtime: Runtime;
  pollIntervalMs: number;
}

/**
 * Poll every initialised project and heal whatever is actionable.
 *
 * Deliberately sequential and self-excluding: one sweep at a time across all projects, so
 * a slow `gh` call cannot overlap with the next tick and multiply rate-limit pressure.
 */
function startWatcher(deps: WatcherDeps): () => void {
  let running = false;
  let stopped = false;

  const sweep = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      for (const engine of deps.runtime.engines()) {
        if (stopped) return;
        if (!(await engine.isInitialised().catch(() => false))) continue;
        const parent = await firstKnownParent(engine, deps.threads);
        // A thread whose launching parent this process no longer knows cannot be woken:
        // the Host authorizes a wake against a live sender, and inventing one is not an
        // option.
        if (parent === undefined) continue;
        await engine.healSweep(parent, AbortSignal.timeout(120_000)).catch(() => undefined);
      }
    } finally {
      running = false;
    }
  };

  const cancel = deps.timer.interval(() => {
    void sweep();
  }, deps.pollIntervalMs);

  return () => {
    stopped = true;
    cancel();
  };
}

/** The first thread in a project whose launching parent is still addressable. */
async function firstKnownParent(
  engine: ProjectEngine,
  threads: ThreadRuntime,
): Promise<object | undefined> {
  const list = await engine.listThreads().catch(() => []);
  for (const thread of list) {
    const parent = threads.parentFor(thread.childSessionId);
    if (parent !== undefined) return parent;
  }
  return undefined;
}

export { MIN_CI_POLL_INTERVAL_MS };
