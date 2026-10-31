/**
 * Project Beta — shared type contracts.
 *
 * These are the durable, serialisable shapes persisted in
 * `.dsh-project/manifest.json`. Everything here must survive a JSON round-trip:
 * no class instances, no functions, no `undefined` holes in stored objects.
 */

/**
 * Lifecycle of one parallel thread.
 *
 * `completed` is kept as the name of the "finished, nothing pending" state rather than
 * being renamed to `idle`: it is already on disk in every existing manifest, and the
 * rename would buy nothing a comment does not. It maps to the panel's `idle` bucket.
 */
/**
 * An irreversible git action a project may require human sign-off for.
 *
 * Chosen from OFFICIAL's own list ("Don't merge, force-push, or change CI configuration without
 * asking me") plus the two steps that put work in front of other people (`push`, `pr`).
 */
export type ApprovalAction = 'push' | 'pr' | 'merge' | 'force-push';

export type ThreadStatus =
  | 'queued'
  | 'running'
  | 'awaiting_review'
  | 'needs_feedback'
  | 'ci_fixing'
  /** PR approved or queued to merge: the last step belongs to the host, not to us. */
  | 'landing'
  | 'completed'
  | 'failed'
  /** Marked done by the user, by a merged PR, or automatically after a week of silence. */
  | 'resolved';

/**
 * Which bucket a thread belongs to on the overview panel. Kept as a derived
 * mapping (not stored) so the panel can never disagree with `status`.
 *
 * The six names are the official panel's six groups, one-to-one. That is deliberate:
 * a bucket that only exists here is a bucket our users have to learn twice.
 */
export type OverviewBucket =
  | 'ready_for_review'
  | 'waiting_on_you'
  | 'working'
  | 'landing'
  | 'idle'
  | 'resolved';

/** One project-level decision that every thread must know about. */
export interface ProjectMemoryEntry {
  /** Stable lookup key, e.g. `release-window`. */
  key: string;
  /** The rule or decision itself, stated imperatively. */
  decision: string;
  /** Why — prevents threads from "fixing" the decision by accident. */
  rationale: string;
  updatedAt: number;
  /** Per-entry write counter; bumped on every write. */
  revision: number;
  /** `'coordinator'` or the child session id that authored the entry. */
  authorThreadId: string;
}

/** One CI check reported by GitHub (or any CI surface we adapt). */
export interface ProjectCheckState {
  name: string;
  /** `'pass' | 'fail' | 'pending' | 'skipped'` — kept open for new CI verbs. */
  conclusion: string;
  detailsUrl?: string;
}

/** One human review comment attached to the thread's PR. */
export interface ProjectReviewComment {
  /** Stable identity of the comment (GitHub node id or REST id). */
  id: string;
  author: string;
  body: string;
  path?: string;
  line?: number;
  createdAt: number;
}

/** Last observed review/CI snapshot for a thread's PR. */
export interface ProjectReviewSnapshot {
  prRef: string;
  prUrl?: string;
  state: 'open' | 'draft' | 'merged' | 'closed' | 'unknown';
  checks: ProjectCheckState[];
  comments: ProjectReviewComment[];
  /** Highest comment id already consumed by a healing round. */
  consumedCommentIds: string[];
  observedAt: number;
}

/** One background thread: a continuable child session on its own git branch. */
export interface ProjectThreadDescriptor {
  threadId: string;
  /** Durable child session id returned by the subagent runtime. */
  childSessionId: string;
  title: string;
  objective: string;
  /**
   * Human-readable isolation descriptor. For git-isolated threads this is the
   * branch name; for scope-only threads it is the module path.
   */
  branchOrScope: string;
  status: ThreadStatus;
  prOrDeliverableRef?: string;
  /** Question shown to the user when `status === 'needs_feedback'`. */
  feedbackPrompt?: string;
  startedAt: number;
  updatedAt: number;

  // ---- extensions over the original contract -------------------------------

