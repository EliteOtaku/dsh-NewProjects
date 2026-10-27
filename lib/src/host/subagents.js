/**
 * `ThreadRuntime` backed by the Host's `subagents` service.
 *
 * Correctness notes:
 *
 * - **Durable, not one-shot.** Threads must keep running when the browser disconnects, so
 *   every thread starts as a continuable child: `startActivation` needs a provider that
 *   implements `prepareContinuable`. Without it the child is one-shot and steer/resume
 *   would fail later, so {@link available} reports unavailability up front instead.
 * - **One source of truth for turn ends.** The Host emits `subagent/start` and
 *   `subagent/end`; this adapter forwards them through {@link onSettled}. The engine uses
 *   that stream for *every* turn, including turns started by `resume`, instead of
 *   inventing a second promise per resume — two sources would drift.
 * - **Parent identity is carried, not invented.** `sendMessage` authorizes against the
 *   exact live sender Agent, so the Agent that launched a thread is retained for the
 *   process lifetime and reused for later steers.
 */
/** Flatten content blocks to plain text. */
function flatten(blocks) {
    return blocks
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n')
        .trim();
}
/** A runtime over `ctx.subagents`. */
export class SubagentThreadRuntime {
    subagents;
    provider;
    /** Parent Agents that started threads, retained so later messaging can authorize. */
    parents = new Map();
    /** Children this runtime has launched or woken at least once, so "idle" is knowable. */
    known = new Set();
    /** Children currently executing a turn. */
    busy = new Set();
    listeners = new Set();
    constructor(subagents, provider = 'spawn') {
        this.subagents = subagents;
        this.provider = provider;
    }
    available() {
        const provider = this.subagents.getProvider(this.provider);
        if (provider === undefined)
            return false;
        return provider.prepareContinuable !== undefined;
    }
    unavailableReason() {
        const provider = this.subagents.getProvider(this.provider);
        if (provider === undefined) {
            const known = this.subagents.list();
            return `subagent provider "${this.provider}" is not registered (available: ${known.length === 0 ? 'none' : known.join(', ')})`;
        }
        return `subagent provider "${this.provider}" cannot continue a child session (prepareContinuable is missing), so a thread would stop after its first turn`;
    }
    /** Subscribe to finished turns. */
    onSettled(listener) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    /** Record that a child started a turn. */
    markStarted(childSessionId) {
        this.known.add(childSessionId);
        this.busy.add(childSessionId);
    }
    /** Record that a child finished a turn and fan the outcome out to listeners. */
    markEnded(childSessionId, outcome) {
        this.known.add(childSessionId);
        this.busy.delete(childSessionId);
        for (const listener of [...this.listeners])
            listener(childSessionId, outcome);
    }
    /**
     * Map a raw Host `subagent/end` payload into the engine's outcome vocabulary.
     *
     * `lastAssistantMessage` is typed loosely because the Host's end-info field has varied
     * between a flattened string and content blocks; both shapes are accepted rather than
     * assuming one and silently reading `undefined` for the other.
     */
    static outcomeFromEnd(info) {
        const message = info.lastAssistantMessage;
        let text = '';
        if (typeof message === 'string') {
            text = message;
        }
        else if (Array.isArray(message)) {
            text = flatten(message);
        }
        return {
            stopReason: info.stopReason ?? 'unknown',
            text,
            ...(info.diagnostic === undefined ? {} : { diagnostic: info.diagnostic }),
        };
    }
    async launch(parent, spec, signal) {
        const agent = this.requireAgent(parent);
        const activation = await this.subagents.startActivation({
            provider: this.provider,
            label: spec.label,
            request: {
                prompt: [{ type: 'text', text: spec.prompt }],
                parent: agent,
                ...(spec.cwd.length === 0 ? {} : { cwd: spec.cwd }),
                ...(spec.agentOptions === undefined ? {} : { agentOptions: spec.agentOptions }),
            },
            signal,
            delivery: 'parent',
        });
        const childSessionId = activation.childId;
        this.parents.set(childSessionId, agent);
        this.markStarted(childSessionId);
        // Exactly one source reports turn ends: `subagent/end` (see {@link markEnded}).
        // `activation.result` is used only to release the live flag. Reporting from both
        // would double-fire for every launch — the event and the promise describe the same
        // turn — and could flip a `completed` thread to `error` afterwards. A launch whose
        // activation rejects without an end event stays `running`, which the overview shows
        // and `retry` recovers; that is honest, whereas a guessed outcome is not.
        void activation.result.then(() => {
            this.busy.delete(childSessionId);
        }, () => {
            this.busy.delete(childSessionId);
        });
        return {
            childSessionId,
            dispose: async () => {
                this.parents.delete(childSessionId);
                this.busy.delete(childSessionId);
                await activation.dispose();
            },
        };
    }
    async steer(parent, childSessionId, text, signal) {
        const agent = this.parents.get(childSessionId) ?? this.requireAgent(parent);
        await this.subagents.sendMessage(agent, childSessionId, [{ type: 'text', text }], { signal });
        this.markStarted(childSessionId);
    }
    /**
     * Continue a finished thread with a new message.
     *
     * Returns no handle on purpose: the Host starts the turn itself and reports the end
     * through `subagent/end`, which {@link markEnded} forwards to the engine.
     */
    async resume(parent, childSessionId, text, signal) {
        const agent = this.parents.get(childSessionId) ?? this.requireAgent(parent);
        await this.subagents.sendMessage(agent, childSessionId, [{ type: 'text', text }], { signal });
        this.markStarted(childSessionId);
    }
    async interrupt(childSessionId) {
        const agent = this.parents.get(childSessionId);
        if (agent === undefined) {
            // Interrupting a child whose launching parent this process never observed needs a
            // human parent address, which is not available here. A no-op is the honest result:
            // the Host documents an absent target as an accepted no-op too.
            return;
        }
        this.subagents.interrupt(childSessionId, { kind: 'ancestor', agent });
    }
    isLive(childSessionId) {
        return this.busy.has(childSessionId);
    }
    /**
     * Distinguish mid-turn from idle.
     *
     * A child this runtime never met is `absent`; one it knows but is not currently
     * executing is `idle`. Sending to an idle child would start a turn, so callers that
     * only want to *inform* must check for `busy`.
     */
    presence(childSessionId) {
        if (this.busy.has(childSessionId))
            return 'busy';
        if (this.known.has(childSessionId))
            return 'idle';
        return 'absent';
    }
    /** The Agent that launched `childSessionId`, if this process started it. */
    parentFor(childSessionId) {
        return this.parents.get(childSessionId);
    }
    /** Forget a child entirely (after the engine retires the thread). */
    forget(childSessionId) {
        this.parents.delete(childSessionId);
        this.busy.delete(childSessionId);
        this.known.delete(childSessionId);
    }
    /** Narrow the opaque parent object to a Host Agent. */
    requireAgent(parent) {
        const candidate = parent;
        if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
            throw new Error('thread runtime requires the calling Agent as the parent handle');
        }
        return candidate;
    }
}
