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
