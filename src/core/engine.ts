/**
 * Project engine — the orchestration core.
 *
 * Owns no Host types: everything external arrives through the {@link CommandRunner}
 * and {@link ThreadRuntime} ports plus a `parent` object the Host adapter understands.
 * That keeps the whole coordination policy unit-testable with in-memory fakes and
 * keeps the plugin's Host coupling confined to `host/`.
 *
 * Responsibility split:
 * - {@link ProjectEngine} — transitions, quota, persistence, thread lifecycle.
 * - `core/healing.ts` — the pure "what should happen next" decision.
 * - `core/prompt.ts` — prompt bytes.
 * - `host/` — adapters and registration.
 */

import { isAbsolute, join, resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

import { describeError, isProjectError, ProjectError } from './errors.js';
import { CommandError } from './exec.js';
import type { CommandRunner } from './exec.js';
import {
  buildHealPrompt,
  decideHealAction,
  failureSignature,
  mergeSnapshot,
  toCheckStates,
  toReviewComments,
  type HealAction,
} from './healing.js';
import {
  buildIndex,
  MAX_KNOWLEDGE_FILES,
  MAX_KNOWLEDGE_INDEX_CHARS,
  emptyIndex,
  describeKnowledge,
  resolveKnowledgeState,
  searchKnowledge,
  type KnowledgeHit,
  type KnowledgeIndex,
  type KnowledgeState,
} from './knowledge.js';
import { collectKnowledge, readIndexFile, writeIndexFile } from './knowledgeSource.js';
import { ManifestStore, INSTRUCTIONS_FILE, projectPaths, type ProjectPaths } from './manifest.js';
import {
  COORDINATOR_AUTHOR,
  markSeen,
  removeMemory,
  renderMemoryDelta,
  renderMemoryMirror,
  sortedMemories,
  upsertMemory,
} from './memory.js';
import { buildOverview, dueForResolve } from './overview.js';
import { buildProjectState, type ProjectStateSnapshot } from './projectState.js';
import { branchNameFor, normaliseTasks, planTasks, PLAN_TTL_MS } from './planner.js';
import {
  renderConflictRequest,
  renderFeedbackAnswer,
  renderMergeRequest,
  renderProjectCharter,
  renderThreadTask,
} from './prompt.js';
import { normaliseQuotaMax, quotaState, quotaWarning, releaseQuota, reserveQuota, rolloverQuota } from './quota.js';
import { QuotaLedger, defaultQuotaLedgerPath, type QuotaLedgerState } from './quotaLedger.js';
import { systemClock, systemIds, dayKey } from './util.js';
import type { Clock, IdFactory } from './util.js';
import type {
  ApprovalAction,
  CoordinateResult,
  OverviewBucket,
  PlanOrigin,
  PlannedTask,
  ProjectManifest,
  ProjectMemoryEntry,
  ProjectOverview,
  ProjectPlan,
  ProjectLibraryEntry,
  ProjectOutputFile,
  ProjectReviewSnapshot,
  ProjectThreadDescriptor,
  SuggestStartResult,
  ThreadStatus,
} from '../types.js';
import type { ThreadHandle, ThreadOutcome, ThreadRuntime } from './threads.js';
import {
  classifyGhFailure,
  commitAll,
  createBranch,
  createPullRequest,
  inspectRepo,
  pushBranch,
  readChangedFiles,
  readChecks,
  readPrState,
  readReviewComments,
  readReviewVerdicts,
  type RepoFacts,
  mergeBase,
  readPrBase,
  removeWorktree,
  ensureWorktree,
} from './vcs.js';
import { aggregateLibrary, readOutput as readOutputBytes } from './library.js';
import type { OutputReadResult } from './library.js';

/** Default poll cadence for the self-healing watcher. */
export const DEFAULT_CI_POLL_INTERVAL_MS = 60_000;
/** Lower bound so a misconfigured value cannot hammer GitHub. */
export const MIN_CI_POLL_INTERVAL_MS = 15_000;

/** Re-exported so callers configuring a watcher can match the plan shelf life. */
export { PLAN_TTL_MS };

/** Engine dependencies. */
export interface EngineDeps {
  runner: CommandRunner;
  threads: ThreadRuntime;
  clock?: Clock;
  ids?: IdFactory;
  /** Per-key watermark map of memory revisions already delivered, keyed by child session. */
  memoryWatermarks?: Map<string, Record<string, number>>;
  /**
   * Where the user-wide thread ledger lives.
   *
   * Defaults to {@link defaultQuotaLedgerPath}. Tests and multi-profile setups must be able
   * to point this somewhere isolated: the ledger is shared by every project on the machine
   * by design, so a test that used the real one would both pollute the user's budget and
   * couple test cases to each other.
   */
  quotaLedgerPath?: string;
  /**
   * Irreversible git actions that need human sign-off in this project.
   *
   * Defaults to empty, which keeps the original behaviour: threads push and open pull requests
   * on their own. When an action is listed, the engine refuses to perform it until
   * {@link ProjectEngine.approve} records a grant, and thread prompts stop before it and ask.
   */
  requireApprovalFor?: readonly ApprovalAction[];
}

/** Options accepted by {@link ProjectEngine.init}. */
export interface InitOptions {
  name?: string;
  instructionsPath?: string;
  knowledgePaths?: string[];
  dailyThreadQuotaMax?: number;
  ciPollIntervalMs?: number;
}

/** Options accepted by {@link ProjectEngine.coordinate}. */
export interface CoordinateOptions {
  /** Override the derived project branch namespace. */
  branchNamespace?: string;
  /** Force scope-only isolation (no branches, no worktrees). */
  scopeOnly?: boolean;
  /** Maximum threads to start in this round. */
  limit?: number;
  /** Extra shared-memory keys to hand each thread. */
  memoryKeys?: string[];
  /** Skip the daily quota check (used by tests and explicit user overrides). */
  ignoreQuota?: boolean;
  /**
   * The caller's own decomposition.
   *
   * When present it is used instead of the deterministic planner: the coordinating model
   * deciding what becomes a thread is the feature, and re-splitting a decided plan by regex
   * is strictly worse. Validated by {@link normaliseTasks}.
   */
  tasks?: unknown;
  /**
   * Propose the threads instead of starting them.
   *
   * Defaults to `true` when the tasks came from the fallback planner: that split is a guess,
   * and each guessed line costs one worktree, one branch, one child session and one quota
   * unit. Pass `false` to start a guessed plan anyway.
   */
  planOnly?: boolean;
  /** Title used when the fallback planner is given a single unmarked goal. */
  planTitle?: string;
}

/** Options accepted by {@link ProjectEngine.startSuggested}. */
export interface SuggestStartOptions extends Omit<CoordinateOptions, 'tasks' | 'planOnly' | 'planTitle'> {
  /** 1-based positions within the pending plan; absent means every task. */
  indices?: number[];
}

/** The pending decomposition, plus whether one was dropped for age. */
export interface PendingPlan {
  plan?: ProjectPlan;
  /** True when a plan existed but exceeded {@link PLAN_TTL_MS}. */
  expired: boolean;
}

/** Result of one self-healing sweep. */
export interface HealSweepResult {
  observed: number;
  /** Threads marked resolved because they had been silent for a week. */
  resolved: number;
  healed: ProjectThreadDescriptor[];
  escalated: ProjectThreadDescriptor[];
  settled: ProjectThreadDescriptor[];
  waiting: ProjectThreadDescriptor[];
  errors: Array<{ threadId: string; message: string }>;
  /** Set when the sweep declined to act because the project is paused. */
  paused?: string;
}

/** Thread-management verbs exposed to the model and the `/project` command. */
/** Actions that can be gated on human sign-off. */
export const APPROVAL_ACTIONS: readonly ApprovalAction[] = ['push', 'pr', 'merge', 'force-push'];

export type ThreadAction =
  | 'inspect'
  | 'steer'
  | 'respond'
  | 'interrupt'
  | 'retry'
  | 'close'
  | 'reopen'
  | 'merge'
  | 'conflicts'
  | 'review'
  | 'watch'
  | 'unwatch';

/** The orchestration core. */
export class ProjectEngine {
  readonly store: ManifestStore;
  /** Actions this project gates on human sign-off; empty means the original behaviour. */
  private readonly requireApprovalFor: ApprovalAction[];
  private readonly runner: CommandRunner;
  private readonly threads: ThreadRuntime;
  private readonly clock: Clock;
  private readonly ids: IdFactory;
  private readonly watermarks: Map<string, Record<string, number>>;
  /** Child session id -> thread id, for routing turn-end events back to a descriptor. */
  private readonly live = new Map<string, string>();
  /** Active `onSettled` subscription, present only while {@link attach} is in effect. */
  private detachOutcomes: (() => void) | undefined;
  /** Last rendered charter text; see {@link cachedCharter}. */
  private charterCache = '';
  /**
   * Retrieval index plus the state derived from it.
   *
   * Cached because the panel and the prompt both ask for it and neither may re-read the
   * index file on every render. Invalidated by every knowledge mutation.
   */
  private knowledgeCache: { index: KnowledgeIndex; state: KnowledgeState } | undefined;
  /** The user-wide daily thread ledger; the enforced cap lives here, not in the manifest. */
  private readonly ledger: QuotaLedger;
  /**
   * Sessions that have driven this project, in call order.
   *
   * The projection that feeds the panel is per-session, so a state change has to be appended
   * to the sessions a human is actually looking at. We learn those ids from the callers of
   * the public methods rather than from a registry: a project can be driven from more than
   * one session, and the ones that matter are exactly the ones that issued a command.
   */
  private readonly coordinators: string[] = [];
  /** Sink for state snapshots; installed by the plugin so `core/` stays Host-free. */
  private statePublisher: ((sessionId: string, snapshot: ProjectStateSnapshot) => void) | undefined;

  constructor(
    readonly rootDir: string,
    deps: EngineDeps,
  ) {
    this.runner = deps.runner;
    this.threads = deps.threads;
    this.clock = deps.clock ?? systemClock;
    this.ids = deps.ids ?? systemIds;
    this.watermarks = deps.memoryWatermarks ?? new Map();
    this.requireApprovalFor = [...(deps.requireApprovalFor ?? [])];
    this.store = new ManifestStore(rootDir, this.clock);
    this.ledger = new QuotaLedger(deps.quotaLedgerPath ?? defaultQuotaLedgerPath());
  }

  /**
   * Remember that this session drives the project, and remember it from a plain object.
   *
   * `parent` is opaque in this layer on purpose (no Host types). If the caller exposes a
   * string `id` we keep it; if it does not, the project still works — the panel just has no
   * session to fold the snapshot into.
   */
  noteCaller(parent: unknown): void {
    const id = (parent as { id?: unknown } | undefined)?.id;
    if (typeof id !== 'string' || id.length === 0) return;
    if (this.coordinators.includes(id)) return;
    this.coordinators.push(id);
  }

  /** Install the snapshot sink. Called once by the plugin; absent in tests that do not care. */
  setStatePublisher(publisher: (sessionId: string, snapshot: ProjectStateSnapshot) => void): void {
    this.statePublisher = publisher;
  }

  /** Sessions known to drive this project. */
  coordinatorSessions(): readonly string[] {
    return this.coordinators;
  }

  /**
   * Publish the current state to every coordinator session.
   *
   * Fire-and-forget: a panel that fails to update must never fail the write that produced
   * it. Called only after a mutation, never from a renderer, so an idle project pays nothing.
   */
  private async publishState(): Promise<void> {
    const publisher = this.statePublisher;
    if (publisher === undefined || this.coordinators.length === 0) return;
    const manifest = await this.store.tryRead();
    if (manifest === undefined) return;
    const overview = buildOverview(manifest.manifest, this.clock.now());
    const snapshot = buildProjectState(overview, this.clock.now());
    for (const sessionId of this.coordinators) {
      try {
        publisher(sessionId, snapshot);
      } catch {
        // A closed or disposed session is not an error worth reporting: the next write
        // republishes to whoever is still there.
      }
    }
  }

  /** Today's user-wide ledger reading for this project. */
  async globalQuotaState(): Promise<QuotaLedgerState> {
    const manifest = await this.requireManifest();
    return this.ledger.snapshot(manifest.projectId, this.clock.now());
  }

  /**
   * Subscribe to turn ends.
   *
   * Called once by the plugin's `apply`, and disposed with it, so a reload leaves no
   * listener behind on the Host's runtime. Idempotent: a second call returns the same
   * detach function rather than stacking a duplicate subscription.
   */
  attach(): () => void {
    if (this.detachOutcomes !== undefined) return this.detachOutcomes;
    const detach = this.threads.onSettled((childSessionId, outcome) => {
      void this.handleOutcome(childSessionId, outcome);
    });
    this.detachOutcomes = () => {
      detach();
      this.detachOutcomes = undefined;
    };
    return this.detachOutcomes;
  }

  /** Project-scoped paths. */
  get paths(): ProjectPaths {
    return this.store.paths;
  }

  /** Whether a project record exists for this root. */
  async isInitialised(): Promise<boolean> {
    return this.store.exists();
  }

  /** Read the manifest or throw `PROJECT_NOT_INITIALIZED`. */
  async requireManifest(): Promise<ProjectManifest> {
    return (await this.store.read()).manifest;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Create the project record.
   *
   * `rootDir` is resolved against the current directory when relative, matching how
   * every other filesystem-facing tool in the Harness treats paths.
   */
  async init(options: InitOptions = {}): Promise<ProjectManifest> {
    const rootDir = isAbsolute(this.rootDir) ? this.rootDir : resolve(this.rootDir);
    const existing = await this.store.tryRead();
    if (existing !== undefined) {
      throw new ProjectError('INVALID_INPUT', `project already initialised at ${this.store.paths.manifestPath}`);
    }
    const now = this.clock.now();
    const name = options.name?.trim();
    const manifest: ProjectManifest = {
      projectId: this.ids.projectId(),
      name: name !== undefined && name.length > 0 ? name : defaultProjectName(rootDir),
      revision: 0,
      rootDir,
      instructionsPath: options.instructionsPath ?? join(rootDir, '.dsh-project', INSTRUCTIONS_FILE),
      knowledgePaths: [...(options.knowledgePaths ?? [])],
      dailyThreadQuotaMax: normaliseQuotaMax(options.dailyThreadQuotaMax),
      dailyThreadsCreated: 0,
      quotaDay: dayKey(now),
      memories: {},
      threads: {},
      createdAt: now,
      updatedAt: now,
      ciPollIntervalMs: normalisePollInterval(options.ciPollIntervalMs),
      prefixVersion: 0,
    };
    return this.store.create(manifest);
  }

  /** Delete the durable record. Threads keep running; their descriptors are dropped. */
  async deinit(): Promise<void> {
    await this.store.destroy();
    this.live.clear();
    this.watermarks.clear();
  }

  // ---------------------------------------------------------------------------
  // Shared memory
  // ---------------------------------------------------------------------------

  /**
   * Create or update one shared decision.
   *
   * `parent` is the Agent broadcasting the change; when omitted, nothing is pushed to
   * live threads and the caller is expected to have none yet.
   */
  async setMemory(
    parent: object | undefined,
    input: {
      key: string;
      decision: string;
      rationale?: string;
      /** Author label; defaults to the coordinator sentinel. */
      author?: string;
    },
  ): Promise<{ entry: ProjectMemoryEntry; broadcast: BroadcastOutcome }> {
    this.noteCaller(parent);
    const entry = await this.store.update((draft) => {
      const written = upsertMemory(
        draft,
        {
          key: input.key,
          decision: input.decision,
          ...(input.rationale === undefined ? {} : { rationale: input.rationale }),
          author: input.author ?? COORDINATOR_AUTHOR,
        },
        this.clock,
      );
      return { manifest: draft, result: written };
    });
    await this.refreshMemoryMirror();
    const broadcast = parent === undefined ? emptyBroadcast() : await this.broadcastMemory(parent);
    return { entry, broadcast };
  }

  /** Remove one decision. Unknown keys are reported rather than silently ignored. */
  async removeMemory(parent: object | undefined, key: string): Promise<{ removed: boolean; broadcast: BroadcastOutcome }> {
    const removed = await this.store.update((draft) => {
      const existed = removeMemory(draft, key);
      return { manifest: draft, result: existed };
    });
    if (removed) {
      await this.refreshMemoryMirror();
      const broadcast = parent === undefined ? emptyBroadcast() : await this.broadcastMemory(parent);
      return { removed: true, broadcast };
    }
    return { removed: false, broadcast: emptyBroadcast() };
  }

  /** All decisions, canonically ordered. */
  async listMemory(): Promise<ProjectMemoryEntry[]> {
    return sortedMemories(await this.requireManifest());
  }

  /**
   * Push changed decisions to threads that are mid-turn but have not seen them yet.
   *
   * Two deliberate restrictions:
   *
   * - **Only `busy` children are steered.** Sending to an idle child starts a fresh turn,
   *   so a broadcast would spend a full model round on each finished thread just to
   *   announce a decision. Idle threads pick the delta up when they are next woken for a
   *   real reason, which is also how a thread created later receives it (via the charter).
   * - **The parent Agent is required.** The Host authorizes a message against a live
   *   sender; an empty placeholder object would be rejected or, worse, attributed to the
   *   wrong owner.
   */
  async broadcastMemory(parent: object): Promise<BroadcastOutcome> {
    const manifest = await this.requireManifest();
    const outcome: BroadcastOutcome = { delivered: [], skipped: [], failed: [] };
    for (const thread of Object.values(manifest.threads)) {
      const where = this.threads.presence(thread.childSessionId);
      if (where !== 'busy') {
        outcome.skipped.push({ threadId: thread.threadId, reason: `session is ${where}` });
        continue;
      }
      const seen = this.watermarks.get(thread.childSessionId) ?? {};
      const delta = renderMemoryDelta(manifest, seen);
      if (delta.length === 0) {
        outcome.skipped.push({ threadId: thread.threadId, reason: 'already up to date' });
        continue;
      }
      try {
        await this.threads.steer(parent, thread.childSessionId, delta, AbortSignal.timeout(15_000));
        this.watermarks.set(thread.childSessionId, markSeen(manifest, seen));
        outcome.delivered.push(thread.threadId);
      } catch (error) {
        outcome.failed.push({ threadId: thread.threadId, reason: describeError(error) });
      }
    }
    return outcome;
  }

  /** Delta text for one child session, plus the watermark to store once delivered. */
  async memoryDeltaFor(childSessionId: string): Promise<{ text: string; watermark: Record<string, number> }> {
    const manifest = await this.requireManifest();
    const seen = this.watermarks.get(childSessionId) ?? {};
    return { text: renderMemoryDelta(manifest, seen), watermark: markSeen(manifest, seen) };
  }

  /** Persist that a delta was delivered to a child. */
  markMemoryDelivered(childSessionId: string, watermark: Record<string, number>): void {
    this.watermarks.set(childSessionId, watermark);
  }

  /** Rewrite `.dsh-project/SHARED_MEMORY.md` so the mirror never drifts. */
  async refreshMemoryMirror(): Promise<void> {
    const manifest = await this.requireManifest();
    await writeFile(this.store.paths.memoryMirrorPath, renderMemoryMirror(manifest), 'utf8');
  }

  /**
   * Render the shared charter for system-prompt mounting.
   *
   * Also refreshes {@link cachedCharter}, which is the only value the synchronous prompt
   * hook can read.
   */
  async renderCharter(): Promise<{ text: string; fingerprintSource: string }> {
    const manifest = await this.requireManifest();
    const instructions = await readFile(manifest.instructionsPath, 'utf8').catch(() => undefined);
    // Knowledge is part of the prefix, so its mode (full vs retrieval notice) has to be
    // decided here, at render time, from the size on disk.
    const knowledge = await this.knowledgeState().catch(() => undefined);
    const text = renderProjectCharter({
      manifest,
      ...(instructions === undefined ? {} : { instructions }),
      knowledgePaths: manifest.knowledgePaths,
      ...(knowledge === undefined ? {} : { knowledge }),
    });
    this.charterCache = text;
    return { text, fingerprintSource: text };
  }

  /**
   * The most recently rendered charter, for the synchronous prompt hook.
   *
   * Prompt assembly is synchronous but reading the manifest is not, so the hook cannot
   * await. Serving the previous render keeps the prefix byte-identical across the many
   * assemblies in one turn (which is the whole point of the stable section) and picks up
   * a decision one assembly later. Rendering afresh inside the hook would be impossible;
   * blocking on it would be worse. The returned text is empty until the first render.
   */
  cachedCharter(): string {
    return this.charterCache;
  }

  // ---------------------------------------------------------------------------
  // Coordination
  // ---------------------------------------------------------------------------

  /**
   * Decompose one goal and start one durable child thread per planned task.
   *
   * Failure policy: each thread is attempted independently. A failure is reported in
   * `skipped` and never aborts the round, because a partially started plan is far
   * more useful than an all-or-nothing one — the user can retry the failed task alone.
   */
  async coordinate(
    parent: object,
    goal: string,
    options: CoordinateOptions = {},
    signal: AbortSignal = AbortSignal.timeout(120_000),
  ): Promise<CoordinateResult> {
    this.noteCaller(parent);
    await this.refuseWhilePaused('start threads');
    const opening = await this.requireManifest();
    const plan = this.resolvePlan(goal, options);
    const planned = plan.tasks;
    if (planned.length === 0) throw new ProjectError('INVALID_INPUT', 'goal produced no tasks');

    // A guessed split is proposed; a split the caller stated is a decision and starts.
    const planOnly = options.planOnly ?? plan.origin === 'fallback';
    const planNote = plan.note;

    if (planOnly) {
      const now = this.clock.now();
      await this.store.update((draft) => {
        draft.plan = { plannedAt: now, origin: plan.origin, ...(planNote === undefined ? {} : { note: planNote }), tasks: planned };
        return { manifest: draft, result: undefined };
      });
      const finalManifest = await this.requireManifest();
      const global = await this.ledger.snapshot(finalManifest.projectId, this.clock.now());
      return {
        projectId: finalManifest.projectId,
        planned,
        started: [],
        skipped: [],
        quota: { ...quotaState(finalManifest, this.clock.now()), global: { created: global.created, max: global.max } },
        planOnly: true,
        planOrigin: plan.origin,
        ...(planNote === undefined ? {} : { planNote }),
        suggested: planned,
      };
    }

    const limit = Math.max(1, Math.min(options.limit ?? planned.length, planned.length));
    const tasks = planned.slice(0, limit);
    const now = this.clock.now();

    // Probe the environment once, so every task sees consistent facts.
    let repo: RepoFacts = { isRepo: false, ghReady: false, ghProblem: 'not inspected' };
    try {
      repo = await inspectRepo(this.runner, this.rootDir);
    } catch (error) {
      repo = { isRepo: false, ghReady: false, ghProblem: describeError(error) };
    }

    if (!this.threads.available()) {
      throw new ProjectError('SPAWN_FAILED', this.threads.unavailableReason?.() ?? 'no subagent runtime is available');
    }

    // Reserve the whole batch up front so a mid-round failure cannot overshoot the cap.
    //
    // Two ledgers, in this order. The user-wide one is the enforced cap ("200 new threads per
    // day across your projects") and is checked first, because a batch rejected there must
    // not leave a dent in the project's own counter. The manifest counter is the per-project
    // *preference*; it is the cheaper check but the weaker claim, so it goes second and its
    // failure refunds the global reservation.
    const reserved = options.ignoreQuota === true ? 0 : tasks.length;
    if (reserved > 0) {
      await this.ledger.reserve(opening.projectId, reserved, now);
      try {
        await this.store.update((draft) => {
          rolloverQuota(draft, dayKey(now));
          reserveQuota(draft, reserved, now);
          return { manifest: draft, result: undefined };
        });
      } catch (error) {
        await this.ledger.release(opening.projectId, reserved, now);
        throw error;
      }
    }

    const started: ProjectThreadDescriptor[] = [];
    const skipped: Array<{ task: PlannedTask; reason: string }> = [];

    for (const [ordinal, task] of tasks.entries()) {
      try {
        const descriptor = await this.startThread({
          parent,
          task,
          ordinal,
          repo,
          options,
          signal,
        });
        started.push(descriptor);
      } catch (error) {
        skipped.push({ task, reason: describeError(error) });
      }
    }

    // Give back reservations for tasks that never became threads — in both ledgers, or the
    // user's daily budget would leak on every failed launch.
    const unmatched = tasks.length - started.length;
    if (reserved > 0 && unmatched > 0) {
      await this.store.update((draft) => {
        releaseQuota(draft, unmatched, now);
        return { manifest: draft, result: undefined };
      });
      await this.ledger.release(opening.projectId, unmatched, now);
    }

    const finalManifest = await this.requireManifest();
    const global = await this.ledger.snapshot(finalManifest.projectId, this.clock.now());
    return {
      projectId: finalManifest.projectId,
      planned: tasks,
      started,
      skipped,
      quota: { ...quotaState(finalManifest, this.clock.now()), global: { created: global.created, max: global.max } },
      planOnly: false,
      planOrigin: plan.origin,
      ...(planNote === undefined ? {} : { planNote }),
      suggested: [],
    };
  }

  /**
   * Decide where a decomposition comes from.
   *
   * Order matters: the caller's own plan wins, because it is a decision. Only when the
   * caller supplied nothing usable does the deterministic planner guess — and the guess is
   * labelled as such, loudly, because a silent downgrade and a silently stale index are the
   * same class of bug: the user cannot tell that the confident output is a guess.
   */
  private resolvePlan(
    goal: string,
    options: CoordinateOptions,
  ): { tasks: PlannedTask[]; origin: PlanOrigin; note?: string } {
    const stated = normaliseTasks(options.tasks);
    if (stated.length > 0) return { tasks: stated, origin: 'model' };

    const guessed = planTasks(goal.trim(), options.planTitle);
    if (guessed.length === 0) return { tasks: [], origin: 'fallback' };

    // Explain the downgrade in the caller's own units (how many items, how they were cut)
    // rather than naming the module that did it.
    const note =
      `no task list was supplied, so the goal was split by its bullet markers (${guessed.length} ` +
      `${guessed.length === 1 ? 'task' : 'tasks'}). This is a deterministic guess, not a model decision — ` +
      `check the titles before accepting them.`;
    return { tasks: guessed, origin: 'fallback', note };
  }

  /**
   * Read the pending decomposition without touching the record.
   *
   * Expiry is reported, not enforced, here: reads (the overview panel, `/project threads`)
   * must not become writers, or every render after the deadline would bump the revision and
   * race whatever else is writing. The plan is actually dropped by the next mutating call —
   * {@link startSuggested} or {@link discardSuggested}.
   */
  async pendingPlan(nowMs: number = this.clock.now()): Promise<PendingPlan> {
    const manifest = await this.requireManifest();
    const plan = manifest.plan;
    if (plan === undefined) return { expired: false };
    if (nowMs - plan.plannedAt > PLAN_TTL_MS) return { expired: true };
    return { plan, expired: false };
  }

  /**
   * Start tasks from the pending plan.
   *
   * Starting a subset is the normal case — that is what a suggestion list is for. Ordinals
   * come from the position within the plan *at the moment of starting*, so the branch name of
   * a task only shifts if an earlier task was started and removed first; the alternative
   * (freezing an ordinal into `PlannedTask`) would put bookkeeping into a type that the model
   * also authors.
   */
  async startSuggested(
    parent: object,
    options: SuggestStartOptions = {},
    signal: AbortSignal = AbortSignal.timeout(120_000),
  ): Promise<SuggestStartResult> {
    this.noteCaller(parent);
    await this.refuseWhilePaused('start threads');
    const manifest = await this.requireManifest();
    const plan = manifest.plan;
    if (plan === undefined) {
      throw new ProjectError('INVALID_INPUT', 'no suggested threads are waiting; run `coordinate` to propose some');
    }
    const now = this.clock.now();
    if (now - plan.plannedAt > PLAN_TTL_MS) {
      await this.clearPlan();
      throw new ProjectError(
        'INVALID_INPUT',
        'the suggested plan is more than a day old and has been dropped; re-run `coordinate` to propose it again',
      );
    }

    const entries = plan.tasks.map((task, ordinal) => ({ task, ordinal }));
    let selected = entries;
    if (options.indices !== undefined && options.indices.length > 0) {
      const wanted = new Set<number>();
      for (const index of options.indices) {
        if (!Number.isInteger(index) || index < 1 || index > entries.length) {
          throw new ProjectError(
            'INVALID_INPUT',
            `suggested thread ${index} does not exist; the plan has ${entries.length} (1-${entries.length})`,
          );
        }
        wanted.add(index - 1);
      }
      selected = entries.filter((entry) => wanted.has(entry.ordinal));
    }
    const limit = Math.max(1, Math.min(options.limit ?? selected.length, selected.length));
    selected = selected.slice(0, limit);

    let repo: RepoFacts = { isRepo: false, ghReady: false, ghProblem: 'not inspected' };
    try {
      repo = await inspectRepo(this.runner, this.rootDir);
    } catch (error) {
      repo = { isRepo: false, ghReady: false, ghProblem: describeError(error) };
    }

    if (!this.threads.available()) {
      throw new ProjectError('SPAWN_FAILED', this.threads.unavailableReason?.() ?? 'no subagent runtime is available');
    }

    const reserved = options.ignoreQuota === true ? 0 : selected.length;
    if (reserved > 0) {
      await this.ledger.reserve(manifest.projectId, reserved, now);
      try {
        await this.store.update((draft) => {
          rolloverQuota(draft, dayKey(now));
          reserveQuota(draft, reserved, now);
          return { manifest: draft, result: undefined };
        });
      } catch (error) {
        await this.ledger.release(manifest.projectId, reserved, now);
        throw error;
      }
    }

    const started: ProjectThreadDescriptor[] = [];
    const skipped: Array<{ task: PlannedTask; reason: string }> = [];
    const consumed = new Set<number>();
    for (const { task, ordinal } of selected) {
      try {
        const descriptor = await this.startThread({
          parent,
          task,
          ordinal,
          repo,
          options: { ...options, planOnly: false },
          signal,
        });
        started.push(descriptor);
        consumed.add(ordinal);
      } catch (error) {
        skipped.push({ task, reason: describeError(error) });
      }
    }

    const unmatched = selected.length - started.length;
    if (reserved > 0 && unmatched > 0) {
      await this.store.update((draft) => {
        releaseQuota(draft, unmatched, now);
        return { manifest: draft, result: undefined };
      });
      await this.ledger.release(manifest.projectId, unmatched, now);
    }

    // Failed tasks stay in the plan so they can be retried; started ones leave it.
    const remaining = plan.tasks.filter((_task, ordinal) => !consumed.has(ordinal));
    await this.store.update((draft) => {
      if (remaining.length === 0) delete draft.plan;
      else if (draft.plan !== undefined) draft.plan.tasks = remaining;
      return { manifest: draft, result: undefined };
    });

    const finalManifest = await this.requireManifest();
    const global = await this.ledger.snapshot(finalManifest.projectId, this.clock.now());
    return {
      started,
      skipped,
      remaining,
      quota: { ...quotaState(finalManifest, this.clock.now()), global: { created: global.created, max: global.max } },
    };
  }

  /** Drop the pending decomposition; returns how many tasks were discarded. */
  async discardSuggested(): Promise<{ discarded: number }> {
    const manifest = await this.requireManifest();
    const plan = manifest.plan;
    if (plan === undefined) return { discarded: 0 };
    await this.clearPlan();
    return { discarded: plan.tasks.length };
  }

  private async clearPlan(): Promise<void> {
    await this.store.update((draft) => {
      delete draft.plan;
      return { manifest: draft, result: undefined };
    });
  }

  /** Start one thread: isolate, launch, persist. */
  private async startThread(input: {
    parent: object;
    task: PlannedTask;
    ordinal: number;
    repo: RepoFacts;
    options: CoordinateOptions;
    signal: AbortSignal;
  }): Promise<ProjectThreadDescriptor> {
    const { parent, task, ordinal, repo, options, signal } = input;
    const manifest = await this.requireManifest();
    const threadId = this.ids.threadId();
    const namespace = options.branchNamespace ?? slugify(manifest.name);

    const isolation = await this.prepareIsolation({
      manifest,
      task,
      ordinal,
      repo,
      namespace,
      scopeOnly: options.scopeOnly === true,
      threadId,
    });

    const now = this.clock.now();
    const worktreePath = isolation.worktreePath;
    const descriptor: ProjectThreadDescriptor = {
      threadId,
      childSessionId: '',
      title: task.title,
      objective: task.objective,
      branchOrScope: isolation.branch ?? task.scopeHint ?? manifest.rootDir,
      status: 'queued',
      startedAt: now,
      updatedAt: now,
      ...(isolation.branch === undefined ? {} : { branch: isolation.branch }),
      ...(isolation.baseCommit === undefined ? {} : { baseCommit: isolation.baseCommit }),
      ...(worktreePath === undefined ? {} : { worktreePath }),
      healAttempts: 0,
    };

    const promptText = renderThreadTask(descriptor, {
      ...(worktreePath === undefined ? {} : { worktreePath }),
      ...(options.memoryKeys === undefined ? {} : { memoryKeys: options.memoryKeys }),
      ...(this.requireApprovalFor.length === 0 ? {} : { approvals: this.requireApprovalFor }),
    });

    let handle: ThreadHandle;
    try {
      handle = await this.threads.launch(
        parent,
        {
          prompt: promptText,
          cwd: worktreePath ?? manifest.rootDir,
          label: task.title.slice(0, 60),
        },
        signal,
      );
    } catch (error) {
      throw new ProjectError('SPAWN_FAILED', `could not start thread "${task.title}": ${describeError(error)}`);
    }

    descriptor.childSessionId = handle.childSessionId;
    this.live.set(handle.childSessionId, threadId);
    this.watermarks.set(handle.childSessionId, markSeen(manifest, {}));

    await this.store.update((draft) => {
      draft.threads[threadId] = descriptor;
      return { manifest: draft, result: undefined };
    });

    // Persist the running state only after the durable record exists, so a crash
    // between the two leaves a queued descriptor rather than a phantom session.
    const running = await this.updateThread(threadId, (thread) => {
      thread.status = 'running';
    });

    return running;
  }

  /** Build the isolation unit for one task, falling back to scope isolation. */
  private async prepareIsolation(input: {
    manifest: ProjectManifest;
    task: PlannedTask;
    ordinal: number;
    repo: RepoFacts;
    namespace: string;
    scopeOnly: boolean;
    threadId: string;
  }): Promise<{ branch?: string; baseCommit?: string; worktreePath?: string }> {
    const { manifest, task, ordinal, repo, namespace, scopeOnly, threadId } = input;
    if (scopeOnly || !repo.isRepo) return {};
    const branch = branchNameFor(namespace, task, ordinal);
    const base = repo.headCommit;
    if (base === undefined) return {};
    try {
      // Every thread gets its own checkout. Sharing the parent's told each concurrent thread
      // to write into the same working tree: their `git status` would see each other's edits,
      // and a commit would land on whatever branch the parent had checked out instead of the
      // thread's own. A branch ref alone is not isolation.
      const worktreePath = join(projectPaths(manifest.rootDir).worktreeRoot, threadId);
      const created = await createBranch(this.runner, {
        repoRoot: repo.repositoryRoot ?? manifest.rootDir,
        branch,
        from: base,
        worktreePath,
      });
      return {
        branch: created.branch,
        ...(created.baseCommit === undefined ? {} : { baseCommit: created.baseCommit }),
        ...(created.worktreePath === undefined ? {} : { worktreePath: created.worktreePath }),
      };
    } catch (error) {
      if (error instanceof CommandError) {
        // A checkout could not be created (nested repo, read-only mount, existing directory).
        // The thread still runs, isolated by scope discipline, and says so in its status
        // rather than silently sharing the parent's tree.
        return { branch, baseCommit: base };
      }
      throw error;
    }
  }

  /** Route one finished turn onto its thread descriptor. */
  private async handleOutcome(childSessionId: string, outcome: ThreadOutcome): Promise<void> {
    const threadId = this.live.get(childSessionId);
    if (threadId === undefined) {
      // A child this engine never launched (another project's thread, or a leftover from
      // a previous process). Recording it onto a guessed descriptor would corrupt state.
      return;
    }
    try {
      await this.updateThread(threadId, (thread) => {
        thread.updatedAt = this.clock.now();
        thread.note = outcome.text.slice(0, 400);
        if (outcome.stopReason === 'completed') {
          // A finished turn is not the same as a finished deliverable. The thread is asked
          // to push and open a PR itself, so a PR reference in its closing message is real
          // evidence of a review target. Without one, the work is done but undelivered —
          // which needs a human decision (`deliver`, or steer it with what is left), not a
          // "completed" badge that claims a deliverable exists.
          const ref = extractPrUrl(outcome.text);
          if (ref !== undefined) {
            thread.status = 'awaiting_review';
            thread.prOrDeliverableRef = ref;
            thread.feedbackPrompt = undefined;
          } else {
            thread.status = 'needs_feedback';
            thread.feedbackPrompt =
              'the thread finished but reported no pull request; run `deliver` to commit and push, or steer it with what remains';
          }
          thread.lastError = undefined;
        } else if (outcome.stopReason === 'aborted') {
          // Interrupted, not failed: the work is resumable, so it goes back to the queue
          // rather than to the failed bucket where it would read as a lost cause.
          thread.status = 'queued';
          thread.lastError = 'child session was interrupted';
        } else {
          thread.status = 'failed';
          thread.lastError = outcome.diagnostic ?? `child stopped with ${outcome.stopReason}`;
        }
      });
    } catch (error) {
      // The descriptor may have been deleted while the child ran; a missing thread is
      // not worth crashing the listener over.
      if (!isProjectError(error)) throw error;
    }
    // Keep the routing entry: the thread may be resumed, and `isLive` is maintained by
    // the runtime itself rather than by this map.
  }

  // ---------------------------------------------------------------------------
  // Thread management
  // ---------------------------------------------------------------------------

  /** All threads, newest first. */
  async listThreads(): Promise<ProjectThreadDescriptor[]> {
    const manifest = await this.requireManifest();
    return Object.values(manifest.threads).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** One thread or a typed failure. */
  async requireThread(threadId: string): Promise<ProjectThreadDescriptor> {
    const manifest = await this.requireManifest();
    const thread = manifest.threads[threadId];
    if (thread === undefined) {
      throw new ProjectError('THREAD_NOT_FOUND', `unknown thread "${threadId}"`, { threadId });
    }
    return thread;
  }

  /**
   * Apply one management verb to a thread.
   *
   * `retry` re-launches a failed thread on its existing branch; `close` marks it done
   * without touching its branch or PR, so nothing is destroyed behind the user's back.
   */
  async manageThread(
    parent: object,
    threadId: string,
    action: ThreadAction,
    payload: string | undefined,
    signal: AbortSignal = AbortSignal.timeout(60_000),
  ): Promise<{ thread: ProjectThreadDescriptor; message: string }> {
    this.noteCaller(parent);
    const thread = await this.requireThread(threadId);
    switch (action) {
      case 'inspect': {
        return { thread, message: describeThread(thread) };
      }
      case 'steer': {
        if (payload === undefined || payload.trim().length === 0) {
          throw new ProjectError('INVALID_INPUT', 'steer requires a message');
        }
        await this.refuseWhilePaused('steer a thread');
        await this.threads.steer(parent, thread.childSessionId, payload.trim(), signal);
        const updated = await this.updateThread(threadId, (draft) => {
          if (draft.status === 'needs_feedback') draft.status = 'running';
          draft.feedbackPrompt = undefined;
          draft.updatedAt = this.clock.now();
        });
        return { thread: updated, message: `steered ${threadId}` };
      }
      case 'respond': {
        if (payload === undefined || payload.trim().length === 0) {
          throw new ProjectError('INVALID_INPUT', 'respond requires an answer');
        }
        await this.refuseWhilePaused('answer a thread');
        const text = renderFeedbackAnswer(thread, payload);
        await this.checkoutFor(thread);
        await this.threads.resume(parent, thread.childSessionId, text, signal);
        this.live.set(thread.childSessionId, threadId);
        const updated = await this.updateThread(threadId, (draft) => {
          draft.status = 'running';
          draft.feedbackPrompt = undefined;
          draft.updatedAt = this.clock.now();
        });
        return { thread: updated, message: `resumed ${threadId} with your decision` };
      }
      case 'interrupt': {
        await this.threads.interrupt(thread.childSessionId);
        const updated = await this.updateThread(threadId, (draft) => {
          draft.status = 'queued';
          draft.updatedAt = this.clock.now();
        });
        return { thread: updated, message: `interrupted ${threadId}` };
      }
      case 'retry': {
        await this.refuseWhilePaused('retry a thread');
        const manifest = await this.requireManifest();
        await this.checkoutFor(thread);
        await this.threads.resume(
          parent,
          thread.childSessionId,
          payload ?? 'Your previous attempt stopped before finishing. Resume the task from where it stopped, verify your work, and report what remains.',
          signal,
        );
        this.live.set(thread.childSessionId, threadId);
        this.watermarks.set(thread.childSessionId, markSeen(manifest, {}));
        const updated = await this.updateThread(threadId, (draft) => {
          draft.status = 'running';
          draft.lastError = undefined;
          draft.updatedAt = this.clock.now();
          draft.healAttempts = 0;
          draft.consecutiveFails = 0;
          draft.failureSignature = undefined;
        });
        return { thread: updated, message: `retried ${threadId}` };
      }
      case 'close': {
        // Marking done is `resolved`, not `completed`: `completed` means "the thread
        // finished and nothing is pending", which is exactly what the user is overriding
        // when they close a thread that still has a PR open. `resolved` is the state that
        // says a human made the call, and it is the one that can be reopened.
        const updated = await this.updateThread(threadId, (draft) => {
          draft.status = 'resolved';
          draft.note = payload ?? 'resolved by user';
          draft.updatedAt = this.clock.now();
        });
        return { thread: updated, message: `resolved ${threadId}` };
      }
      case 'reopen': {
        const updated = await this.updateThread(threadId, (draft) => {
          // Back to what the thread's own evidence supports: a PR means it is awaiting
          // review again; otherwise the work is simply finished and idle. Guessing a live
          // state would make a reopened thread look like it is running.
          draft.status = draft.prOrDeliverableRef === undefined ? 'completed' : 'awaiting_review';
          draft.note = payload ?? 'reopened by user';
          draft.updatedAt = this.clock.now();
        });
        return { thread: updated, message: `reopened ${threadId}` };
      }
      case 'merge': {
        // The Host does not run `gh pr merge`. Only the thread knows whether the branch needs
        // a rebase first, which checks are actually green, and what to clean up afterwards; a
        // host-side merge would report success on a branch the thread still believes is open.
        const prUrl = thread.prOrDeliverableRef;
        if (prUrl === undefined) {
          throw new ProjectError('INVALID_INPUT', `${threadId} has no pull request to merge`, { threadId });
        }
        await this.refuseWhilePaused('merge a pull request');
        this.assertApproved(thread, ['merge'], 'merging this pull request');
        await this.checkoutFor(thread);
        await this.threads.resume(parent, thread.childSessionId, renderMergeRequest(thread, { prUrl }), signal);
        this.live.set(thread.childSessionId, threadId);
        const updated = await this.updateThread(threadId, (draft) => {
          draft.status = 'landing';
          draft.note = payload ?? 'asked the thread to merge its pull request';
          draft.updatedAt = this.clock.now();
        });
        return { thread: updated, message: `asked ${threadId} to merge ${prUrl}` };
      }
      case 'conflicts': {
        const prUrl = thread.prOrDeliverableRef;
        if (prUrl === undefined) {
          throw new ProjectError('INVALID_INPUT', `${threadId} has no pull request to resolve conflicts against`, { threadId });
        }
        await this.refuseWhilePaused('wake a thread for conflicts');
        const cwd = await this.checkoutFor(thread);
        const base = (await this.conflictBase(cwd, prUrl)) ?? 'main';
        const files = await this.conflictCandidates(thread, cwd, base);
        await this.threads.resume(
          parent,
          thread.childSessionId,
          renderConflictRequest(thread, { base, files, prUrl }),
          signal,
        );
        this.live.set(thread.childSessionId, threadId);
        const updated = await this.updateThread(threadId, (draft) => {
          draft.status = 'running';
          draft.note = `resolving conflicts with ${base}`;
          draft.updatedAt = this.clock.now();
        });
        return {
          thread: updated,
          message: `asked ${threadId} to resolve conflicts with ${base}${files.length === 0 ? '' : ` (${String(files.length)} likely file(s))`}`,
        };
      }
      case 'review': {
        // No wake-up: the answer is a link. Handing the URL back lets the Host render it as a
        // clickable reference instead of spending a thread turn on "here is your own PR".
        const prUrl = thread.prOrDeliverableRef;
        if (prUrl === undefined) {
          throw new ProjectError('INVALID_INPUT', `${threadId} has no pull request to review`, { threadId });
        }
        return { thread, message: `${prUrl}` };
      }
      case 'unwatch': {
        // Polling is the only thing this stops: the branch, the PR and the descriptor all
        // stay. A merged pull request whose branch was deleted is the usual reason to want
        // this by hand, and re-enabling it must not require recreating the thread.
        const updated = await this.updateThread(threadId, (draft) => {
          draft.unwatchAt = this.clock.now();
          draft.updatedAt = this.clock.now();
        });
        return { thread: updated, message: `stopped polling ${threadId} for CI and review state` };
      }
      case 'watch': {
        const updated = await this.updateThread(threadId, (draft) => {
          draft.unwatchAt = undefined;
          draft.consecutiveFails = 0;
          draft.updatedAt = this.clock.now();
        });
        return { thread: updated, message: `resumed polling ${threadId} for CI and review state` };
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Self-healing
  // ---------------------------------------------------------------------------

  /**
   * Poll every thread that has a PR and act on what it finds.
   *
   * One sweep = one `gh` round per thread. Network failures are collected, not thrown:
   * a flaky GitHub must never take the whole watcher down. Threads the user (or a merge)
   * unsubscribed are skipped before any command runs, because polling a finished pull
   * request forever is how a watcher turns into a source of noise and rate limits.
   */
  async healSweep(parent: object, signal: AbortSignal = AbortSignal.timeout(120_000)): Promise<HealSweepResult> {
    this.noteCaller(parent);
    const manifest = await this.requireManifest();
    if (manifest.pausedAt !== undefined) {
      // Reported rather than thrown: the background watcher calls this on a timer, and a
      // throwing sweep would fill the log with one stack per poll while the project sits
      // paused by design.
      return {
        observed: 0,
        resolved: 0,
        healed: [],
        escalated: [],
        settled: [],
        waiting: [],
        errors: [],
        paused: manifest.pauseReason ?? 'project is paused',
      };
    }
    const result: HealSweepResult = {
    observed: 0,
    resolved: 0,
    healed: [],
    escalated: [],
    settled: [],
    waiting: [],
    errors: [],
  };
    // The week-of-silence rule runs before the poll selection, so a thread that just went
    // quiet is resolved instead of being polled one last time. It is a write, so it belongs
    // here rather than in `buildOverview` — a panel render must never mutate the record.
    result.resolved = await this.autoResolveIdle(this.clock.now());
    const candidates = Object.values(manifest.threads).filter(
      (thread) =>
        thread.unwatchAt === undefined &&
        thread.branch !== undefined &&
        // `landing` stays in the set: the only way to learn that a queued merge finished is
        // to keep looking. `resolved` is excluded — it is done, and polling it forever is
        // how a watcher turns into noise.
        (thread.status === 'awaiting_review' ||
          thread.status === 'ci_fixing' ||
          thread.status === 'running' ||
          thread.status === 'landing'),
    );

    for (const thread of candidates) {
      if (signal.aborted) break;
      try {
        const action = await this.observeOne(parent, thread, signal);
        result.observed += 1;
        switch (action.kind) {
          case 'heal':
            result.healed.push(await this.requireThread(thread.threadId));
            break;
          case 'escalate':
            result.escalated.push(await this.requireThread(thread.threadId));
            break;
          case 'transition':
            result.settled.push(await this.requireThread(thread.threadId));
            break;
          case 'wait':
            result.waiting.push(await this.requireThread(thread.threadId));
            break;
          case 'none':
            break;
        }
      } catch (error) {
        result.errors.push({ threadId: thread.threadId, message: describeError(error) });
      }
    }
    return result;
  }

  /**
   * Settle a thread whose pull request can no longer be read.
   *
   * Reaching here means `gh` said the pull request or branch is gone, which in practice is
   * what a merged pull request with a deleted branch looks like. Guessing "merged" would be
   * convenient and occasionally wrong, so the state is re-read by number first and only a
   * real `merged`/`closed` answer settles the thread automatically. Anything else becomes a
   * question with the raw message attached, and polling stops either way.
   */
  private async settleUnreachable(thread: ProjectThreadDescriptor, prRef: string, message: string): Promise<HealAction> {
    const cwd = thread.worktreePath ?? this.rootDir;
    const prNumber = Number.parseInt(/\/(\d+)(?:$|\?)/.exec(prRef)?.[1] ?? '', 10);
    let state: ProjectReviewSnapshot['state'] = 'unknown';
    if (Number.isFinite(prNumber)) {
      const raw = await readPrState(this.runner, cwd, prNumber).catch(() => undefined);
      if (raw !== undefined) state = normalisePrState(raw);
    }
    const now = this.clock.now();
    if (state === 'merged' || state === 'closed') {
      const status: ThreadStatus = state === 'merged' ? 'completed' : 'failed';
      await this.updateThread(thread.threadId, (draft) => {
        draft.status = status;
        draft.unwatchAt = now;
        draft.lastError = status === 'failed' ? `pull request ${prRef} was closed without merging` : undefined;
        draft.updatedAt = now;
      });
      return { kind: 'transition', status, reason: `pull request ${prRef} is ${state}` };
    }
    const question = `the pull request for this thread (${prRef}) can no longer be reached: ${message.trim()}. It was probably merged with its branch deleted. Reply with the outcome to settle the thread, or run \`/project thread ${thread.threadId} watch\` to resume polling.`;
    await this.updateThread(thread.threadId, (draft) => {
      draft.status = 'needs_feedback';
      draft.feedbackPrompt = question;
      draft.unwatchAt = now;
      draft.updatedAt = now;
    });
    return { kind: 'escalate', reason: `pull request ${prRef} is unreachable: ${message.trim()}`, question };
  }

  /** Observe one thread's PR and apply the decided action. */
  private async observeOne(parent: object, thread: ProjectThreadDescriptor, signal: AbortSignal): Promise<HealAction> {
    const cwd = thread.worktreePath ?? this.rootDir;
    const branch = thread.branch;
    if (branch === undefined) return { kind: 'none', reason: 'thread has no branch' };

    const checks = await readChecks(this.runner, cwd, branch);
    const checkStates = toCheckStates(checks.checks);
    const prRef = thread.prOrDeliverableRef ?? branch;
    const prNumber = Number.parseInt(/\/(\d+)(?:$|\?)/.exec(prRef)?.[1] ?? '', 10);

    let comments: ProjectReviewSnapshot['comments'] = [];
    let prState: ProjectReviewSnapshot['state'] = 'open';
    const ghFailures: string[] = [];
    if (checks.error !== undefined) ghFailures.push(checks.error);
    if (Number.isFinite(prNumber)) {
      const [inline, verdicts, state] = await Promise.all([
        readReviewComments(this.runner, cwd, prNumber),
        readReviewVerdicts(this.runner, cwd, prNumber),
        readPrState(this.runner, cwd, prNumber),
      ]);
      if (inline.error !== undefined) ghFailures.push(inline.error);
      if (verdicts.error !== undefined) ghFailures.push(verdicts.error);
      if (state !== undefined) prState = normalisePrState(state);
      comments = toReviewComments(inline.comments);
      const changed = verdicts.reviews.filter((review) => review.state === 'CHANGES_REQUESTED');
      for (const review of changed) {
        if (review.body === undefined || review.body.trim().length === 0) continue;
        comments.push({
          id: `review-${String(review.id)}`,
          author: review.user?.login ?? 'reviewer',
          body: review.body.trim(),
          createdAt: this.clock.now(),
        });
      }
    }

    // A `gh` failure is not the same event as "nothing to report". Before this split, an
    // expired token, a rate limit and a deleted branch all arrived as the same empty string
    // list, and each one read as a healthy pull request with no checks — a thread stuck in
    // `awaiting_review` for good, with nothing recorded to explain it.
    if (ghFailures.length > 0) {
      const terminal = ghFailures.filter((message) => classifyGhFailure(message) === 'terminal');
      if (terminal.length > 0) return this.settleUnreachable(thread, prRef, terminal.join('; '));
      const retryable = ghFailures.filter((message) => classifyGhFailure(message) === 'retryable');
      if (retryable.length > 0) {
        throw new ProjectError(
          'VCS_FAILED',
          `could not read pull request state for ${thread.threadId}: ${retryable.join('; ')}`,
        );
      }
      // Only benign messages (no CI configured, nothing run yet) reach the decision below.
    }

    // A PR that was merged or closed settles the thread before check noise matters.
    const previous = thread.review;
    const snapshot = mergeSnapshot(previous, {
      prRef,
      state: prState,
      checks: checkStates,
      comments,
      now: this.clock.now(),
    });

    const signature = failureSignature(snapshot.checks);
    const freshComment = snapshot.comments.some((comment) => !snapshot.consumedCommentIds.includes(comment.id));
    // Same failing set with nothing new said about it means the last round did not fix it.
    // A different set, or a new comment, means the previous round moved the problem along.
    const continuing = signature.length > 0 && signature === thread.failureSignature && !freshComment;

    const input = {
      prState: snapshot.state,
      checks: snapshot.checks,
      comments: snapshot.comments,
      consumedCommentIds: snapshot.consumedCommentIds,
      consecutiveFails: continuing ? (thread.consecutiveFails ?? 0) : 0,
      healAttempts: thread.healAttempts ?? 0,
      threadTitle: thread.title,
      prRef,
    };
    const decision = decideHealAction(input);
    // The gate has to reach the healing prompt too, otherwise the one turn most likely to push
    // is the one turn that skipped the approval.
    const action =
      decision.kind === 'heal' && this.requireApprovalFor.includes('push')
        ? { ...decision, prompt: buildHealPrompt(input, snapshot.checks.filter((check) => check.conclusion === 'fail'), snapshot.comments.filter((comment) => !snapshot.consumedCommentIds.includes(comment.id)), undefined, this.requireApprovalFor) }
        : decision;

    if (action.kind === 'transition') {
      await this.updateThread(thread.threadId, (draft) => {
        draft.status = action.status;
        draft.review = snapshot;
        // Merged and closed are end states: the pull request cannot change again, so
        // continuing to poll it costs a `gh` round per sweep forever and can only report
        // the same answer.
        draft.unwatchAt = this.clock.now();
        draft.updatedAt = this.clock.now();
      });
      return action;
    }
    if (action.kind === 'wait' || action.kind === 'none') {
      await this.updateThread(thread.threadId, (draft) => {
        draft.review = snapshot;
      });
      return action;
    }
    if (action.kind === 'escalate') {
      await this.updateThread(thread.threadId, (draft) => {
        draft.status = 'needs_feedback';
        draft.feedbackPrompt = action.question;
        draft.review = snapshot;
        draft.updatedAt = this.clock.now();
      });
      return action;
    }

    // heal: wake the thread with the evidence, and remember which comments were sent.
    const consumed = [...snapshot.consumedCommentIds, ...snapshot.comments.filter((comment) => !snapshot.consumedCommentIds.includes(comment.id)).map((comment) => comment.id)];
    // Delivery may have reclaimed the checkout; the heal turn runs in the same path, so it has
    // to exist before the wake-up rather than after it.
    await this.checkoutFor(thread);
    await this.threads.resume(parent, thread.childSessionId, action.prompt, signal);
    this.live.set(thread.childSessionId, thread.threadId);
    await this.updateThread(thread.threadId, (draft) => {
      draft.status = 'ci_fixing';
      draft.healAttempts = (draft.healAttempts ?? 0) + 1;
      draft.consecutiveFails = input.consecutiveFails + 1;
      draft.failureSignature = signature;
      draft.review = { ...snapshot, consumedCommentIds: consumed };
      draft.updatedAt = this.clock.now();
    });
    return action;
  }

  // ---------------------------------------------------------------------------
  // Overview
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Project knowledge
  // ---------------------------------------------------------------------------

  /**
   * Rebuild the search index from the bound knowledge paths.
   *
   * The index is derived state: rewritten from the files every time, never edited by hand,
   * and never the source a thread answers from. It feeds two things — the catalogue the
   * charter lists, and `project_knowledge_search` — while the bodies stay on disk, which is
   * why there is no context budget here and nothing to switch between.
   */
  async buildKnowledge(options: { signal?: AbortSignal } = {}): Promise<KnowledgeState> {
    const manifest = await this.requireManifest();

    const collected = await collectKnowledge(manifest.knowledgePaths, {
      rootDir: manifest.rootDir,
      maxChars: MAX_KNOWLEDGE_INDEX_CHARS,
      maxFiles: MAX_KNOWLEDGE_FILES,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    const index = buildIndex(collected.documents, manifest.knowledgePaths, this.clock.now());
    const warnings = [...collected.warnings];
    if (index.docs.length === 0 && manifest.knowledgePaths.length > 0) {
      warnings.push(
        'no readable text was found under the bound knowledge paths; if they are folders, check that the files are text and not excluded build output',
      );
    }
    await writeIndexFile(this.store.paths.knowledgeIndexPath, index);
    this.knowledgeCache = { index, state: resolveKnowledgeState(index, warnings) };
    // The charter lists the catalogue, so a rebuild changes the prefix.
    await this.renderCharter().catch(() => undefined);
    return this.knowledgeCache.state;
  }

  /** Read the built index from disk without collecting files. */
  async loadKnowledge(): Promise<KnowledgeState> {
    const stored = await readIndexFile(this.store.paths.knowledgeIndexPath);
    const index = stored ?? emptyIndex([], this.clock.now());
    const state = resolveKnowledgeState(index);
    this.knowledgeCache = { index, state };
    return state;
  }

  /**
   * Current knowledge state, loading from disk once per engine instance.
   *
   * Cheap enough to call on every overview render: after the first call it is memory-only.
   */
  async knowledgeState(): Promise<{ index: KnowledgeIndex; state: KnowledgeState }> {
    if (this.knowledgeCache !== undefined) return this.knowledgeCache;
    const stored = await readIndexFile(this.store.paths.knowledgeIndexPath);
    const index = stored ?? emptyIndex([], this.clock.now());
    this.knowledgeCache = { index, state: resolveKnowledgeState(index) };
    return this.knowledgeCache;
  }

  /** Retrieve the passages most relevant to `query`. */
  async searchProjectKnowledge(
    query: string,
    options: { limit?: number } = {},
  ): Promise<{ hits: KnowledgeHit[]; state: KnowledgeState; rootDir: string }> {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      throw new ProjectError('INVALID_INPUT', 'query must not be empty');
    }
    const manifest = await this.requireManifest();
    const { index, state } = await this.knowledgeState();
    const hits = searchKnowledge(index, trimmed, {
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
    // The root travels with the hits because a hit cites a path relative to it, and the caller
    // is usually a thread whose working directory is its own worktree — where that path means
    // something else, or nothing at all.
    return { hits, state, rootDir: manifest.rootDir };
  }

  /** Replace the bound knowledge paths and rebuild. */
  async setKnowledgePaths(paths: readonly string[]): Promise<KnowledgeState> {
    const normalised: string[] = [];
    for (const path of paths) {
      const trimmed = path.trim();
      if (trimmed.length === 0) continue;
      if (!normalised.includes(trimmed)) normalised.push(trimmed);
    }
    await this.store.update((draft) => {
      draft.knowledgePaths = normalised;
      return { manifest: draft, result: undefined };
    });
    this.knowledgeCache = undefined;
    return this.buildKnowledge();
  }

  /** Add paths to the bound set and rebuild. Returns the paths actually added. */
  async addKnowledgePaths(paths: readonly string[]): Promise<{ added: string[]; state: KnowledgeState }> {
    const manifest = await this.requireManifest();
    const added: string[] = [];
    for (const path of paths) {
      const trimmed = path.trim();
      if (trimmed.length === 0) continue;
      if (manifest.knowledgePaths.includes(trimmed) || added.includes(trimmed)) continue;
      added.push(trimmed);
    }
    if (added.length === 0) {
      return { added, state: await this.loadKnowledge() };
    }
    const next = [...manifest.knowledgePaths, ...added];
    return { added, state: await this.setKnowledgePaths(next) };
  }

  /** Remove paths from the bound set and rebuild. Returns the paths actually removed. */
  async removeKnowledgePaths(paths: readonly string[]): Promise<{ removed: string[]; state: KnowledgeState }> {
    const manifest = await this.requireManifest();
    const removed = manifest.knowledgePaths.filter((path) => paths.some((p) => p.trim() === path));
    if (removed.length === 0) {
      return { removed, state: await this.loadKnowledge() };
    }
    const next = manifest.knowledgePaths.filter((path) => !removed.includes(path));
    return { removed, state: await this.setKnowledgePaths(next) };
  }

  /** Structured overview for the tool result. */
  async overview(warnings: string[] = [], options: { includeResolved?: boolean } = {}): Promise<ProjectOverview> {
    const manifest = await this.requireManifest();
    const collected = [...warnings];
    if (!this.threads.available()) {
      const reason = this.threads.unavailableReason?.();
      if (reason !== undefined) collected.push(reason);
    }
    const now = this.clock.now();
    const projectWarning = quotaWarning(quotaState(manifest, now), "this project's daily thread preference");
    if (projectWarning !== undefined) collected.push(projectWarning);
    // The enforced cap is user-wide, so the panel has to warn on the shared ledger too: a
    // project sitting at 3/200 of its own preference can still be unable to start a thread.
    const global = await this.ledger.snapshot(manifest.projectId, now).catch(() => undefined);
    if (global !== undefined) {
      const globalWarning = quotaWarning(
        { day: global.day, created: global.created, max: global.max },
        'daily thread quota across all projects',
      );
      if (globalWarning !== undefined) collected.push(globalWarning);
    }
    const overview = buildOverview(manifest, this.clock.now(), collected, {
      ...options,
      ...(this.requireApprovalFor.length === 0 ? {} : { approvalsRequired: this.requireApprovalFor }),
    });
    if (global === undefined) return overview;
    return { ...overview, quota: { ...overview.quota, global: { created: global.created, max: global.max } } };
  }

  /**
   * Stop the project: no new threads, no sweeps, no delivery, live threads interrupted.
   *
   * The local equivalent of the official Pause. It exists because this plugin runs on the
   * user's own machine: "I need the CPU and the network for something else" is a request that
   * comes up far more often than archiving, and until now the only way to honour it was to
   * disable the plugin.
   */
  async pause(parent: object, reason?: string): Promise<{ interrupted: string[] }> {
    this.noteCaller(parent);
    const manifest = await this.requireManifest();
    const active = Object.values(manifest.threads).filter(
      (thread) => thread.status === 'running' || thread.status === 'ci_fixing' || thread.status === 'queued',
    );
    const now = this.clock.now();
    await this.store.update((draft) => {
      draft.pausedAt = now;
      if (reason === undefined) delete draft.pauseReason;
      else draft.pauseReason = reason;
      for (const thread of active) {
        const live = draft.threads[thread.threadId];
        if (live !== undefined && live.status === 'running') live.note = 'interrupted by pause';
      }
      return { manifest: draft, result: undefined };
    });
    // Interrupt after the record says paused: a thread that observes its own abort and tries
    // to heal would otherwise be able to start one more round.
    const interrupted: string[] = [];
    for (const thread of active) {
      if (!this.threads.isLive(thread.childSessionId)) continue;
      await this.threads.interrupt(thread.childSessionId).catch(() => undefined);
      interrupted.push(thread.threadId);
    }
    await this.publishState();
    return { interrupted };
  }

  /** The pause record, if the project is paused. */
  async paused(): Promise<{ since: number; reason?: string } | undefined> {
    const snapshot = await this.store.tryRead();
    if (snapshot?.manifest.pausedAt === undefined) return undefined;
    return {
      since: snapshot.manifest.pausedAt,
      ...(snapshot.manifest.pauseReason === undefined ? {} : { reason: snapshot.manifest.pauseReason }),
    };
  }

  /** Resume a paused project. Threads interrupted by the pause stay resumable. */
  async resume(parent?: object): Promise<{ wasPaused: boolean }> {
    if (parent !== undefined) this.noteCaller(parent);
    const manifest = await this.requireManifest();
    if (manifest.pausedAt === undefined) return { wasPaused: false };
    await this.store.update((draft) => {
      delete draft.pausedAt;
      delete draft.pauseReason;
      return { manifest: draft, result: undefined };
    });
    await this.publishState();
    return { wasPaused: true };
  }

  /**
   * Refuse to advance work while paused.
   *
   * Read-only actions stay available: a user who paused the project to answer a question or
   * close a thread should not have to resume first.
   */
  /** Actions this project gates on human sign-off. */
  approvalsRequired(): ApprovalAction[] {
    return [...this.requireApprovalFor];
  }

  /**
   * Record a human sign-off for one action on one thread.
   *
   * Grants live on the descriptor rather than in a turn-scoped variable: a permission that
   * vanished on reload would be asked for again after every restart, and a prompt people have
   * to answer repeatedly is a prompt they learn to answer without reading.
   */
  async approve(threadId: string, action: ApprovalAction, approver = 'user'): Promise<ProjectThreadDescriptor> {
    const thread = await this.requireThread(threadId);
    if (!APPROVAL_ACTIONS.includes(action)) {
      throw new ProjectError('INVALID_INPUT', `unknown approval action \`${action}\`; expected one of ${APPROVAL_ACTIONS.join(', ')}`, { threadId, action });
    }
    return this.updateThread(threadId, (draft) => {
      draft.approvals = { ...draft.approvals, [action]: this.clock.now() };
      draft.note = `approved ${action} by ${approver}`;
      draft.updatedAt = this.clock.now();
    }).then(() => this.requireThread(thread.threadId));
  }

  /**
   * Refuse a gated action until every required grant is present.
   *
   * Refusing rather than proceeding-with-a-warning is the point: the action is irreversible, so
   * a missing grant has to be an error the caller can see, not a footnote in a log.
   */
  private assertApproved(thread: ProjectThreadDescriptor, actions: readonly ApprovalAction[], verb: string): void {
    const missing = actions.filter(
      (action) => this.requireApprovalFor.includes(action) && thread.approvals?.[action] === undefined,
    );
    if (missing.length === 0) return;
    throw new ProjectError(
      'APPROVAL_REQUIRED',
      `${verb} needs sign-off for ${missing.join(' + ')}; ask the user, then run \`/project thread ${thread.threadId} approve ${missing[0] ?? ''}\``,
      { threadId: thread.threadId, missing },
    );
  }

  private async refuseWhilePaused(action: string): Promise<void> {
    const manifest = await this.requireManifest();
    if (manifest.pausedAt === undefined) return;
    const reason = manifest.pauseReason === undefined ? '' : `: ${manifest.pauseReason}`;
    throw new ProjectError(
      'PROJECT_PAUSED',
      `project is paused${reason}; \`/project resume\` before you ${action}`,
      { pausedAt: manifest.pausedAt, action },
    );
  }

  /** Buckets plus thread descriptors as a plain JSON value (tool output). */
  async overviewJson(options: { includeResolved?: boolean } = {}): Promise<Record<string, unknown>> {
    const overview = await this.overview([], options);
    const knowledge = await this.knowledgeState().catch(() => undefined);
    const buckets: Partial<Record<OverviewBucket, ProjectThreadDescriptor[]>> = overview.buckets;
    return {
      projectId: overview.projectId,
      name: overview.name,
      rootDir: overview.rootDir,
      revision: overview.revision,
      quota: overview.quota,
      totals: overview.totals,
      prefixFingerprint: overview.prefixFingerprint,
      warnings: overview.warnings,
      memories: overview.memories,
      ...(overview.paused === undefined ? {} : { paused: overview.paused }),
      ...(overview.approvalsRequired === undefined ? {} : { approvalsRequired: overview.approvalsRequired }),
      knowledge: knowledge === undefined ? undefined : {
        docs: knowledge.state.docs,
        chunks: knowledge.state.chunks,
        totalChars: knowledge.state.totalChars,
        builtAt: knowledge.state.builtAt,
        sources: knowledge.state.sources,
        summary: describeKnowledge(knowledge.state),
      },
      buckets,
    };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Mark threads that have been silent for a week as resolved.
   *
   * Official: resolved happens "automatically after a week with no activity". Activity is
   * anything that writes `updatedAt` — a turn, a heal round, a new review comment — so the
   * rule needs no per-state special cases. Returns how many threads moved.
   *
   * Deliberately not part of `buildOverview`: the panel is a reader, and a render that
   * silently bumps `revision` would fight every other writer.
   */
  private async autoResolveIdle(nowMs: number): Promise<number> {
    const manifest = await this.requireManifest();
    const due = Object.values(manifest.threads).filter((thread) => dueForResolve(thread, nowMs));
    if (due.length === 0) return 0;
    await this.store.update((draft) => {
      for (const stale of due) {
        const thread = draft.threads[stale.threadId];
        if (thread === undefined) continue;
        const days = Math.floor((nowMs - thread.updatedAt) / 86_400_000);
        thread.status = 'resolved';
        thread.note = `resolved automatically after ${days} day(s) without activity`;
        thread.updatedAt = nowMs;
      }
      return { manifest: draft, result: due.length };
    });
    return due.length;
  }

  /** Read-modify-write one thread descriptor under the CAS guard. */
  private async updateThread(
    threadId: string,
    mutate: (thread: ProjectThreadDescriptor) => void,
  ): Promise<ProjectThreadDescriptor> {
    const updated = await this.store.update((draft) => {
      const thread = draft.threads[threadId];
      if (thread === undefined) {
        throw new ProjectError('THREAD_NOT_FOUND', `unknown thread "${threadId}"`, { threadId });
      }
      mutate(thread);
      return { manifest: draft, result: thread };
    });
    // One funnel for every descriptor change, so the panel cannot miss a transition even if
    // a future action forgets to publish explicitly.
    void this.publishState();
    return updated;
  }

  /**
   * The directory a thread's turn must run in, restoring its worktree if delivery reclaimed it.
   *
   * Delivery deletes the checkout once the branch is pushed, because keeping a full checkout
   * for every thread ever delivered grows without bound. The branch survives, so waking a
   * thread means putting the checkout back first: the child session's working directory is that
   * path, and resuming it against a missing directory fails in a way that looks like the
   * thread's own fault.
   */
  private async checkoutFor(thread: ProjectThreadDescriptor): Promise<string> {
    if (thread.worktreePath !== undefined) {
      const restored = await ensureWorktree(
        this.runner,
        this.rootDir,
        thread.branch ?? thread.worktreePath,
        thread.worktreePath,
      );
      if (restored.ok) return thread.worktreePath;
      throw new ProjectError('VCS_FAILED', restored.message, { threadId: thread.threadId });
    }
    if (thread.branch === undefined) return this.rootDir;
    const path = join(projectPaths(this.rootDir).worktreeRoot, thread.threadId);
    const created = await ensureWorktree(this.runner, this.rootDir, thread.branch, path);
    if (!created.ok) throw new ProjectError('VCS_FAILED', created.message, { threadId: thread.threadId });
    await this.updateThread(thread.threadId, (draft) => {
      draft.worktreePath = path;
    });
    return path;
  }

  /** Commit and push one thread's work, then open a PR. */
  async deliverThread(
    threadId: string,
    options: { message?: string; title?: string; body?: string; draft?: boolean } = {},
  ): Promise<{ thread: ProjectThreadDescriptor; prRef?: string; message: string }> {
    await this.refuseWhilePaused('deliver a thread');
    const thread = await this.requireThread(threadId);
    this.assertApproved(thread, ['push', 'pr'], 'delivering this thread');
    const cwd = await this.checkoutFor(thread);
    const commit = await commitAll(this.runner, {
      cwd,
      message: options.message ?? `${thread.title}\n\nthread ${threadId}`,
    });
    // Recorded even when this call commits nothing: the thread may have committed on its
    // own during its turn, and an empty Library would then claim it produced nothing. The
    // diff is taken against the thread's base commit, so it describes the whole branch rather
    // than just this one commit.
    const outputs = await this.readBranchOutputs(thread, cwd);
    if (!commit.committed) {
      const unchanged =
        outputs === undefined
          ? thread
          : await this.updateThread(threadId, (draft) => {
              draft.outputs = outputs;
              draft.outputsAt = this.clock.now();
            });
      return { thread: unchanged, message: 'nothing to commit' };
    }
    if (thread.branch === undefined) {
      const updated = await this.updateThread(threadId, (draft) => {
        draft.status = 'completed';
        draft.note = `committed ${commit.commit ?? ''}`.trim();
        draft.updatedAt = this.clock.now();
        if (outputs !== undefined) {
          draft.outputs = outputs;
          draft.outputsAt = this.clock.now();
        }
      });
      return { thread: updated, message: `committed ${commit.commit ?? ''} (no branch to push)`.trim() };
    }

    const pushed = await pushBranch(this.runner, cwd, thread.branch);
    if (!pushed) throw new ProjectError('VCS_FAILED', `could not push branch ${thread.branch}`);
    const created = await createPullRequest(this.runner, {
      cwd,
      branch: thread.branch,
      title: options.title ?? thread.title,
      body: options.body ?? `Automated thread \`${threadId}\`.\n\n${thread.objective}`,
      ...(options.draft === undefined ? {} : { draft: options.draft }),
    });
    if (!created.ok) throw new ProjectError('VCS_FAILED', created.message);

    // The branch is pushed and the pull request exists, so the checkout is now redundant: its
    // commits live on the remote. Reclaiming it here (rather than in a separate sweep) is what
    // keeps disk use proportional to the threads in flight instead of the threads ever run.
    const reclaim =
      thread.worktreePath === undefined
        ? undefined
        : await removeWorktree(this.runner, this.rootDir, thread.worktreePath);
    const updated = await this.updateThread(threadId, (draft) => {
      draft.status = 'awaiting_review';
      draft.prOrDeliverableRef = created.pr.url;
      draft.updatedAt = this.clock.now();
      if (outputs !== undefined) {
        draft.outputs = outputs;
        draft.outputsAt = this.clock.now();
      }
      if (reclaim?.removed === true) {
        // The Library keeps `outputs`, so "what did this thread produce" survives the deletion.
        delete draft.worktreePath;
        draft.note = 'worktree reclaimed after delivery';
      } else if (reclaim?.warning !== undefined) {
        draft.note = reclaim.warning;
      }
    });
    const message =
      reclaim?.warning === undefined
        ? `opened ${created.pr.url}`
        : `opened ${created.pr.url} (${reclaim.warning})`;
    return { thread: updated, prRef: created.pr.url, message };
  }
  /** The branch this thread's pull request targets, when GitHub will tell us. */
  private async conflictBase(cwd: string, prUrl: string): Promise<string | undefined> {
    const prNumber = Number.parseInt(/\/(\d+)(?:$|\?)/.exec(prUrl)?.[1] ?? '', 10);
    if (!Number.isFinite(prNumber)) return undefined;
    return readPrBase(this.runner, cwd, prNumber);
  }

  /**
   * Files both sides touched since they diverged.
   *
   * These are candidates, not confirmed conflicts: git only knows the real ones when it tries
   * the merge. Reporting them narrows where to look without pretending to be authoritative.
   */
  private async conflictCandidates(
    thread: ProjectThreadDescriptor,
    cwd: string,
    base: string,
  ): Promise<string[]> {
    if (thread.baseCommit === undefined) return [];
    // `origin/<base>` is what a pull request actually compares against; the local branch may
    // be stale or absent in a worktree that never fetched.
    const fork =
      (await mergeBase(this.runner, cwd, thread.baseCommit, `origin/${base}`)) ??
      (await mergeBase(this.runner, cwd, thread.baseCommit, base));
    if (fork === undefined) return [];
    const [mine, theirs] = await Promise.all([
      readChangedFiles(this.runner, cwd, fork, thread.branch ?? 'HEAD'),
      readChangedFiles(this.runner, cwd, fork, `origin/${base}`),
    ]);
    if (mine === undefined || theirs === undefined) return [];
    const theirsPaths = new Set(theirs.filter((file) => file.change !== 'deleted').map((file) => file.path));
    return mine
      .filter((file) => file.change !== 'deleted' && theirsPaths.has(file.path))
      .map((file) => file.path)
      .sort();
  }

  /**
   * What this thread's branch changed relative to its base commit.
   *
   * `undefined` when the question cannot be answered (no base commit recorded, or git
   * refused the range). The caller keeps the previous observation in that case rather than
   * overwriting it with an empty list, because "we could not look" is not "nothing changed".
   */
  private async readBranchOutputs(
    thread: ProjectThreadDescriptor,
    cwd: string,
  ): Promise<ProjectOutputFile[] | undefined> {
    if (thread.baseCommit === undefined) return undefined;
    const tip = thread.branch ?? 'HEAD';
    return readChangedFiles(this.runner, cwd, thread.baseCommit, tip);
  }

  /** Every file any thread has produced, one row per path. */
  async library(): Promise<ProjectLibraryEntry[]> {
    const manifest = await this.requireManifest();
    return aggregateLibrary(Object.values(manifest.threads));
  }

  /**
   * Read one produced file out of the thread's own worktree.
   *
   * The bytes are read on demand rather than copied into the project record: on a local host
   * the worktree already is the storage, and copying every produced file would double the disk
   * cost of a thread for a file nobody may ever open. When the worktree is gone the read says
   * so instead of returning an empty string, which reads as "the file is empty" — a different
   * and false statement.
   */
  async readOutputFile(path: string, threadId?: string): Promise<OutputReadResult> {
    const manifest = await this.requireManifest();
    const named = threadId === undefined ? undefined : manifest.threads[threadId];
    if (threadId !== undefined && named === undefined) {
      throw new ProjectError('THREAD_NOT_FOUND', `unknown thread ${threadId}`, { threadId });
    }
    const owner = named ?? this.threadProducingPath(manifest, path);
    if (owner !== undefined && owner.worktreePath === undefined && owner.outputs !== undefined) {
      // The Library still knows the file exists; the bytes are on the thread's branch. Reading
      // from the project root would answer with a different revision of the file — or with
      // nothing, which reads as "the thread produced nothing".
      return {
        ok: false,
        path,
        reason: `the thread's worktree was reclaimed after delivery; \`${path}\` lives on branch \`${owner.branch ?? owner.branchOrScope}\` and is readable here only once that branch is merged`,
      };
    }
    const base = owner?.worktreePath ?? manifest.rootDir;
    return readOutputBytes(base, path);
  }

  /** The thread whose worktree most plausibly still holds `path`. */
  private threadProducingPath(
    manifest: ProjectManifest,
    path: string,
  ): ProjectThreadDescriptor | undefined {
    const candidates = Object.values(manifest.threads).filter((thread) =>
      (thread.outputs ?? []).some((output) => output.path === path && output.change !== 'deleted'),
    );
    // Newest first: a file produced twice should be read from the thread that touched it last.
    candidates.sort(
      (left, right) => (right.outputsAt ?? right.updatedAt) - (left.outputsAt ?? left.updatedAt),
    );
    return candidates[0];
  }

}

/**
 * Map `gh pr view`'s state verb onto the snapshot vocabulary.
 *
 * An unrecognised verb becomes `unknown` rather than `open`: claiming a PR is open when
 * GitHub reported something this plugin does not model would keep a settled thread
 * running forever, and `unknown` is the honest input to the heal decision.
 */
export function normalisePrState(raw: string): ProjectReviewSnapshot['state'] {
  const value = raw.trim().toLowerCase();
  if (value === 'open') return 'open';
  if (value === 'draft') return 'draft';
  if (value === 'merged') return 'merged';
  if (value === 'closed') return 'closed';
  return 'unknown';
}

/** An outcome for a call that intentionally delivered nothing. */
export function emptyBroadcast(): BroadcastOutcome {
  return { delivered: [], skipped: [], failed: [] };
}

/** What `broadcastMemory` did. */
export interface BroadcastOutcome {
  delivered: string[];
  skipped: Array<{ threadId: string; reason: string }>;
  failed: Array<{ threadId: string; reason: string }>;
}

/** Derive a readable project name from the root directory. */
export function defaultProjectName(rootDir: string): string {
  const parts = rootDir.split(/[\\/]+/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? 'project';
}

/** Turn a project name into a branch-safe slug. */
export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'project';
}

/** Clamp a configured poll interval into the accepted range. */
export function normalisePollInterval(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_CI_POLL_INTERVAL_MS;
  return Math.max(MIN_CI_POLL_INTERVAL_MS, Math.trunc(value));
}

/** Pull the first GitHub PR URL out of free-form child output. */
export function extractPrUrl(text: string): string | undefined {
  const match = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/.exec(text);
  return match?.[0];
}

/** One-line thread summary for command output. */
export function describeThread(thread: ProjectThreadDescriptor): string {
  const bits = [`\`${thread.threadId}\``, thread.title, `status=${thread.status}`];
  if (thread.branch !== undefined) bits.push(`branch=${thread.branch}`);
  if (thread.worktreePath !== undefined) bits.push(`worktree=${thread.worktreePath}`);
  if (thread.prOrDeliverableRef !== undefined) bits.push(`pr=${thread.prOrDeliverableRef}`);
  if (thread.feedbackPrompt !== undefined) bits.push(`needs=${thread.feedbackPrompt}`);
  if (thread.lastError !== undefined) bits.push(`error=${thread.lastError}`);
  return bits.join(' ');
}

/** Narrow a status to the panel's bucket, re-exported for adapters. */
export { buildOverview };
