/**
 * `CommandRunner` backed by the Host's `subprocess` service.
 *
 * Uses the Host abstraction rather than `node:child_process` so commands execute in
 * the same world as the Host's filesystem — the correct machine under SSH, containers,
 * and remote deployments.
 *
 * Output is read by polling `collected.readFrom(offset)` after exit rather than by
 * attaching stream handlers: `readFrom` is the documented API, and the process is
 * already finished by the time we read, so there is nothing to race.
 */

import { DEFAULT_COMMAND_TIMEOUT_MS, type CommandResult, type CommandRunner, type CommandSpec } from '../core/exec.js';
import type { HostOutputReader, HostSubprocess } from './hostTypes.js';

/** Output cap per stream: enough for a git error, far below the Host spill budget. */
const MAX_STREAM_BYTES = 1_000_000;

/** Read everything a stream produced, discarding a spill notice in favour of the text. */
function drain(reader: HostOutputReader | undefined): string {
  if (reader === undefined) return '';
  let text = '';
  let offset = 0;
  // Loop because a single read may stop at an internal buffer boundary.
  for (let guard = 0; guard < 64; guard += 1) {
    const chunk = reader.readFrom(offset);
    text += chunk.text;
    if (chunk.nextOffset <= offset) break;
    offset = chunk.nextOffset;
    if (chunk.text.length === 0) break;
  }
  return text;
}

/** Create a runner bound to the Host `subprocess` service. */
export function createCommandRunner(subprocess: HostSubprocess): CommandRunner {
  return {
    async run(spec: CommandSpec): Promise<CommandResult> {
      const timeoutMs = spec.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort(new Error(`command timed out after ${String(timeoutMs)}ms`));
      }, timeoutMs);
      try {
        const handle = subprocess.spawn({
          argv: spec.argv,
          cwd: spec.cwd,
          ...(spec.env === undefined ? {} : { env: spec.env }),
          stdio: {
            stdin: spec.stdin === undefined ? 'ignore' : 'pipe',
            stdout: { maxBytes: MAX_STREAM_BYTES },
            stderr: { maxBytes: MAX_STREAM_BYTES },
          },
          graceMs: 2_000,
          signal: controller.signal,
        });
        if (spec.stdin !== undefined && handle !== undefined) {
          const writable = (handle as unknown as { stdin?: { write(chunk: string): void; end(): void } }).stdin;
          if (writable !== undefined) {
            writable.write(spec.stdin);
            writable.end();
          }
        }
        const exit = await handle.done;
        return {
          exitCode: exit.exitCode,
          stdout: drain(handle.collected.stdout),
          stderr: drain(handle.collected.stderr),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // A missing executable is an expected state (`gh` may not be installed), so it
        // is reported through `spawnError` rather than thrown.
        if (/ENOENT|not found|no such file/i.test(message)) {
          return { exitCode: null, stdout: '', stderr: message, spawnError: message };
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
