/**
 * Minimal structural views of the Host services this plugin uses.
 *
 * These are intentionally *not* imports from `@deepseek-ai/dsh-*`: an out-of-tree
 * plugin cannot resolve those packages (they live inside the Host's own module tree),
 * so importing them would make the plugin fail to load. Declaring the exact shapes we
 * depend on keeps the surface small, auditable, and loadable.
 *
 * Each declaration below mirrors a verified Host contract; the comment above it says
 * which service or event it comes from.
 */

/** `ContentBlock` text variant, as accepted by subagent messaging. */
export interface TextBlock {
  type: 'text';
  text: string;
}

/** One content block; only text is produced by this plugin. */
export type ContentBlock = TextBlock;

/** `Agent` from the Host's agent service: identity wrapper around a session id. */
export interface HostAgent {
  readonly id: string;
}

/** `SubagentResult` from the `subagents` service. */
export interface HostSubagentResult {
  readonly output: readonly ContentBlock[];
  readonly structured?: unknown;
  readonly diagnostic?: string;
  readonly stopReason: 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal';
}

/** `SubagentActivation` from the `subagents` service. */
export interface HostSubagentActivation {
  readonly childId: string;
  readonly messageId?: string;
  readonly result: Promise<HostSubagentResult>;
  dispose(): Promise<void>;
}

/** The subset of the `subagents` service this plugin calls. */
export interface HostSubagents {
  startActivation(spec: {
    provider: string;
    label: string;
    childId?: string;
    request: {
      prompt: ContentBlock[];
      parent: HostAgent;
      cwd?: string;
      agentPreset?: string;
      agentOptions?: { provider?: string; model?: string; reasoningEffort?: string; maxTokens?: number };
      maxDepth?: number;
    };
    signal: AbortSignal;
    delivery: 'parent' | 'caller';
  }): Promise<HostSubagentActivation>;
  sendMessage(
    sender: HostAgent,
    targetId: string,
    content: ContentBlock[],
    options: { signal: AbortSignal },
  ): Promise<string>;
  interrupt(
    targetSessionId: string,
    authority: { kind: 'ancestor'; agent: HostAgent } | { kind: 'user'; parentSessionId: string },
  ): void;
  list(): string[];
  getProvider(name: string): { name: string; prepareContinuable?: unknown } | undefined;
}

/** Output reader from `subprocess` collected streams. */
export interface HostOutputReader {
  readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean; spillPath?: string };
}

/** `SubprocessHandle` from the `subprocess` service. */
export interface HostSubprocessHandle {
  readonly collected: { stdout?: HostOutputReader; stderr?: HostOutputReader };
  readonly done: Promise<{ exitCode: number | null; signal: string | null }>;
  terminate(): void;
}

/** The subset of the `subprocess` service this plugin calls. */
export interface HostSubprocess {
  spawn(spec: {
    argv: readonly string[];
    cwd: string;
    stdio: {
      stdin: 'ignore' | 'pipe';
      stdout: 'pipe' | 'inherit' | { maxBytes: number };
      stderr: 'pipe' | 'inherit' | { maxBytes: number };
    };
    graceMs?: number;
    signal?: AbortSignal;
    env?: Record<string, string>;
  }): HostSubprocessHandle;
}

/** `JsonSchemaNode`, the schema language accepted by `tools.register`. */
export interface HostJsonSchemaNode {
  type?: string;
  properties?: Record<string, HostJsonSchemaNode>;
  required?: string[];
  additionalProperties?: boolean;
  items?: HostJsonSchemaNode;
  enum?: Array<string | number | boolean | null>;
  const?: string | number | boolean | null;
  description?: string;
  title?: string;
  default?: unknown;
  oneOf?: HostJsonSchemaNode[];
}

/** `ToolDefinition` minus the generic `execute` typing, which we narrow locally. */
export interface HostToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  deferLoading?: true;
  readonly output: {
    schema: HostJsonSchemaNode;
    render(args: unknown, value: unknown): ContentBlock[];
  };
  execute(args: unknown, exec: HostToolRunContext): Promise<unknown>;
}

/** `ToolRunContext` from the `tools` service. */
export interface HostToolRunContext {
  readonly signal: AbortSignal;
  readonly agent?: HostAgent;
  readonly callId?: string;
  deferContext(message: unknown): void;
  concludeTurn(): void;
}