  /** Absolute path of the git worktree backing this thread, when isolated. */
  worktreePath?: string;
  /** Git branch name, when isolated. */
  branch?: string;
  /** Base revision the branch was cut from. */
  baseCommit?: string;
  /** Number of self-healing rounds already attempted over the thread's lifetime. */
  healAttempts?: number;
  /**
   * Healing rounds already spent against the *current* failure signature. Reset when the
   * failure set changes or new review comments arrive, so a long review does not exhaust
   * a budget that is meant to bound a stuck repair.
   */
  consecutiveFails?: number;
  /** Sorted names of the failing checks the last healing round was issued against. */
  failureSignature?: string;
  /**
   * Wall-clock limit for this thread's current run, or absent when it has none.
   *
   * A stuck child session holds `running` forever, and the only cure today is a human noticing.
   * The deadline is enforced by the sweep, which interrupts and hands the thread back as
   * `needs_feedback` — it did not fail, it ran out of time. Refreshed whenever the thread is woken
   * for new work, so a retry gets a whole new window rather than inheriting a stale one.
   */
  deadlineAt?: number;
  /**
   * Set when the thread stops being polled for CI/review state. Merged or closed pull
   * requests set it automatically; `unwatch` sets it by hand. Cleared by `watch`.
   */
  unwatchAt?: number;
  /**
   * Files this thread changed, recorded when it delivered.
   *
   * Stored on the descriptor rather than derived on demand: the worktree can be
   * reclaimed, and the Library has to keep answering "what did this thread produce"
   * after the bytes are gone.
   */
  outputs?: ProjectOutputFile[];
  /**
   * Human sign-offs granted for this thread, keyed by action.
   *
   * Recorded on the descriptor so a grant survives a restart and is visible in the overview: a
   * permission that lives only in one turn's memory would have to be asked for again after every
   * reload, which is exactly how people learn to click "approve" without reading.
   */
  approvals?: Record<string, number>;
  /** When `outputs` was last recorded. */
  outputsAt?: number;
  /** Last observed CI/review snapshot. */
  review?: ProjectReviewSnapshot;
  /** Last error string, for `failed` threads and diagnostics. */
  lastError?: string;
  /** Free-form note shown on the overview panel. */
  note?: string;
}

/** One file a thread produced, as `git diff` reported it. */
export interface ProjectOutputFile {
  /** Path relative to the project root, with forward slashes. */
  path: string;
  change: ProjectOutputChange;
}

/** What happened to a path. */
export type ProjectOutputChange = 'added' | 'modified' | 'deleted';

/** One Library row: a path, what happened to it, and which threads touched it. */
export interface ProjectLibraryEntry {
  path: string;
  change: ProjectOutputChange;
  threads: string[];
}

/** One row of the Pull requests tab. */
export interface ProjectPullRequestRow {
  threadId: string;
  title: string;
  prRef: string;
  url?: string;
  state: ProjectReviewSnapshot['state'];
  /** Check tallies from the last observation. */
  checks: { total: number; passing: number; failing: number; pending: number };
  /** Review comments not yet consumed by a healing round. */
  newComments: number;
  observedAt: number;
}

/** Daily thread-quota ledger. */
export interface ProjectQuotaState {
  /** Local calendar day, `YYYY-MM-DD`. */
  day: string;
  /** Threads created by *this project* on `day`. */
  created: number;
  /**
   * This project's own ceiling.
   *
   * A preference, not the enforced cap: the official wording is that "a limit you ask for is
   * a preference rather than a cap", and the enforced figure is the user-wide one in
   * {@link ProjectQuotaState.global}.
   */
  max: number;
  /**
   * The user-wide ledger reading: "200 new threads per day across your projects".
   *
   * Absent on the synchronous project-only view, which cannot read the shared ledger file.
   */
  global?: {
    /** Threads created across every project on this machine today. */
    created: number;
    /** The enforced daily ceiling. */
    max: number;
  };
}

/**
 * The single durable root record for one project.
 *
 * `revision` is the manifest-level CAS counter: every accepted write bumps it by
 * exactly one, and a write presenting a stale revision is rejected.
 */
export interface ProjectManifest {
  projectId: string;
  name: string;
  revision: number;
  rootDir: string;
  /** Default `.dsh-project/PROJECT_INSTRUCTIONS.md`, falling back to `AGENTS.md`. */
  instructionsPath: string;
  /** Bound static knowledge paths (files or folders). */
  knowledgePaths: string[];
  /** Hard daily ceiling for newly created threads. */
  dailyThreadQuotaMax: number;
  /** Threads created on `quotaDay`. */
  dailyThreadsCreated: number;
  memories: Record<string, ProjectMemoryEntry>;
  threads: Record<string, ProjectThreadDescriptor>;

  // ---- extensions over the original contract -------------------------------

