/**
 * Command execution port.
 *
 * Git and GitHub work must run in the *same execution world* as the Host's
 * filesystem provider: when a deployment serves files over SSH or inside a
 * container, `node:child_process` would run on the wrong machine entirely. So the
 * engine depends on this port instead of a process API, and the Host adapter backs
 * it with `ctx.subprocess`.
 *
 * Tests substitute an in-memory implementation; nothing else changes.
 */

/** Outcome of one command. */
export interface CommandResult {
  /** Exit code, or `null` when the process was signalled. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Set when the command could not be started at all. */
  spawnError?: string;
}

/** One command invocation. */
export interface CommandSpec {
  /** Executable followed by its arguments; never a shell string. */
  argv: readonly string[];
  cwd: string;
  /** Extra environment entries merged over the inherited environment. */
  env?: Record<string, string>;
  /** Milliseconds before the runner aborts the process. */
  timeoutMs?: number;
  /** Fed to stdin when present. */
  stdin?: string;
}

/** The port the engine talks to. */
export interface CommandRunner {
  run(spec: CommandSpec): Promise<CommandResult>;
}

/** Default per-command timeout: git and gh both occasionally hang on prompts. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

/** Non-zero exit or spawn failure, carrying the captured streams for diagnostics. */
export class CommandError extends Error {
  constructor(
    readonly spec: CommandSpec,
    readonly result: CommandResult,
  ) {
    const detail = result.stderr.trim() || result.stdout.trim() || result.spawnError || 'no output';
    super(`${spec.argv.join(' ')} failed (exit ${String(result.exitCode)}): ${detail}`);
    this.name = 'CommandError';
  }
}

/** Throw when a result is not a clean success. */
export function assertOk(spec: CommandSpec, result: CommandResult): CommandResult {
  if (result.spawnError !== undefined) throw new CommandError(spec, result);
  if (result.exitCode !== 0) throw new CommandError(spec, result);
  return result;
}

/** Run and throw on failure; the common case for git plumbing. */
export async function runChecked(runner: CommandRunner, spec: CommandSpec): Promise<string> {
  return assertOk(spec, await runner.run(spec)).stdout;
}

/**
 * Run and report success without throwing; the shape `gh` probes need because a
 * missing CLI is an expected state, not an engine failure.
 */
export async function runProbe(runner: CommandRunner, spec: CommandSpec): Promise<CommandResult> {
  return runner.run(spec);
}

// ---------------------------------------------------------------------------
// Shared-repository lock contention
// ---------------------------------------------------------------------------

/**
 * Patterns git prints when another process holds a lock in the *same* `.git`.
 *
 * Every worktree of a project shares one object database, one `packed-refs`, and one
 * `.git/worktrees/` directory, so two threads committing at the same instant can collide even
 * though their working trees are separate. That is a scheduling accident, not a bad change:
 * retrying is correct, and reporting it as "your commit failed" would teach the user to distrust
 * every red thread.
 */
const LOCK_CONFLICT_PATTERNS: readonly RegExp[] = [
  /cannot lock ref/i,
  /index\.lock/i,
  /Unable to create '.*\.lock'/i,
  /Lock file already exists/i,
  /Another git process seems to be running/i,
  /could not lock the index/i,
];

/** Is this failure the transient kind that a retry can clear? */
export function isLockConflict(result: CommandResult): boolean {
  const text = `${result.stderr}\n${result.stdout}`;
  return LOCK_CONFLICT_PATTERNS.some((pattern) => pattern.test(text));
}

/** How many times a lock conflict is retried before the failure is reported. */
export const LOCK_RETRY_ATTEMPTS = 3;

/** First backoff step; each retry doubles it. Kept short — the other thread holds the lock briefly. */
export const LOCK_RETRY_BASE_DELAY_MS = 40;

/** Appended to the final failure so the reader knows what to do (wait, not debug). */
export const LOCK_EXHAUSTED_NOTE =
  'the shared repository was busy with another thread for this many attempts; the change itself was not rejected — retry this thread once the other one pauses';

/** Options for {@link withLockRetry}. */
export interface LockRetryOptions {
  /** Attempts including the first try. `1` disables retrying. */
  attempts?: number;
  /** First backoff step in milliseconds. */
  baseDelayMs?: number;
  /** Injected for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected for tests; called with the attempt number that is about to be retried. */
  onRetry?: (attempt: number, result: CommandResult) => void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Wrap a runner so git lock contention is retried instead of surfacing as a failure.
 *
 * A decorator rather than a change to each call site: every git command the engine issues shares
 * the same failure mode, and a lock can be hit by any of them (`branch`, `worktree add`, `add`,
 * `commit`, `push`, `worktree remove`). Wrapping once makes the retry policy uniform and, more
 * importantly, impossible to forget in the next git call someone adds.
 *
 * Only *lock* conflicts retry. A genuine rejection (non-fast-forward, missing credential,
 * failing hook) returns on the first attempt, because retrying it would just delay the truth.
 */
export function withLockRetry(inner: CommandRunner, options: LockRetryOptions = {}): CommandRunner {
  const attempts = Math.max(1, Math.floor(options.attempts ?? LOCK_RETRY_ATTEMPTS));
  const baseDelayMs = Math.max(1, Math.floor(options.baseDelayMs ?? LOCK_RETRY_BASE_DELAY_MS));
  const sleep = options.sleep ?? defaultSleep;
  return {
    async run(spec: CommandSpec): Promise<CommandResult> {
      let last: CommandResult | undefined;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const result = await inner.run(spec);
        last = result;
        const failed = result.spawnError !== undefined || result.exitCode !== 0;
        if (!failed) return result;
        if (!isLockConflict(result)) return result;
        if (attempt === attempts) break;
        options.onRetry?.(attempt, result);
        await sleep(baseDelayMs * 2 ** (attempt - 1));
      }
      if (last === undefined) throw new Error('withLockRetry ran no attempt');
      const detail = last.stderr.trim();
      return {
        ...last,
        stderr: detail.length === 0 ? LOCK_EXHAUSTED_NOTE : `${detail}\n${LOCK_EXHAUSTED_NOTE}`,
      };
    },
  };
}
