/**
 * Project Beta — shared type contracts.
 *
 * These are the durable, serialisable shapes persisted in
 * `.dsh-project/manifest.json`. Everything here must survive a JSON round-trip:
 * no class instances, no functions, no `undefined` holes in stored objects.
 */

/** Lifecycle of one parallel thread. */
export type ThreadStatus =
  | 'queued'
  | 'running'
  | 'awaiting_review'
  | 'needs_feedback'
  | 'ci_fixing'
  | 'completed'
  | 'failed';

/**
 * Which bucket a thread belongs to on the overview panel. Kept as a derived
 * mapping (not stored) so the panel can never disagree with `status`.
 */
export type OverviewBucket =
  | 'completed'
  | 'awaiting_review'
  | 'waiting_for_feedback'
  | 'running'
  | 'failed';

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
  /** Number of self-healing rounds already attempted. */
  healAttempts?: number;
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
  /** Threads created on `day`. */
  created: number;
  /** Hard ceiling, default 200 (aligned with the Projects Beta quota). */
  max: number;
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

/** Result of one `project_coordinate` call. */
export interface CoordinateResult {
  projectId: string;
  planned: PlannedTask[];
  started: ProjectThreadDescriptor[];
  skipped: Array<{ task: PlannedTask; reason: string }>;
  quota: ProjectQuotaState;
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
  totals: {
    threads: number;
    active: number;
    completed: number;
    failed: number;
  };
  /** Non-fatal diagnostics worth surfacing to the user. */
  warnings: string[];
}
