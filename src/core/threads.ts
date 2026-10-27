/**
 * Thread execution port.
 *
 * The engine needs four things from the Host: start a durable child session, steer a
 * live one, continue a finished one, and stop one. On top of that it needs to *learn*
 * when a child turn ends.
 *
 * **One outcome channel.** Turn ends arrive exclusively through {@link ThreadRuntime.onSettled},
 * which the Host adapter feeds from `subagent/end`. A handle deliberately carries no
 * per-turn promise: a resumed turn produces no new handle, so a second source would
 * silently miss exactly the turns that matter most (the self-healing ones) or double-count
 * the first turn. `core/` never imports a Host service type, so tests substitute an
 * in-memory runtime and drive it through the same listener contract.
 */

/** What to start. */
export interface ThreadLaunch {
  /** Prompt text for the child's first message. */
  prompt: string;
  /** Working directory for the child; defaults to the project root. */
  cwd: string;
  /** Short display label. */
  label: string;
  /** Optional model route override for the child. */
  agentOptions?: { provider?: string; model?: string; reasoningEffort?: string; maxTokens?: number };
}

/** What a launch produced. */
export interface ThreadHandle {
  /** Durable child session id. */
  childSessionId: string;
  /** Release plugin-side resources for this activation. The child keeps running. */
  dispose(): Promise<void>;
}

/** Terminal state of one child turn. */
export interface ThreadOutcome {
  stopReason: 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal' | 'unknown';
  /** Final assistant text, already flattened from content blocks. */
  text: string;
  /** Structured output when the child produced one. */
  structured?: unknown;
  /** Diagnostic string when the provider reported one. */
  diagnostic?: string;
}

/** Observe one finished child turn. */
export type OutcomeListener = (childSessionId: string, outcome: ThreadOutcome) => void;

/**
 * Whether a child can receive a message right now.
 *
 * The distinction matters for cost: messaging an *idle* child starts a fresh turn, so a
 * broadcast that treated idle as reachable would wake every finished thread and burn
 * tokens just to announce a decision. Only `busy` children get pushed to; `idle` ones
 * receive the pending delta when they are next woken for a real reason.
 */
export type ThreadPresence = 'absent' | 'idle' | 'busy';

/** The port. */
export interface ThreadRuntime {
  /** Whether a durable child session can be started at all. */
  available(): boolean;
  /** Human-readable reason the runtime is unavailable. */
  unavailableReason?(): string;
  /** Start a durable child session owned by `parent`. */
  launch(parent: object, spec: ThreadLaunch, signal: AbortSignal): Promise<ThreadHandle>;
  /** Send one steering message to a live child; the turn is already in flight. */
  steer(parent: object, childSessionId: string, text: string, signal: AbortSignal): Promise<void>;
  /** Continue a finished child with a new message, starting a fresh turn. */
  resume(parent: object, childSessionId: string, text: string, signal: AbortSignal): Promise<void>;
  /** Interrupt a running child. */
  interrupt(childSessionId: string): Promise<void>;
  /** Whether `childSessionId` currently has a live agent. */
  isLive(childSessionId: string): boolean;
  /** Whether a child is mid-turn, idle, or unknown to this runtime. */
  presence(childSessionId: string): ThreadPresence;
  /**
   * The Agent that owns `childSessionId`, when this runtime still remembers it.
   *
   * Needed by work that runs without a caller agent — a CI poll, for instance. The Host
   * authorizes a message against a live sender, so guessing an identity would fail.
   */
  parentFor(childSessionId: string): object | undefined;
  /** Subscribe to finished turns for any child. Returns an unsubscribe function. */
  onSettled(listener: OutcomeListener): () => void;
}

/** A runtime that refuses to work, used when the Host has no subagent service. */
export class UnavailableThreadRuntime implements ThreadRuntime {
  constructor(private readonly reason: string) {}

  available(): boolean {
    return false;
  }

  unavailableReason(): string {
    return this.reason;
  }

  async launch(): Promise<ThreadHandle> {
    throw new Error(this.reason);
  }

  async steer(): Promise<void> {
    throw new Error(this.reason);
  }

  async resume(): Promise<void> {
    throw new Error(this.reason);
  }

  async interrupt(): Promise<void> {
    throw new Error(this.reason);
  }

  isLive(): boolean {
    return false;
  }

  presence(): ThreadPresence {
    return 'absent';
  }

  parentFor(): object | undefined {
    return undefined;
  }

  onSettled(): () => void {
    // Nothing will ever settle, so a no-op subscription is the honest answer.
    return () => undefined;
  }
}

/**
 * A runtime whose delegate can be swapped after the fact.
 *
 * The Host mounts `subagent` services independently of this plugin, so `subagents` may
 * arrive after activation. Engines created earlier hold a reference to this object, and a
 * finished-turn subscription made against a placeholder would never fire again — so the
 * subscription is re-established on the new delegate here rather than by every engine.
 */
export class SwappableThreadRuntime implements ThreadRuntime {
  private delegate: ThreadRuntime;
  private readonly listeners = new Set<OutcomeListener>();
  private detachDelegate: () => void;

  constructor(initial: ThreadRuntime) {
    this.delegate = initial;
    this.detachDelegate = initial.onSettled((childSessionId, outcome) => {
      for (const listener of [...this.listeners]) listener(childSessionId, outcome);
    });
  }

  /** Install a new delegate, re-subscribing every listener to it. */
  replace(next: ThreadRuntime): void {
    this.detachDelegate();
    this.delegate = next;
    this.detachDelegate = next.onSettled((childSessionId, outcome) => {
      for (const listener of [...this.listeners]) listener(childSessionId, outcome);
    });
  }

  /** The delegate currently in use, for diagnostics. */
  current(): ThreadRuntime {
    return this.delegate;
  }

  available(): boolean {
    return this.delegate.available();
  }

  unavailableReason(): string {
    // Declared non-optional here: callers ask this whenever `available()` is false, and a
    // delegate that only has the optional form still needs *a* sentence to show a user.
    return this.delegate.unavailableReason?.() ?? 'the thread runtime is not available';
  }

  launch(parent: object, spec: ThreadLaunch, signal: AbortSignal): Promise<ThreadHandle> {
    return this.delegate.launch(parent, spec, signal);
  }

  steer(parent: object, childSessionId: string, text: string, signal: AbortSignal): Promise<void> {
    return this.delegate.steer(parent, childSessionId, text, signal);
  }

  resume(parent: object, childSessionId: string, text: string, signal: AbortSignal): Promise<void> {
    return this.delegate.resume(parent, childSessionId, text, signal);
  }

  interrupt(childSessionId: string): Promise<void> {
    return this.delegate.interrupt(childSessionId);
  }

  isLive(childSessionId: string): boolean {
    return this.delegate.isLive(childSessionId);
  }

  presence(childSessionId: string): ThreadPresence {
    return this.delegate.presence(childSessionId);
  }

  parentFor(childSessionId: string): object | undefined {
    return this.delegate.parentFor(childSessionId);
  }

  onSettled(listener: OutcomeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Drop every listener and the delegate subscription. */
  dispose(): void {
    this.detachDelegate();
    this.listeners.clear();
  }
}
