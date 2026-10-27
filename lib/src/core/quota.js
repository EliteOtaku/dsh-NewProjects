/**
 * Daily thread quota.
 *
 * Mirrors the Projects Beta guard rail: at most `dailyThreadQuotaMax` new threads
 * across all projects per local calendar day, default 200. The ledger lives inside
 * each project record; `rollover` resets it when the local day changes, so a stale
 * record can never block a new day.
 */
import { ProjectError } from './errors.js';
import { clampInt, dayKey } from './util.js';
/** Hard ceiling accepted for `dailyThreadQuotaMax`. */
export const QUOTA_MAX_CEILING = 200;
/** Lower bound accepted for `dailyThreadQuotaMax`. */
export const QUOTA_MIN = 1;
/** Normalise a configured ceiling into the accepted range. */
export function normaliseQuotaMax(value) {
    if (value === undefined)
        return QUOTA_MAX_CEILING;
    return clampInt(value, QUOTA_MIN, QUOTA_MAX_CEILING);
}
/**
 * Roll the ledger to `day`, resetting the counter when the day changed.
 *
 * Mutates the draft manifest in place and reports whether a rollover happened, so
 * callers can decide to persist.
 */
export function rolloverQuota(manifest, day) {
    if (manifest.quotaDay === day)
        return false;
    manifest.quotaDay = day;
    manifest.dailyThreadsCreated = 0;
    return true;
}
/** Current ledger view for one manifest at one instant. */
export function quotaState(manifest, nowMs) {
    const day = dayKey(nowMs);
    const current = manifest.quotaDay === day ? manifest.dailyThreadsCreated : 0;
    return { day, created: current, max: normaliseQuotaMax(manifest.dailyThreadQuotaMax) };
}
/** Remaining threads available today; never negative. */
export function quotaRemaining(state) {
    return Math.max(0, state.max - state.created);
}
/**
 * Reserve `count` threads against the daily ledger.
 *
 * Reserves all-or-nothing: a request that would exceed the ceiling throws
 * {@link ProjectError} `QUOTA_EXCEEDED` and leaves the ledger untouched.
 */
export function reserveQuota(manifest, count, nowMs) {
    // A zero or negative batch is a caller bug, not a no-op: negative would *increase*
    // remaining budget by walking the ledger backwards, which belongs to `releaseQuota`
    // where it is bounded at zero.
    if (!Number.isFinite(count) || count <= 0) {
        throw new ProjectError('INVALID_INPUT', `reservation count must be a positive integer, got ${count}`);
    }
    const day = dayKey(nowMs);
    rolloverQuota(manifest, day);
    const max = normaliseQuotaMax(manifest.dailyThreadQuotaMax);
    const next = manifest.dailyThreadsCreated + count;
    if (next > max) {
        throw new ProjectError('QUOTA_EXCEEDED', `daily thread quota exhausted: ${manifest.dailyThreadsCreated}/${max} used, ${count} requested`, {
            day,
            used: manifest.dailyThreadsCreated,
            requested: count,
            max,
        });
    }
    manifest.dailyThreadsCreated = next;
    return { day, created: next, max };
}
/** Release `count` reservations, e.g. when thread creation failed after reserving. */
export function releaseQuota(manifest, count, nowMs) {
    if (manifest.quotaDay !== dayKey(nowMs))
        return;
    manifest.dailyThreadsCreated = Math.max(0, manifest.dailyThreadsCreated - count);
}
/** Warn when the ledger is close to the ceiling (`>= 80%`). */
export function quotaWarning(state) {
    if (state.max <= 0)
        return undefined;
    const ratio = state.created / state.max;
    if (ratio < 0.8)
        return undefined;
    return `daily thread quota at ${state.created}/${state.max} (${Math.round(ratio * 100)}%) for ${state.day}`;
}
