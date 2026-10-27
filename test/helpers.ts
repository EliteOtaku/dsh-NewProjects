/**
 * Shared in-memory fakes for the two ports the core depends on.
 *
 * The core is written against `CommandRunner` and `ThreadRuntime` rather than a live git
 * binary and a live Host, so every orchestration policy can be exercised here exactly as
 * it runs in production. Anything that needs a real `git` or a real child session is an
 * integration concern and deliberately out of scope for these tests.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CommandResult, CommandRunner, CommandSpec } from '../src/core/exec.js';
import type {
  OutcomeListener,
  ThreadHandle,
  ThreadLaunch,
  ThreadOutcome,
  ThreadPresence,
  ThreadRuntime,
} from '../src/core/threads.js';

/** One recorded command invocation. */
export interface RecordedCommand {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env?: Record<string, string> | undefined;
  readonly stdin?: string | undefined;
}

/**
 * A `CommandRunner` that answers from a scripted table.
 *
 * Routes match by **longest argv prefix**, not by exact argv: one `git rev-parse` route
 * would otherwise answer `--git-dir`, `HEAD`, and `--abbrev-ref` identically, and
 * `gh pr view` would shadow `gh pr checks`. Prefix matching keeps a route readable
 * (`'gh pr checks'`) while still letting a test pin an exact invocation
 * (`'gh pr view 7 --json state,isDraft'`) when two calls share a prefix.
 *
 * An unmatched command fails loudly instead of returning empty output: a silently empty
 * result would make a broken test look like a passing one.
 */
export class FakeRunner implements CommandRunner {
  /** Every command this runner was asked to run, in order. */
  readonly calls: RecordedCommand[] = [];
  private readonly routes: Array<{
    key: string;
    answer: CommandResult | ((spec: CommandSpec) => CommandResult);
  }> = [];

  /**
   * Answer any command starting with `key` (argv words joined by spaces).
   *
   * Re-registering the same `key` **replaces** the earlier answer. A test that starts from
   * a shared fixture table must be able to override one route without the fixture's answer
   * winning by registration order.
   */
  on(key: string, result: Partial<CommandResult> | string): this {
    return this.onCommand(key, () => (typeof result === 'string' ? { stdout: result } : result));
  }

  /** Answer any command starting with `key`, computed from the invocation. */
  onCommand(key: string, handler: (spec: CommandSpec) => Partial<CommandResult>): this {
    const existing = this.routes.findIndex((route) => route.key === key);
    const answer = (spec: CommandSpec): CommandResult => {
      const partial = handler(spec);
      return {
        exitCode: partial.exitCode ?? 0,
        stdout: partial.stdout ?? '',
        stderr: partial.stderr ?? '',
      };
    };
    if (existing >= 0) {
      // Replace in place rather than appending: with two routes for one key the older one
      // would shadow the newer override, and a test that meant to change one answer would
      // silently keep the fixture's.
      this.routes[existing] = { key, answer };
    } else {
      this.routes.push({ key, answer });
    }
    return this;
  }

  /** The recorded invocations matching one route key. */
  callsFor(key: string): RecordedCommand[] {
    return this.calls.filter((call) => matches(call.argv, key));
  }

  /** Whether any recorded invocation matched one route key. */
  saw(key: string): boolean {
    return this.calls.some((call) => matches(call.argv, key));
  }

  async run(spec: CommandSpec): Promise<CommandResult> {
    this.calls.push({
      argv: [...spec.argv],
      cwd: spec.cwd,
      env: spec.env,
      stdin: spec.stdin,
    });
    const text = spec.argv.join(' ');
    let best: { key: string; answer: CommandResult | ((spec: CommandSpec) => CommandResult) } | undefined;
    for (const route of this.routes) {
      if (!isPrefix(text, route.key)) continue;
      if (best === undefined || route.key.length > best.key.length) best = route;
    }
    if (best === undefined) {
      throw new Error(`FakeRunner has no route for "${text}"`);
    }
    return typeof best.answer === 'function' ? best.answer(spec) : best.answer;
  }
}

/** Whether `text` begins with `key` at a word boundary. */
function isPrefix(text: string, key: string): boolean {
  if (!text.startsWith(key)) return false;
  return text.length === key.length || text[key.length] === ' ';
}

/** Whether one argv matches a route key. */
function matches(argv: readonly string[], key: string): boolean {
  return isPrefix(argv.join(' '), key);
}

