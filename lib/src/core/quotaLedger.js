/**
 * User-level daily thread ledger.
 *
 * The enforced Projects limit is "200 new threads per day **across your projects**", so the
 * authoritative counter cannot live inside a per-project manifest: three projects each
 * holding their own counter would allow 600 threads a day. This module owns one ledger file
 * per user, shared by every project on the machine.
 *
 * The per-project `dailyThreadQuotaMax` in the manifest stays, but it is a different thing:
 * official wording is that "a limit you ask for is a **preference rather than a cap**",
 * while the 200/day figure is "the enforced limit". So the manifest counter is the
 * preference and this ledger is the cap, and `reserve` has to clear both.
 *
 * Writes take an exclusive lock file rather than trusting an in-process queue. Two Host
 * processes — a reloaded plugin beside one still running, or two Harness instances on one
 * machine — share this file by definition, which is the whole point of hoisting it out of
 * the project directory. An in-process queue would serialise exactly the writers that were
 * never the problem.
 */
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { renameWithRetry } from './atomicFile.js';
import { ProjectError } from './errors.js';
import { dayKey } from './util.js';
/**
 * Enforced ceiling on new threads per local calendar day, across every project.
 *
 * Matches the official "The enforced limit is 200 new threads per day across your projects".
 */
export const GLOBAL_DAILY_THREAD_LIMIT = 200;
/** Environment variable that relocates the ledger (tests, multiple profiles, CI). */
export const QUOTA_LEDGER_ENV = 'DSH_PROJECT_QUOTA_LEDGER';
/**
 * Where the ledger lives when nothing overrides it.
 *
 * Takes the environment rather than reading `process.env` directly so a test can resolve the
 * path without mutating global state, and so the module never hard-codes `homedir()` at a
 * call site a caller cannot reach.
 */
export function defaultQuotaLedgerPath(env = process.env) {
    const override = env[QUOTA_LEDGER_ENV]?.trim();
    if (override !== undefined && override.length > 0)
        return override;
    return join(homedir(), '.dsh', 'dsh-newprojects', 'quota.json');
}
/** How long a lock file may sit before a later writer treats it as abandoned. */
const LOCK_STALE_MS = 10_000;
/** Delay between lock acquisition attempts. */
const LOCK_RETRY_MS = 25;
/** Attempts before giving up, i.e. ~2.5 s of contention. */
const LOCK_ATTEMPTS = 100;
/** An empty ledger for `day`. */
export function emptyLedger(day) {
    return { schema: 1, day, created: 0, byProject: {} };
}
/**
 * Parse a ledger, rolling it to `day`.
 *
 * A corrupt or absent ledger reads as an empty one for today rather than an error: refusing
 * to start threads because a cache file got truncated would be worse than briefly
 * under-counting, and the next write repairs the file.
 */