  /** Local day the quota counter belongs to; rollover resets the counter. */
  quotaDay: string;
  createdAt: number;
  updatedAt: number;
  /** Poll cadence for the self-healing watcher, in milliseconds. */
  ciPollIntervalMs: number;
  /** Bumped on every prefix-affecting change (memory set/remove). */
  prefixVersion: number;
  /**
   * How many threads the user would like running at once, or absent for "as many as the work
   * calls for".
   *
   * **A preference, not a cap.** The official spec is explicit that no fixed number exists and
   * that a limit one asks for is "a preference rather than a cap". So this shapes how many
   * threads a single `coordinate` round starts, and never refuses requested work outright: a
   * round always starts at least one thread. See {@link roundBudget}.
   */
  maxConcurrentThreads?: number;
  /**
   * Model id every thread of this project starts on, or absent to inherit the session route.
   *
   * Threads are where the tokens go — the coordinator only routes — so the official
   * guidance is that a thread may run on a cheaper model than the one that planned it.
   * Handed to the Host as `agentOptions.model` at launch; the coordinator's own route is
   * left alone because a plugin cannot change the session it runs in.
   */
  threadModel?: string;
  /**
   * Reasoning effort every thread starts with, or absent to inherit the session route.
   *
   * Opaque on purpose: effort ids belong to each model's route table, so the Host decides
   * at launch whether the pair is valid. A hard-coded list here would drift.
   */
  threadEffort?: string;
  /**
   * When the project was paused, or absent while it runs.
   *
   * Pausing stops everything at once: no new threads, no self-healing sweeps, no delivery,
   * and live threads are interrupted. It is the "I need this machine for something else"
   * switch, so it must survive a restart — hence a stored timestamp rather than a flag.
   */
  pausedAt?: number;
  /**
   * When the project was archived, or absent while it is live.
   *
   * Distinct from {@link pausedAt}: pause is "not right now", archive is "out of the way". Both
   * stop background work, but unarchiving is a deliberate return to the project rather than
   * resuming the same session.
   */
  archivedAt?: number;
  /** Why it was paused, for the panel and for the agent that asks later. */
  pauseReason?: string;
  /**
   * A decomposition proposed but not yet started.
   *
   * Only one at a time, matching the official single **Suggested threads** list. Cleared when
   * every task is started or the user discards it, and dropped automatically once stale —
   * a plan written against code that has since moved is worse than no plan.
   */
  plan?: ProjectPlan;
  /**
   * One line of what the project is trying to get done.
   *
   * Not decoration: it is rendered into the shared charter and shown to the coordinator, so a
   * new session can pick up the direction without the user repeating it. Absent means "no goal
   * set", which is a normal state — the coordinator then works from the tasks it is given.
   */
  goal?: string;
  /**
   * The last few coordinator messages, newest last.
   *
   * Threads and memory already persist; this is the third piece of coordination state that
   * makes a project recoverable from any session. A ring buffer (see `RECENT_MESSAGE_LIMIT`),
   * never a log.
   */
  recentMessages?: RecentMessage[];
}

/** One coordinator message retained for cross-session recovery. */
export interface RecentMessage {
  at: number;
  role: 'coordinator' | 'user' | 'thread';
  text: string;
}

/** On-disk envelope, so the file format can evolve independently of the record. */
export interface ManifestDocument {
  schema: 1;
  manifest: ProjectManifest;
}

/** A read of the project record plus the version the caller must present back. */
export interface ManifestSnapshot {
  manifest: ProjectManifest;
  /** The on-disk version this snapshot was read at (= `manifest.revision`). */
  version: number;
}

/** One unit of work produced by the coordinator's decomposition step. */
export interface PlannedTask {
  title: string;
  objective: string;
  /** Optional module/file path when the task is scope-isolated instead of git-isolated. */
  scopeHint?: string;
}

/** Who produced a decomposition. */
export type PlanOrigin = 'model' | 'fallback';

/**
 * A decomposition waiting for the user's go-ahead.
 *
 * Why a plan is proposed instead of started: when the caller hands over a goal without
 * stating the split, the coordinator has to invent one, and a guessed split costs one
 * worktree, one branch, one child session and one quota unit per line. Proposing turns a
 * wrong guess into "delete three rows" instead of "clean up five branches". A plan the
 * caller authored itself (tasks passed in) is a decision, so it starts immediately.
 */
export interface ProjectPlan {
  /** Local epoch ms when the plan was proposed. */
  plannedAt: number;
  /** Who split the goal. `fallback` means the deterministic planner guessed. */
  origin: PlanOrigin;
  /** Shown to the user verbatim; present when the plan needs explaining. */
  note?: string;
  tasks: PlannedTask[];
}

/**
 * How the project's concurrency preference shaped one round.
 *
 * Reported rather than silently applied: "why did only two of five start" must be answerable
 * from the tool result, and the caller needs to know it was a preference they can override.
 */
