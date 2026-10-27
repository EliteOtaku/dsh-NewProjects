/**
 * Project engine — the orchestration core.
 *
 * Owns no Host types: everything external arrives through the {@link CommandRunner}
 * and {@link ThreadRuntime} ports plus a `parent` object the Host adapter understands.
 * That keeps the whole coordination policy unit-testable with in-memory fakes and
 * keeps the plugin's Host coupling confined to `host/`.
 *
 * Responsibility split:
 * - {@link ProjectEngine} — transitions, quota, persistence, thread lifecycle.
 * - `core/healing.ts` — the pure "what should happen next" decision.
 * - `core/prompt.ts` — prompt bytes.
 * - `host/` — adapters and registration.
 */
import { isAbsolute, join, resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { describeError, isProjectError, ProjectError } from './errors.js';
import { CommandError } from './exec.js';
import { decideHealAction, mergeSnapshot, toCheckStates, toReviewComments } from './healing.js';
import { ManifestStore, INSTRUCTIONS_FILE, projectPaths } from './manifest.js';
import { COORDINATOR_AUTHOR, markSeen, removeMemory, renderMemoryDelta, renderMemoryMirror, sortedMemories, upsertMemory, } from './memory.js';
import { buildOverview } from './overview.js';
import { branchNameFor, planTasks } from './planner.js';
import { renderFeedbackAnswer, renderProjectCharter, renderThreadTask } from './prompt.js';
import { normaliseQuotaMax, quotaState, releaseQuota, reserveQuota, rolloverQuota } from './quota.js';
import { systemClock, systemIds, dayKey } from './util.js';
import { commitAll, createBranch, createPullRequest, inspectRepo, pushBranch, readChecks, readPrState, readReviewComments, readReviewVerdicts, } from './vcs.js';
/** Default poll cadence for the self-healing watcher. */
export const DEFAULT_CI_POLL_INTERVAL_MS = 60_000;
/** Lower bound so a misconfigured value cannot hammer GitHub. */
export const MIN_CI_POLL_INTERVAL_MS = 15_000;
/** The orchestration core. */
export class ProjectEngine {
    rootDir;
    store;
    runner;
    threads;
    clock;
    ids;
    watermarks;
    /** Child session id -> thread id, for routing turn-end events back to a descriptor. */
    live = new Map();
    /** Active `onSettled` subscription, present only while {@link attach} is in effect. */
    detachOutcomes;
    /** Last rendered charter text; see {@link cachedCharter}. */
    charterCache = '';
    constructor(rootDir, deps) {
        this.rootDir = rootDir;
        this.runner = deps.runner;
        this.threads = deps.threads;
        this.clock = deps.clock ?? systemClock;
        this.ids = deps.ids ?? systemIds;
        this.watermarks = deps.memoryWatermarks ?? new Map();
        this.store = new ManifestStore(rootDir, this.clock);
    }
    /**
     * Subscribe to turn ends.
     *
     * Called once by the plugin's `apply`, and disposed with it, so a reload leaves no
     * listener behind on the Host's runtime. Idempotent: a second call returns the same
     * detach function rather than stacking a duplicate subscription.
     */
    attach() {
        if (this.detachOutcomes !== undefined)
            return this.detachOutcomes;
        const detach = this.threads.onSettled((childSessionId, outcome) => {
            void this.handleOutcome(childSessionId, outcome);
        });
        this.detachOutcomes = () => {
            detach();
            this.detachOutcomes = undefined;
        };
        return this.detachOutcomes;
    }
    /** Project-scoped paths. */
    get paths() {
        return this.store.paths;
    }
    /** Whether a project record exists for this root. */
    async isInitialised() {
        return this.store.exists();
    }
    /** Read the manifest or throw `PROJECT_NOT_INITIALIZED`. */
    async requireManifest() {
        return (await this.store.read()).manifest;
    }
    // ---------------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------------
    /**
     * Create the project record.
     *
     * `rootDir` is resolved against the current directory when relative, matching how
     * every other filesystem-facing tool in the Harness treats paths.
     */
    async init(options = {}) {
        const rootDir = isAbsolute(this.rootDir) ? this.rootDir : resolve(this.rootDir);
        const existing = await this.store.tryRead();
        if (existing !== undefined) {
            throw new ProjectError('INVALID_INPUT', `project already initialised at ${this.store.paths.manifestPath}`);
        }
        const now = this.clock.now();
        const name = options.name?.trim();
        const manifest = {
            projectId: this.ids.projectId(),
            name: name !== undefined && name.length > 0 ? name : defaultProjectName(rootDir),
            revision: 0,
            rootDir,
            instructionsPath: options.instructionsPath ?? join(rootDir, '.dsh-project', INSTRUCTIONS_FILE),
            knowledgePaths: [...(options.knowledgePaths ?? [])],
            dailyThreadQuotaMax: normaliseQuotaMax(options.dailyThreadQuotaMax),
            dailyThreadsCreated: 0,
            quotaDay: dayKey(now),
            memories: {},
            threads: {},
            createdAt: now,
            updatedAt: now,
            ciPollIntervalMs: normalisePollInterval(options.ciPollIntervalMs),
            prefixVersion: 0,
        };
        return this.store.create(manifest);
    }
    /** Delete the durable record. Threads keep running; their descriptors are dropped. */
    async deinit() {
        await this.store.destroy();
        this.live.clear();
        this.watermarks.clear();
    }
    // ---------------------------------------------------------------------------
    // Shared memory
    // ---------------------------------------------------------------------------
    /**
     * Create or update one shared decision.
     *
     * `parent` is the Agent broadcasting the change; when omitted, nothing is pushed to
     * live threads and the caller is expected to have none yet.
     */
    async setMemory(parent, input) {
        const entry = await this.store.update((draft) => {
            const written = upsertMemory(draft, {
                key: input.key,
                decision: input.decision,
                ...(input.rationale === undefined ? {} : { rationale: input.rationale }),
                author: input.author ?? COORDINATOR_AUTHOR,
            }, this.clock);
            return { manifest: draft, result: written };
        });
        await this.refreshMemoryMirror();
        const broadcast = parent === undefined ? emptyBroadcast() : await this.broadcastMemory(parent);
        return { entry, broadcast };
    }
    /** Remove one decision. Unknown keys are reported rather than silently ignored. */
    async removeMemory(parent, key) {
        const removed = await this.store.update((draft) => {
            const existed = removeMemory(draft, key);
            return { manifest: draft, result: existed };
        });
        if (removed) {
            await this.refreshMemoryMirror();
            const broadcast = parent === undefined ? emptyBroadcast() : await this.broadcastMemory(parent);
            return { removed: true, broadcast };
        }
        return { removed: false, broadcast: emptyBroadcast() };
    }
    /** All decisions, canonically ordered. */
    async listMemory() {
        return sortedMemories(await this.requireManifest());
    }
    /**
     * Push changed decisions to threads that are mid-turn but have not seen them yet.
     *
     * Two deliberate restrictions:
     *
     * - **Only `busy` children are steered.** Sending to an idle child starts a fresh turn,
     *   so a broadcast would spend a full model round on each finished thread just to
     *   announce a decision. Idle threads pick the delta up when they are next woken for a
     *   real reason, which is also how a thread created later receives it (via the charter).
     * - **The parent Agent is required.** The Host authorizes a message against a live
     *   sender; an empty placeholder object would be rejected or, worse, attributed to the
     *   wrong owner.
     */
    async broadcastMemory(parent) {
        const manifest = await this.requireManifest();
        const outcome = { delivered: [], skipped: [], failed: [] };
        for (const thread of Object.values(manifest.threads)) {
            const where = this.threads.presence(thread.childSessionId);
            if (where !== 'busy') {
                outcome.skipped.push({ threadId: thread.threadId, reason: `session is ${where}` });
                continue;
            }
            const seen = this.watermarks.get(thread.childSessionId) ?? {};
            const delta = renderMemoryDelta(manifest, seen);
            if (delta.length === 0) {
                outcome.skipped.push({ threadId: thread.threadId, reason: 'already up to date' });
                continue;
            }
            try {
                await this.threads.steer(parent, thread.childSessionId, delta, AbortSignal.timeout(15_000));
                this.watermarks.set(thread.childSessionId, markSeen(manifest, seen));
                outcome.delivered.push(thread.threadId);
            }
            catch (error) {
                outcome.failed.push({ threadId: thread.threadId, reason: describeError(error) });
            }
        }
        return outcome;
    }
    /** Delta text for one child session, plus the watermark to store once delivered. */
    async memoryDeltaFor(childSessionId) {
        const manifest = await this.requireManifest();
        const seen = this.watermarks.get(childSessionId) ?? {};
        return { text: renderMemoryDelta(manifest, seen), watermark: markSeen(manifest, seen) };
    }
    /** Persist that a delta was delivered to a child. */
    markMemoryDelivered(childSessionId, watermark) {
        this.watermarks.set(childSessionId, watermark);
    }
    /** Rewrite `.dsh-project/SHARED_MEMORY.md` so the mirror never drifts. */
    async refreshMemoryMirror() {
        const manifest = await this.requireManifest();
        await writeFile(this.store.paths.memoryMirrorPath, renderMemoryMirror(manifest), 'utf8');
    }
    /**
     * Render the shared charter for system-prompt mounting.
     *
     * Also refreshes {@link cachedCharter}, which is the only value the synchronous prompt
     * hook can read.
     */
    async renderCharter() {
        const manifest = await this.requireManifest();
        const instructions = await readFile(manifest.instructionsPath, 'utf8').catch(() => undefined);
        const text = renderProjectCharter({
            manifest,
            ...(instructions === undefined ? {} : { instructions }),
            knowledgePaths: manifest.knowledgePaths,
        });
        this.charterCache = text;
        return { text, fingerprintSource: text };
    }
    /**
     * The most recently rendered charter, for the synchronous prompt hook.
     *
     * Prompt assembly is synchronous but reading the manifest is not, so the hook cannot
     * await. Serving the previous render keeps the prefix byte-identical across the many
     * assemblies in one turn (which is the whole point of the stable section) and picks up
     * a decision one assembly later. Rendering afresh inside the hook would be impossible;
     * blocking on it would be worse. The returned text is empty until the first render.
     */
    cachedCharter() {
        return this.charterCache;
    }
    // ---------------------------------------------------------------------------
    // Coordination
    // ---------------------------------------------------------------------------
    /**
     * Decompose one goal and start one durable child thread per planned task.
     *
     * Failure policy: each thread is attempted independently. A failure is reported in
     * `skipped` and never aborts the round, because a partially started plan is far
     * more useful than an all-or-nothing one — the user can retry the failed task alone.
     */
    async coordinate(parent, goal, options = {}, signal = AbortSignal.timeout(120_000)) {
        await this.requireManifest();
        const planned = planTasks(goal);
        if (planned.length === 0)
            throw new ProjectError('INVALID_INPUT', 'goal produced no tasks');
        const limit = Math.max(1, Math.min(options.limit ?? planned.length, planned.length));
        const tasks = planned.slice(0, limit);
        const now = this.clock.now();
        // Probe the environment once, so every task sees consistent facts.
        let repo = { isRepo: false, ghReady: false, ghProblem: 'not inspected' };
        try {
            repo = await inspectRepo(this.runner, this.rootDir);
        }
        catch (error) {
            repo = { isRepo: false, ghReady: false, ghProblem: describeError(error) };
        }
        if (!this.threads.available()) {
            throw new ProjectError('SPAWN_FAILED', this.threads.unavailableReason?.() ?? 'no subagent runtime is available');
        }
        // Reserve the whole batch up front so a mid-round failure cannot overshoot the cap.
        const reserved = options.ignoreQuota === true ? 0 : tasks.length;
        if (reserved > 0) {
            await this.store.update((draft) => {
                rolloverQuota(draft, dayKey(now));
                reserveQuota(draft, reserved, now);
                return { manifest: draft, result: undefined };
            });
        }
        const started = [];
        const skipped = [];
        for (const [ordinal, task] of tasks.entries()) {
            try {
                const descriptor = await this.startThread({
                    parent,
                    task,
                    ordinal,
                    repo,
                    options,
                    signal,
                });
                started.push(descriptor);
            }
            catch (error) {
                skipped.push({ task, reason: describeError(error) });
            }
        }
        // Give back reservations for tasks that never became threads.
        const unmatched = tasks.length - started.length;
        if (reserved > 0 && unmatched > 0) {
            await this.store.update((draft) => {
                releaseQuota(draft, unmatched, now);
                return { manifest: draft, result: undefined };
            });
        }
        const finalManifest = await this.requireManifest();
        return {
            projectId: finalManifest.projectId,
            planned: tasks,
            started,
            skipped,
            quota: quotaState(finalManifest, this.clock.now()),
        };
    }
    /** Start one thread: isolate, launch, persist. */
    async startThread(input) {
        const { parent, task, ordinal, repo, options, signal } = input;
        const manifest = await this.requireManifest();
        const threadId = this.ids.threadId();
        const namespace = options.branchNamespace ?? slugify(manifest.name);
        const isolation = await this.prepareIsolation({
            manifest,
            task,
            ordinal,
            repo,
            namespace,
            scopeOnly: options.scopeOnly === true,
            threadId,
        });
        const now = this.clock.now();
        const worktreePath = isolation.worktreePath;
        const descriptor = {
            threadId,
            childSessionId: '',
            title: task.title,
            objective: task.objective,
            branchOrScope: isolation.branch ?? task.scopeHint ?? manifest.rootDir,
            status: 'queued',
            startedAt: now,
            updatedAt: now,
            ...(isolation.branch === undefined ? {} : { branch: isolation.branch }),
            ...(isolation.baseCommit === undefined ? {} : { baseCommit: isolation.baseCommit }),
            ...(worktreePath === undefined ? {} : { worktreePath }),
            healAttempts: 0,
        };
        const promptText = renderThreadTask(descriptor, {
            ...(worktreePath === undefined ? {} : { worktreePath }),
            ...(options.memoryKeys === undefined ? {} : { memoryKeys: options.memoryKeys }),
        });
        let handle;
        try {
            handle = await this.threads.launch(parent, {
                prompt: promptText,
                cwd: worktreePath ?? manifest.rootDir,
                label: task.title.slice(0, 60),
            }, signal);
        }
        catch (error) {
            throw new ProjectError('SPAWN_FAILED', `could not start thread "${task.title}": ${describeError(error)}`);
        }
        descriptor.childSessionId = handle.childSessionId;
        this.live.set(handle.childSessionId, threadId);
        this.watermarks.set(handle.childSessionId, markSeen(manifest, {}));
        await this.store.update((draft) => {
            draft.threads[threadId] = descriptor;
            return { manifest: draft, result: undefined };
        });
        // Persist the running state only after the durable record exists, so a crash
        // between the two leaves a queued descriptor rather than a phantom session.
        const running = await this.updateThread(threadId, (thread) => {
            thread.status = 'running';
        });
        return running;
    }
    /** Build the isolation unit for one task, falling back to scope isolation. */
    async prepareIsolation(input) {
        const { manifest, task, ordinal, repo, namespace, scopeOnly, threadId } = input;
        if (scopeOnly || !repo.isRepo)
            return {};
        const branch = branchNameFor(namespace, task, ordinal);
        const base = repo.headCommit;
        if (base === undefined)
            return {};
        try {
            // Every thread gets its own checkout. Sharing the parent's told each concurrent thread
            // to write into the same working tree: their `git status` would see each other's edits,
            // and a commit would land on whatever branch the parent had checked out instead of the
            // thread's own. A branch ref alone is not isolation.
            const worktreePath = join(projectPaths(manifest.rootDir).worktreeRoot, threadId);
            const created = await createBranch(this.runner, {
                repoRoot: repo.repositoryRoot ?? manifest.rootDir,
                branch,
                from: base,
                worktreePath,
            });
            return {
                branch: created.branch,
                ...(created.baseCommit === undefined ? {} : { baseCommit: created.baseCommit }),
                ...(created.worktreePath === undefined ? {} : { worktreePath: created.worktreePath }),
            };
        }
        catch (error) {
            if (error instanceof CommandError) {
                // A checkout could not be created (nested repo, read-only mount, existing directory).
                // The thread still runs, isolated by scope discipline, and says so in its status
                // rather than silently sharing the parent's tree.
                return { branch, baseCommit: base };
            }
            throw error;
        }
    }
    /** Route one finished turn onto its thread descriptor. */
    async handleOutcome(childSessionId, outcome) {
        const threadId = this.live.get(childSessionId);
        if (threadId === undefined) {
            // A child this engine never launched (another project's thread, or a leftover from
            // a previous process). Recording it onto a guessed descriptor would corrupt state.
            return;
        }
        try {
            await this.updateThread(threadId, (thread) => {
                thread.updatedAt = this.clock.now();
                thread.note = outcome.text.slice(0, 400);
                if (outcome.stopReason === 'completed') {
                    // A finished turn is not the same as a finished deliverable. The thread is asked
                    // to push and open a PR itself, so a PR reference in its closing message is real
                    // evidence of a review target. Without one, the work is done but undelivered —
                    // which needs a human decision (`deliver`, or steer it with what is left), not a
                    // "completed" badge that claims a deliverable exists.
                    const ref = extractPrUrl(outcome.text);
                    if (ref !== undefined) {
                        thread.status = 'awaiting_review';
                        thread.prOrDeliverableRef = ref;
                        thread.feedbackPrompt = undefined;
                    }
                    else {
                        thread.status = 'needs_feedback';
                        thread.feedbackPrompt =
                            'the thread finished but reported no pull request; run `deliver` to commit and push, or steer it with what remains';
                    }
                    thread.lastError = undefined;
                }
                else if (outcome.stopReason === 'aborted') {
                    // Interrupted, not failed: the work is resumable, so it goes back to the queue
                    // rather than to the failed bucket where it would read as a lost cause.
                    thread.status = 'queued';
                    thread.lastError = 'child session was interrupted';
                }
                else {
                    thread.status = 'failed';
                    thread.lastError = outcome.diagnostic ?? `child stopped with ${outcome.stopReason}`;
                }
            });
        }
        catch (error) {
            // The descriptor may have been deleted while the child ran; a missing thread is
            // not worth crashing the listener over.
            if (!isProjectError(error))
                throw error;
        }
        // Keep the routing entry: the thread may be resumed, and `isLive` is maintained by
        // the runtime itself rather than by this map.
    }
    // ---------------------------------------------------------------------------
    // Thread management
    // ---------------------------------------------------------------------------
    /** All threads, newest first. */
    async listThreads() {
        const manifest = await this.requireManifest();
        return Object.values(manifest.threads).sort((a, b) => b.updatedAt - a.updatedAt);
    }
    /** One thread or a typed failure. */
    async requireThread(threadId) {
        const manifest = await this.requireManifest();
        const thread = manifest.threads[threadId];
        if (thread === undefined) {
            throw new ProjectError('THREAD_NOT_FOUND', `unknown thread "${threadId}"`, { threadId });
        }
        return thread;
    }
    /**
     * Apply one management verb to a thread.
     *
     * `retry` re-launches a failed thread on its existing branch; `close` marks it done
     * without touching its branch or PR, so nothing is destroyed behind the user's back.
     */
    async manageThread(parent, threadId, action, payload, signal = AbortSignal.timeout(60_000)) {
        const thread = await this.requireThread(threadId);
        switch (action) {
            case 'inspect': {
                return { thread, message: describeThread(thread) };
            }
            case 'steer': {
                if (payload === undefined || payload.trim().length === 0) {
                    throw new ProjectError('INVALID_INPUT', 'steer requires a message');
                }
                await this.threads.steer(parent, thread.childSessionId, payload.trim(), signal);
                const updated = await this.updateThread(threadId, (draft) => {
                    if (draft.status === 'needs_feedback')
                        draft.status = 'running';
                    draft.feedbackPrompt = undefined;
                    draft.updatedAt = this.clock.now();
                });
                return { thread: updated, message: `steered ${threadId}` };
            }
            case 'respond': {
                if (payload === undefined || payload.trim().length === 0) {
                    throw new ProjectError('INVALID_INPUT', 'respond requires an answer');
                }
                const text = renderFeedbackAnswer(thread, payload);
                await this.threads.resume(parent, thread.childSessionId, text, signal);
                this.live.set(thread.childSessionId, threadId);
                const updated = await this.updateThread(threadId, (draft) => {
                    draft.status = 'running';
                    draft.feedbackPrompt = undefined;
                    draft.updatedAt = this.clock.now();
                });
                return { thread: updated, message: `resumed ${threadId} with your decision` };
            }
            case 'interrupt': {
                await this.threads.interrupt(thread.childSessionId);
                const updated = await this.updateThread(threadId, (draft) => {
                    draft.status = 'queued';
                    draft.updatedAt = this.clock.now();
                });
                return { thread: updated, message: `interrupted ${threadId}` };
            }
            case 'retry': {
                const manifest = await this.requireManifest();
                await this.threads.resume(parent, thread.childSessionId, payload ?? 'Your previous attempt stopped before finishing. Resume the task from where it stopped, verify your work, and report what remains.', signal);
                this.live.set(thread.childSessionId, threadId);
                this.watermarks.set(thread.childSessionId, markSeen(manifest, {}));
                const updated = await this.updateThread(threadId, (draft) => {
                    draft.status = 'running';
                    draft.lastError = undefined;
                    draft.updatedAt = this.clock.now();
                    draft.healAttempts = 0;
                });
                return { thread: updated, message: `retried ${threadId}` };
            }
            case 'close': {
                const updated = await this.updateThread(threadId, (draft) => {
                    draft.status = 'completed';
                    draft.note = payload ?? 'closed by user';
                    draft.updatedAt = this.clock.now();
                });
                return { thread: updated, message: `closed ${threadId}` };
            }
        }
    }
    // ---------------------------------------------------------------------------
    // Self-healing
    // ---------------------------------------------------------------------------
    /**
     * Poll every thread that has a PR and act on what it finds.
     *
     * One sweep = one `gh` round per thread. Network failures are collected, not
     * thrown: a flaky GitHub must never take the whole watcher down.
     */
    async healSweep(parent, signal = AbortSignal.timeout(120_000)) {
        const manifest = await this.requireManifest();
        const result = { observed: 0, healed: [], escalated: [], settled: [], waiting: [], errors: [] };
        const candidates = Object.values(manifest.threads).filter((thread) => thread.branch !== undefined && (thread.status === 'awaiting_review' || thread.status === 'ci_fixing' || thread.status === 'running'));
        for (const thread of candidates) {
            if (signal.aborted)
                break;
            try {
                const action = await this.observeOne(parent, thread, signal);
                result.observed += 1;
                switch (action.kind) {
                    case 'heal':
                        result.healed.push(await this.requireThread(thread.threadId));
                        break;
                    case 'escalate':
                        result.escalated.push(await this.requireThread(thread.threadId));
                        break;
                    case 'transition':
                        result.settled.push(await this.requireThread(thread.threadId));
                        break;
                    case 'wait':
                        result.waiting.push(await this.requireThread(thread.threadId));
                        break;
                    case 'none':
                        break;
                }
            }
            catch (error) {
                result.errors.push({ threadId: thread.threadId, message: describeError(error) });
            }
        }
        return result;
    }
    /** Observe one thread's PR and apply the decided action. */
    async observeOne(parent, thread, signal) {
        const cwd = thread.worktreePath ?? this.rootDir;
        const branch = thread.branch;
        if (branch === undefined)
            return { kind: 'none', reason: 'thread has no branch' };
        const checks = await readChecks(this.runner, cwd, branch);
        const checkStates = toCheckStates(checks.checks);
        const prRef = thread.prOrDeliverableRef ?? branch;
        const prNumber = Number.parseInt(/\/(\d+)(?:$|\?)/.exec(prRef)?.[1] ?? '', 10);
        let comments = [];
        let prState = 'open';
        if (Number.isFinite(prNumber)) {
            const [inline, verdicts, state] = await Promise.all([
                readReviewComments(this.runner, cwd, prNumber),
                readReviewVerdicts(this.runner, cwd, prNumber),
                readPrState(this.runner, cwd, prNumber),
            ]);
            if (state !== undefined)
                prState = normalisePrState(state);
            comments = toReviewComments(inline.comments);
            const changed = verdicts.reviews.filter((review) => review.state === 'CHANGES_REQUESTED');
            for (const review of changed) {
                if (review.body === undefined || review.body.trim().length === 0)
                    continue;
                comments.push({
                    id: `review-${String(review.id)}`,
                    author: review.user?.login ?? 'reviewer',
                    body: review.body.trim(),
                    createdAt: this.clock.now(),
                });
            }
        }
        // A PR that was merged or closed settles the thread before check noise matters.
        const previous = thread.review;
        const snapshot = mergeSnapshot(previous, {
            prRef,
            state: prState,
            checks: checkStates,
            comments,
            now: this.clock.now(),
        });
        const input = {
            prState: snapshot.state,
            checks: snapshot.checks,
            comments: snapshot.comments,
            consumedCommentIds: snapshot.consumedCommentIds,
            healAttempts: thread.healAttempts ?? 0,
            threadTitle: thread.title,
            prRef,
        };
        const action = decideHealAction(input);
        if (action.kind === 'transition') {
            await this.updateThread(thread.threadId, (draft) => {
                draft.status = action.status;
                draft.review = snapshot;
                draft.updatedAt = this.clock.now();
            });
            return action;
        }
        if (action.kind === 'wait' || action.kind === 'none') {
            await this.updateThread(thread.threadId, (draft) => {
                draft.review = snapshot;
            });
            return action;
        }
        if (action.kind === 'escalate') {
            await this.updateThread(thread.threadId, (draft) => {
                draft.status = 'needs_feedback';
                draft.feedbackPrompt = action.question;
                draft.review = snapshot;
                draft.updatedAt = this.clock.now();
            });
            return action;
        }
        // heal: wake the thread with the evidence, and remember which comments were sent.
        const consumed = [...snapshot.consumedCommentIds, ...snapshot.comments.filter((comment) => !snapshot.consumedCommentIds.includes(comment.id)).map((comment) => comment.id)];
        await this.threads.resume(parent, thread.childSessionId, action.prompt, signal);
        this.live.set(thread.childSessionId, thread.threadId);
        await this.updateThread(thread.threadId, (draft) => {
            draft.status = 'ci_fixing';
            draft.healAttempts = (draft.healAttempts ?? 0) + 1;
            draft.review = { ...snapshot, consumedCommentIds: consumed };
            draft.updatedAt = this.clock.now();
        });
        return action;
    }
    // ---------------------------------------------------------------------------
    // Overview
    // ---------------------------------------------------------------------------
    /** Structured overview for the tool result. */
    async overview(warnings = []) {
        const manifest = await this.requireManifest();
        const collected = [...warnings];
        if (!this.threads.available()) {
            const reason = this.threads.unavailableReason?.();
            if (reason !== undefined)
                collected.push(reason);
        }
        const quota = quotaState(manifest, this.clock.now());
        if (quota.created / Math.max(1, quota.max) >= 0.8) {
            collected.push(`daily thread quota at ${String(quota.created)}/${String(quota.max)}`);
        }
        return buildOverview(manifest, this.clock.now(), collected);
    }
    /** Buckets plus thread descriptors as a plain JSON value (tool output). */
    async overviewJson() {
        const overview = await this.overview();
        const buckets = overview.buckets;
        return {
            projectId: overview.projectId,
            name: overview.name,
            rootDir: overview.rootDir,
            revision: overview.revision,
            quota: overview.quota,
            totals: overview.totals,
            prefixFingerprint: overview.prefixFingerprint,
            warnings: overview.warnings,
            memories: overview.memories,
            buckets,
        };
    }
    // ---------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------
    /** Read-modify-write one thread descriptor under the CAS guard. */
    async updateThread(threadId, mutate) {
        return this.store.update((draft) => {
            const thread = draft.threads[threadId];
            if (thread === undefined) {
                throw new ProjectError('THREAD_NOT_FOUND', `unknown thread "${threadId}"`, { threadId });
            }
            mutate(thread);
            return { manifest: draft, result: thread };
        });
    }
    /** Commit and push one thread's work, then open a PR. */
    async deliverThread(threadId, options = {}) {
        const thread = await this.requireThread(threadId);
        const cwd = thread.worktreePath ?? this.rootDir;
        const commit = await commitAll(this.runner, {
            cwd,
            message: options.message ?? `${thread.title}\n\nthread ${threadId}`,
        });
        if (!commit.committed) {
            return { thread, message: 'nothing to commit' };
        }
        if (thread.branch === undefined) {
            const updated = await this.updateThread(threadId, (draft) => {
                draft.status = 'completed';
                draft.note = `committed ${commit.commit ?? ''}`.trim();
                draft.updatedAt = this.clock.now();
            });
            return { thread: updated, message: `committed ${commit.commit ?? ''} (no branch to push)`.trim() };
        }
        const pushed = await pushBranch(this.runner, cwd, thread.branch);
        if (!pushed)
            throw new ProjectError('VCS_FAILED', `could not push branch ${thread.branch}`);
        const created = await createPullRequest(this.runner, {
            cwd,
            branch: thread.branch,
            title: options.title ?? thread.title,
            body: options.body ?? `Automated thread \`${threadId}\`.\n\n${thread.objective}`,
            ...(options.draft === undefined ? {} : { draft: options.draft }),
        });
        if (!created.ok)
            throw new ProjectError('VCS_FAILED', created.message);
        const updated = await this.updateThread(threadId, (draft) => {
            draft.status = 'awaiting_review';
            draft.prOrDeliverableRef = created.pr.url;
            draft.updatedAt = this.clock.now();
        });
        return { thread: updated, prRef: created.pr.url, message: `opened ${created.pr.url}` };
    }
}
/**
 * Map `gh pr view`'s state verb onto the snapshot vocabulary.
 *
 * An unrecognised verb becomes `unknown` rather than `open`: claiming a PR is open when
 * GitHub reported something this plugin does not model would keep a settled thread
 * running forever, and `unknown` is the honest input to the heal decision.
 */
export function normalisePrState(raw) {
    const value = raw.trim().toLowerCase();
    if (value === 'open')
        return 'open';
    if (value === 'draft')
        return 'draft';
    if (value === 'merged')
        return 'merged';
    if (value === 'closed')
        return 'closed';
    return 'unknown';
}
/** An outcome for a call that intentionally delivered nothing. */
export function emptyBroadcast() {
    return { delivered: [], skipped: [], failed: [] };
}
/** Derive a readable project name from the root directory. */
export function defaultProjectName(rootDir) {
    const parts = rootDir.split(/[\\/]+/).filter((part) => part.length > 0);
    return parts[parts.length - 1] ?? 'project';
}
/** Turn a project name into a branch-safe slug. */
export function slugify(value) {
    const slug = value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return slug.length > 0 ? slug : 'project';
}
/** Clamp a configured poll interval into the accepted range. */
export function normalisePollInterval(value) {
    if (value === undefined || !Number.isFinite(value))
        return DEFAULT_CI_POLL_INTERVAL_MS;
    return Math.max(MIN_CI_POLL_INTERVAL_MS, Math.trunc(value));
}
/** Pull the first GitHub PR URL out of free-form child output. */
export function extractPrUrl(text) {
    const match = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/.exec(text);
    return match?.[0];
}
/** One-line thread summary for command output. */
export function describeThread(thread) {
    const bits = [`\`${thread.threadId}\``, thread.title, `status=${thread.status}`];
    if (thread.branch !== undefined)
        bits.push(`branch=${thread.branch}`);
    if (thread.worktreePath !== undefined)
        bits.push(`worktree=${thread.worktreePath}`);
    if (thread.prOrDeliverableRef !== undefined)
        bits.push(`pr=${thread.prOrDeliverableRef}`);
    if (thread.feedbackPrompt !== undefined)
        bits.push(`needs=${thread.feedbackPrompt}`);
    if (thread.lastError !== undefined)
        bits.push(`error=${thread.lastError}`);
    return bits.join(' ');
}
/** Narrow a status to the panel's bucket, re-exported for adapters. */
export { buildOverview };