export function parseLedger(text, day) {
    if (text === undefined)
        return emptyLedger(day);
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return emptyLedger(day);
    }
    const document = parsed;
    if (document === null || typeof document !== 'object' || document.schema !== 1) {
        return emptyLedger(day);
    }
    // A ledger from an earlier day carries no information about today's budget.
    if (document.day !== day)
        return emptyLedger(day);
    const byProject = {};
    if (document.byProject !== undefined && typeof document.byProject === 'object') {
        for (const [key, value] of Object.entries(document.byProject)) {
            if (typeof value === 'number' && Number.isFinite(value) && value > 0)
                byProject[key] = Math.trunc(value);
        }
    }
    const created = typeof document.created === 'number' && Number.isFinite(document.created)
        ? Math.max(0, Math.trunc(document.created))
        : 0;
    return { schema: 1, day, created, byProject };
}
/** The user-wide ledger for one path. */
export class QuotaLedger {
    path;
    max;
    constructor(path, options = {}) {
        this.path = path;
        this.max = Math.max(1, Math.trunc(options.max ?? GLOBAL_DAILY_THREAD_LIMIT));
    }
    /** Read today's ledger without taking the lock. */
    async snapshot(projectId, nowMs) {
        const day = dayKey(nowMs);
        const document = parseLedger(await readIfPresent(this.path), day);
        return {
            day,
            created: document.created,
            max: this.max,
            project: document.byProject[projectId] ?? 0,
        };
    }
    /**
     * Reserve `count` threads for `projectId`.
     *
     * All-or-nothing: a request that would cross the ceiling throws `QUOTA_EXCEEDED` and
     * leaves the file byte-identical, so a rejected batch costs the user nothing.
     */
    async reserve(projectId, count, nowMs) {
        if (!Number.isFinite(count) || count <= 0) {
            throw new ProjectError('INVALID_INPUT', `reservation count must be a positive integer, got ${count}`);
        }
        return this.mutate(projectId, nowMs, (document) => {
            const next = document.created + count;
            if (next > this.max) {
                throw new ProjectError('QUOTA_EXCEEDED', `daily thread quota exhausted across all projects: ${document.created}/${this.max} used, ${count} requested`, { day: document.day, used: document.created, requested: count, max: this.max, scope: 'user' });
            }
            document.created = next;
            document.byProject[projectId] = (document.byProject[projectId] ?? 0) + count;
            return document;
        });
    }
    /** Give back `count` reservations that never became threads. */
    async release(projectId, count, nowMs) {
        if (!Number.isFinite(count) || count <= 0)
            return;
        await this.mutate(projectId, nowMs, (document) => {
            document.created = Math.max(0, document.created - count);
            const mine = Math.max(0, (document.byProject[projectId] ?? 0) - count);
            if (mine === 0)
                delete document.byProject[projectId];
            else
                document.byProject[projectId] = mine;
            return document;
        }).catch(() => undefined);
    }
    /**
     * Apply one mutation under the lock.
     *
     * Reads inside the lock, so the base is never stale: this is the cross-process equivalent
     * of the manifest store's re-read-then-CAS, and it is why two engines pointed at one
     * ledger cannot lose a count.
     */
    async mutate(projectId, nowMs, mutator) {
        await mkdir(dirname(this.path), { recursive: true });
        const release = await this.lock();
        try {
            const day = dayKey(nowMs);
            const document = mutator(parseLedger(await readIfPresent(this.path), day));
            await writeAtomic(this.path, `${JSON.stringify(document, null, 2)}\n`);
            return {
                day: document.day,
                created: document.created,
                max: this.max,
                project: document.byProject[projectId] ?? 0,
            };
        }
        finally {
            await release();
        }
    }
    /** Take the exclusive lock, breaking one that was abandoned by a dead process. */
    async lock() {
        const lockPath = `${this.path}.lock`;
        for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
            try {
                await writeFile(lockPath, `${String(process.pid)}\n`, { flag: 'wx' });
                return async () => {
                    await rm(lockPath, { force: true });
                };
            }
            catch (error) {
                if (!isExists(error))
                    throw error;
                // A process that crashed mid-write leaves its lock behind forever; without this the
                // plugin would refuse to start threads until someone deleted the file by hand.
                const info = await stat(lockPath).catch(() => undefined);
                if (info !== undefined && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
                    await rm(lockPath, { force: true });
                    continue;
                }
                await delay(LOCK_RETRY_MS);
            }
        }
        throw new ProjectError('QUOTA_EXCEEDED', `could not lock the thread ledger at ${lockPath}; another process is holding it`, {
            path: lockPath,
        });
    }
}
async function readIfPresent(path) {
    return readFile(path, 'utf8').catch(() => undefined);
}
async function writeAtomic(path, body) {
    const tmp = `${path}.tmp`;
    await writeFile(tmp, body, 'utf8');
    await renameWithRetry(tmp, path);
}
function isExists(error) {
    return typeof error === 'object' && error !== null && error.code === 'EEXIST';
}
async function delay(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}
