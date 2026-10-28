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
   * Set when the thread stops being polled for CI/review state. Merged or closed pull
   * requests set it automatically; `unwatch` sets it by hand. Cleared by `watch`.
   */
  unwatchAt?: number;
  /** Last observed CI/review snapshot. */
  review?: ProjectReviewSnapshot;
  /** Last error string, for `failed` threads and diagnostics. */
  lastError?: string;
  /** Free-form note shown on the overview panel. */
  note?: string;
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
   * A decomposition proposed but not yet started.
   *
   * Only one at a time, matching the official single **Suggested threads** list. Cleared when
   * every task is started or the user discards it, and dropped automatically once stale —
   * a plan written against code that has since moved is worse than no plan.
   */
  plan?: ProjectPlan;
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
}

/** Result of starting previously proposed tasks. */
export interface SuggestStartResult {
  started: ProjectThreadDescriptor[];
  skipped: Array<{ task: PlannedTask; reason: string }>;
  /** Tasks still waiting; empty once everything was started. */
  remaining: PlannedTask[];
  quota: ProjectQuotaState;
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
  revision: number;
  quota: ProjectQuotaState;
  buckets: Record<OverviewBucket, ProjectThreadDescriptor[]>;
  memories: ProjectMemoryEntry[];
  prefixFingerprint: string;
  /** The proposed decomposition, when one is waiting for a go-ahead. */
  suggested?: SuggestedPlanView;
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
  /** Non-fatal diagnostics worth surfacing to the user. */
  warnings: string[];
}