export interface ConcurrencyDecision {
  /** The preference in force, as stored on the manifest. */
  preference: number;
  /** Threads already owned by us (queued / running / ci_fixing) when the round began. */
  active: number;
  /** How many threads this round was allowed to start. */
  allowed: number;
  /** One sentence the caller must surface when `allowed` cut the round short. */
  note?: string;
}

/** Result of one `project_coordinate` call. */
export interface CoordinateResult {
  projectId: string;
  planned: PlannedTask[];
  started: ProjectThreadDescriptor[];
  skipped: Array<{ task: PlannedTask; reason: string }>;
  quota: ProjectQuotaState;
  /** True when the round proposed threads and started none. */
  planOnly: boolean;
  /** Who produced the plan. */
  planOrigin: PlanOrigin;
  /** Disclosure the caller must surface, e.g. "the model was unavailable, I guessed". */
  planNote?: string;
  /** Tasks still waiting for a go-ahead, when `planOnly` is true. */
  suggested: PlannedTask[];
  /** Tasks this round left for later because the concurrency preference was reached. */
  deferred?: PlannedTask[];
  /** Present only when a concurrency preference is set. */
  concurrency?: ConcurrencyDecision;
}

/** Result of starting previously proposed tasks. */
export interface SuggestStartResult {
  started: ProjectThreadDescriptor[];
  skipped: Array<{ task: PlannedTask; reason: string }>;
  /** Tasks still waiting; empty once everything was started. */
  remaining: PlannedTask[];
  quota: ProjectQuotaState;
  /** Tasks this round left for later because the concurrency preference was reached. */
  deferred?: PlannedTask[];
  /** Present only when a concurrency preference is set. */
  concurrency?: ConcurrencyDecision;
}

/** A pending decomposition as the panel and the command show it. */
export interface SuggestedPlanView {
  plannedAt: number;
  origin: PlanOrigin;
  note?: string;
  /** True when the plan is past its shelf life and can no longer be started. */
  expired: boolean;
  tasks: PlannedTask[];
}

/** Structured overview returned by the `project_overview` tool. */
export interface ProjectOverview {
  projectId: string;
  name: string;
  rootDir: string;
  /** One line of what the project is trying to get done, when one is set. */
  goal?: string;
  /**
   * The last few coordinator messages, oldest first.
   *
   * Present so a brand-new session can answer "what were we just doing" without the user
   * repeating it. Absent while the ring is empty. Deliberately kept out of the shared charter:
   * it changes every turn and would invalidate the prompt cache threads rely on.
   */
  recentMessages?: RecentMessage[];
  revision: number;
  quota: ProjectQuotaState;
  buckets: Record<OverviewBucket, ProjectThreadDescriptor[]>;
  memories: ProjectMemoryEntry[];
  prefixFingerprint: string;
  /** The proposed decomposition, when one is waiting for a go-ahead. */
  suggested?: SuggestedPlanView;
  /**
   * The concurrency preference in force, absent when the user has not set one.
   *
   * Surfaced on the panel next to the quota lines so "why did only two start" is answerable
   * where the user is looking, not from a settings tab.
   */
  concurrency?: number;
  totals: {
    threads: number;
    /** Threads still owned by us right now (queued / running / ci_fixing). */
    active: number;
    /** Threads whose next move is the user's, however that happened. */
    waitingOnYou: number;
    resolved: number;
    /** True when at least one thread is waiting on you — the panel's dot. */
    needsAttention: boolean;
  };
  /** Present only while the project is paused; carries the reason given at pause time. */
  paused?: { since: number; reason?: string };
  /** Present only while the project is archived. */
  archived?: { since: number };
  /**
   * Irreversible actions this project will not perform without a human sign-off.
   *
   * Absent when nothing is gated, which is the default: an empty array would suggest the
   * project has a gate and it is simply closed.
   */
  approvalsRequired?: ApprovalAction[];
  /**
   * Files threads produced, deduplicated by path.
   *
   * Absent when nothing has been delivered yet: an empty array would claim the Library
   * exists and is empty, which is a different statement from "no thread has delivered".
   */
  library?: ProjectLibraryEntry[];
  /**
   * Pull requests opened by threads, grouped by state.
   *
   * Absent when no thread has a pull request — same reasoning as `library`.
   */
  pullRequests?: Partial<Record<ProjectReviewSnapshot['state'], ProjectPullRequestRow[]>>;
  /** Non-fatal diagnostics worth surfacing to the user. */
  warnings: string[];
}
