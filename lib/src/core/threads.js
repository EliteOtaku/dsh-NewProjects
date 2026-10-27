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
/** A runtime that refuses to work, used when the Host has no subagent service. */
export class UnavailableThreadRuntime {
    reason;
    constructor(reason) {
        this.reason = reason;
    }
    available() {
        return false;
    }
    unavailableReason() {
        return this.reason;
    }
    async launch() {
        throw new Error(this.reason);
    }
    async steer() {
        throw new Error(this.reason);
    }
    async resume() {
        throw new Error(this.reason);
    }
    async interrupt() {
        throw new Error(this.reason);
    }
    isLive() {
        return false;
    }
    presence() {
        return 'absent';
    }
    parentFor() {
        return undefined;
    }
    onSettled() {
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
export class SwappableThreadRuntime {
    delegate;
    listeners = new Set();
    detachDelegate;
    constructor(initial) {
        this.delegate = initial;
        this.detachDelegate = initial.onSettled((childSessionId, outcome) => {
            for (const listener of [...this.listeners])
                listener(childSessionId, outcome);
        });
    }
    /** Install a new delegate, re-subscribing every listener to it. */
    replace(next) {
        this.detachDelegate();
        this.delegate = next;
        this.detachDelegate = next.onSettled((childSessionId, outcome) => {
            for (const listener of [...this.listeners])
                listener(childSessionId, outcome);
        });
    }
    /** The delegate currently in use, for diagnostics. */
    current() {
        return this.delegate;
    }
    available() {
        return this.delegate.available();
    }
    unavailableReason() {
        // Declared non-optional here: callers ask this whenever `available()` is false, and a
        // delegate that only has the optional form still needs *a* sentence to show a user.
        return this.delegate.unavailableReason?.() ?? 'the thread runtime is not available';
    }
    launch(parent, spec, signal) {
        return this.delegate.launch(parent, spec, signal);
    }
    steer(parent, childSessionId, text, signal) {
        return this.delegate.steer(parent, childSessionId, text, signal);
    }
    resume(parent, childSessionId, text, signal) {
        return this.delegate.resume(parent, childSessionId, text, signal);
    }
    interrupt(childSessionId) {
        return this.delegate.interrupt(childSessionId);
    }
    isLive(childSessionId) {
        return this.delegate.isLive(childSessionId);
    }
    presence(childSessionId) {
        return this.delegate.presence(childSessionId);
    }
    parentFor(childSessionId) {
        return this.delegate.parentFor(childSessionId);
    }
    onSettled(listener) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    /** Drop every listener and the delegate subscription. */
    dispose() {
        this.detachDelegate();
        this.listeners.clear();
    }
}
