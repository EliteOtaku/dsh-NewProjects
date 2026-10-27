/** Small shared primitives: clock, ids, day keys, hashing. */

/** Injectable time source so tests are deterministic. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** Injectable id source so tests are deterministic. */
export interface IdFactory {
  threadId(prefix?: string): string;
  projectId(): string;
}

export const systemIds: IdFactory = {
  threadId(prefix = 'thread') {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  },
  projectId() {
    return `proj-${Math.random().toString(36).slice(2, 10)}`;
  },
};

/** Local calendar day key, `YYYY-MM-DD`. */
export function dayKey(epochMs: number): string {
  const d = new Date(epochMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * FNV-1a 32-bit hex digest.
 *
 * Used only to fingerprint prompt prefixes (cache-stability checks) — never for
 * security. A non-cryptographic digest keeps the plugin dependency-free.
 */
export function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Clamp helper used by quota/config normalisation. */
export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** Deterministic deep clone for plain JSON records (no cycles by contract). */
export function cloneJson<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}