/** A `ThreadRuntime` whose children are puppets the test drives. */
export class FakeThreads implements ThreadRuntime {
  /** Prompts passed to {@link launch}, in order. */
  readonly launches: ThreadLaunch[] = [];
  /** Messages passed to {@link steer}, in order. */
  readonly steers: Array<{ childSessionId: string; text: string }> = [];
  /** Messages passed to {@link resume}, in order. */
  readonly resumes: Array<{ childSessionId: string; text: string }> = [];
  /** Child session ids passed to {@link interrupt}. */
  readonly interrupts: string[] = [];
  /** When false, {@link available} reports the Host could not spawn. */
  spawnable = true;
  /** Reason reported when {@link spawnable} is false. */
  reason = 'subagent provider missing';
  /**
   * When set, the next {@link launch} rejects with this message.
   *
   * One-shot on purpose: a test that makes every launch fail proves nothing about quota
   * refunding, because there would be no successful thread to compare against.
   */
  failNextLaunch: string | undefined;

  private readonly handles = new Map<string, string>();
  private readonly presenceMap = new Map<string, ThreadPresence>();
  private readonly parents = new Map<string, object>();
  private readonly listeners = new Set<OutcomeListener>();
  private counter = 0;

  /** How many launches this runtime accepted. */
  get started(): number {
    return this.launches.length;
  }

  available(): boolean {
    return this.spawnable;
  }

  unavailableReason(): string {
    return this.reason;
  }

  async launch(parent: object, spec: ThreadLaunch): Promise<ThreadHandle> {
    if (!this.spawnable) throw new Error(this.reason);
    if (this.failNextLaunch !== undefined) {
      const message = this.failNextLaunch;
      this.failNextLaunch = undefined;
      throw new Error(message);
    }
    this.launches.push(spec);
    this.counter += 1;
    const childSessionId = `child-${this.counter}`;
    this.handles.set(childSessionId, childSessionId);
    this.presenceMap.set(childSessionId, 'busy');
    this.parents.set(childSessionId, parent);
    return {
      childSessionId,
      dispose: async () => {
        this.presenceMap.set(childSessionId, 'idle');
      },
    };
  }

  async steer(_parent: object, childSessionId: string, text: string): Promise<void> {
    if (this.presenceMap.get(childSessionId) !== 'busy') {
      throw new Error(`cannot steer ${childSessionId}: not busy`);
    }
    this.steers.push({ childSessionId, text });
  }

  async resume(_parent: object, childSessionId: string, text: string): Promise<void> {
    this.resumes.push({ childSessionId, text });
    this.presenceMap.set(childSessionId, 'busy');
  }

  async interrupt(childSessionId: string): Promise<void> {
    this.interrupts.push(childSessionId);
    this.presenceMap.set(childSessionId, 'idle');
  }

  isLive(childSessionId: string): boolean {
    return this.presenceMap.get(childSessionId) === 'busy';
  }

  presence(childSessionId: string): ThreadPresence {
    return this.presenceMap.get(childSessionId) ?? 'absent';
  }

  parentFor(childSessionId: string): object | undefined {
    return this.parents.get(childSessionId);
  }

  onSettled(listener: OutcomeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Simulate a child finishing its turn. */
  finish(childSessionId: string, outcome: Partial<ThreadOutcome> = {}): void {
    this.presenceMap.set(childSessionId, 'idle');
    const full: ThreadOutcome = {
      stopReason: outcome.stopReason ?? 'completed',
      text: outcome.text ?? 'done',
      ...(outcome.structured === undefined ? {} : { structured: outcome.structured }),
      ...(outcome.diagnostic === undefined ? {} : { diagnostic: outcome.diagnostic }),
    };
    for (const listener of [...this.listeners]) listener(childSessionId, full);
  }

  /** Mark a child busy, as a resumed turn would. */
  wake(childSessionId: string): void {
    this.presenceMap.set(childSessionId, 'busy');
  }

  /** The child session id of the Nth started thread (1-based). */
  childAt(ordinal: number): string {
    const id = `child-${ordinal}`;
    if (!this.handles.has(id)) throw new Error(`no child at ordinal ${ordinal}`);
    return id;
  }
}

/**
 * A temporary project root, removed after the test.
 *
 * Tests that touch the manifest use a real directory: the store writes atomically with
 * `rename`, so an in-memory filesystem would test the mock rather than the store.
 */
export async function makeTempRoot(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-project-test-'));
  return {
    root,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** A deterministic clock that advances only when told to. */
export function fixedClock(startMs = Date.parse('2026-01-02T03:04:05Z')): {
  now(): number;
  advance(ms: number): void;
} {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

/** Deterministic ids, so assertions can name threads. */
export function sequentialIds(): { threadId(prefix?: string): string; projectId(): string } {
  let thread = 0;
  let project = 0;
  return {
    threadId: (prefix = 'thr') => {
      thread += 1;
      return `${prefix}-${thread}`;
    },
    projectId: () => {
      project += 1;
      return `prj-${project}`;
    },
  };
}