/** The subset of the `tools` service this plugin calls. */
export interface HostTools {
  register(definition: HostToolDefinition): () => void;
}

/** `CommandDefinition` from the `commands` service. */
export interface HostCommandDefinition {
  definitionId?: string;
  name: string;
  description: string;
  input?: { hint: string; attachments?: boolean };
  handler(invocation: {
    commandId: string;
    agent: HostAgent;
    rawInput: string;
    attachments: readonly unknown[];
    signal: AbortSignal;
  }): { kind: 'success'; text?: string } | { kind: 'error'; text: string } | Promise<{ kind: 'success'; text?: string } | { kind: 'error'; text: string }>;
}

/** The subset of the `commands` service this plugin calls. */
export interface HostCommands {
  register(definition: HostCommandDefinition): () => void;
}

/** `PromptSection` from the `systemPrompt` service. */
export interface HostPromptSection {
  name: string;
  order: number;
  text: string | (() => string);
  interpolate?: boolean;
}

/** The subset of the `systemPrompt` service this plugin calls. */
export interface HostSystemPrompt {
  section(section: HostPromptSection): () => void;
}

/** The subset of the `timer` service this plugin calls. */
export interface HostTimer {
  interval(callback: () => void, delay: number): () => void;
  timeout(callback: () => void, delay: number): () => void;
}

/** The subset of the `agents` service this plugin calls. */
export interface HostAgents {
  get(id: string): HostAgent | undefined;
  list(): readonly HostAgent[];
}

/** The subset of the `workingDirectory` service this plugin calls. */
export interface HostWorkingDirectory {
  /** Deployment fallback for Sessions with no recorded original directory. */
  readonly defaultDirectory: string;
  get(session: { readonly header: { readonly cwd?: string } }): string;
  /**
   * Effective directory for a live agent.
   *
   * This is the only per-session answer: `defaultDirectory` is documented as the fallback for
   * Sessions with no recorded directory, and in the desktop app it is the profile directory.
   * Optional because an older Host may not expose it; without it there is no safe default.
   */
  ensure?(agent: HostAgent, signal?: AbortSignal): Promise<string>;
}

/** Everything the plugin pulls off the Cordis context. */
export interface HostContext {
  get(service: string): unknown;
  on(event: string, listener: (...args: never[]) => unknown): () => void;
  effect(setup: () => () => void): () => void;
  /**
   * Run `callback` in a forked context that stays inactive until every named service is
   * available.
   *
   * This is how an optional capability is registered: `ctx.get` only samples the registry
   * once, at the moment `apply` runs, so a service that mounts later would be missed
   * forever. `inject` defers the callback instead of sampling.
   */
  inject(services: string[], callback: (scoped: HostContext) => void): () => void;
  /** Optional child-context scope used for agent-scoped registrations. */
  emit?(event: string, ...args: unknown[]): void;
}

/** Minimal shape of the Zod schema the Host expects for projection state. */
export interface HostZodSchema {
  parse(value: unknown): unknown;
}

/** One session projection definition, as `sessionProjections.register` accepts it. */
export interface HostProjectionDefinition<S> {
  key: string;
  stateSchema: HostZodSchema;
  init(header: unknown, inheritedEventCount: number): S;
  apply(state: S, event: { type: string; data?: unknown }): S;
  wire?: { viewSchema: HostZodSchema; view(state: S): unknown };
  stateVersion: number;
}

/** The subset of the `sessionProjections` service this plugin calls. */
export interface HostSessionProjections {
  register<S>(definition: HostProjectionDefinition<S>): () => void;
}

/** The subset of the `sessions` service this plugin calls. */
export interface HostSessions {
  get(id: string): HostSession | undefined;
}

/** The subset of a live `Session` this plugin appends to. */
export interface HostSession {
  readonly id: string;
  append(type: string, data: unknown): unknown;
  /** Every event this session recorded itself, oldest first. */
  ownEvents(): readonly HostSessionEvent[];
}

/** One recorded session event, narrowed only as far as the usage reader needs. */
export interface HostSessionEvent {
  readonly type: string;
  readonly data?: unknown;
}

/**
 * The subset of the `tokenMeter` service this plugin calls.
 *
 * Used for current context pressure only. Spend itself comes from the provider's own usage
 * numbers on the session log: an estimate presented as billed tokens would be a lie the user
 * cannot detect.
 */
export interface HostTokenMeter {
  measure(session: HostSession): { readonly totalTokens?: number };
}
