/**
 * Cross-thread shared memory.
 *
 * Two delivery channels, by design:
 *
 * 1. **Prefix channel** (KV-cache friendly): {@link renderMemoryPrefix} produces a
 *    deterministic block mounted at a fixed system-prompt slot. It is a pure
 *    function of the memory set, so the bytes stay identical across turns and
 *    across sibling threads until a decision actually changes. `prefixVersion`
 *    and {@link fingerprint} let the panel prove the prefix did not churn.
 *
 * 2. **Delta channel** (freshness): {@link renderMemoryDelta} emits only entries a
 *    running thread has not yet acknowledged, injected at the turn boundary so a
 *    decision made mid-flight reaches live threads without rewriting their prefix.
 */

import { fingerprint } from './util.js';
import type { Clock } from './util.js';
import type { ProjectManifest, ProjectMemoryEntry } from '../types.js';

/** Sentinel author for entries written through the coordinator or the user command. */
export const COORDINATOR_AUTHOR = 'coordinator';

/** Normalise a caller-supplied memory key into `[a-z0-9][a-z0-9._-]*`. */
export function normaliseMemoryKey(raw: string): string {
  // Strip the edge characters *after* truncating: slicing first would let a key end in
  // a dash, which reads as a typo and invites `--` when keys are concatenated.
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .slice(0, 64)
    .replace(/^[-.]+|[-.]+$/g, '');
}

/** Entries sorted by key, the canonical order for rendering and diffing. */
export function sortedMemories(manifest: ProjectManifest): ProjectMemoryEntry[] {
  return Object.values(manifest.memories).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Fingerprint of the exact prefix bytes.
 *
 * Stored alongside the rendered prefix so a thread can assert "my prefix did not
 * change" without diffing text.
 */
export function memoryPrefixFingerprint(manifest: ProjectManifest): string {
  return fingerprint(renderMemoryPrefix(manifest));
}

/** Mutate one memory entry, bumping its revision and the manifest prefix version. */
export function upsertMemory(
  manifest: ProjectManifest,
  input: { key: string; decision: string; rationale?: string; author?: string },
  clock: Clock,
): ProjectMemoryEntry {
  const key = normaliseMemoryKey(input.key);
  const decision = input.decision.trim();
  if (key.length === 0) throw new Error('memory key must contain at least one alphanumeric character');
  if (decision.length === 0) throw new Error('memory decision must not be empty');
  const previous = manifest.memories[key];
  const entry: ProjectMemoryEntry = {
    key,
    decision,
    rationale: (input.rationale ?? previous?.rationale ?? '').trim(),
    updatedAt: clock.now(),
    revision: (previous?.revision ?? 0) + 1,
    authorThreadId: input.author ?? COORDINATOR_AUTHOR,
  };
  manifest.memories[key] = entry;
  manifest.prefixVersion += 1;
  return entry;
}

/** Remove one entry; returns whether it existed. */
export function removeMemory(manifest: ProjectManifest, rawKey: string): boolean {
  const key = normaliseMemoryKey(rawKey);
  if (manifest.memories[key] === undefined) return false;
  delete manifest.memories[key];
  manifest.prefixVersion += 1;
  return true;
}

/**
 * Render the stable prefix block.
 *
 * Constraints that keep KV cache hits high:
 * - No timestamps, thread ids, or counters inside the block.
 * - Entries sorted by key, never by insertion or update time.
 * - Empty memory renders as `''` so the slot contributes nothing at all.
 */
export function renderMemoryPrefix(manifest: ProjectManifest): string {
  const entries = sortedMemories(manifest);
  if (entries.length === 0) return '';
  const lines = ['## Shared project memory', '', 'Decisions below are binding for every thread in this project. Do not contradict or silently reverse them; raise a conflict instead.', ''];
  for (const entry of entries) {
    lines.push(`- **${entry.key}** — ${entry.decision}`);
    if (entry.rationale.length > 0) lines.push(`  - why: ${entry.rationale}`);
  }
  return lines.join('\n');
}

/**
 * Render only entries newer than what this thread has already seen.
 *
 * Returns `''` when nothing is new, which is the common case and keeps the
 * injected message out of the transcript entirely.
 */
export function renderMemoryDelta(manifest: ProjectManifest, seen: Record<string, number>): string {
  const fresh = sortedMemories(manifest).filter((entry) => (seen[entry.key] ?? 0) < entry.revision);
  if (fresh.length === 0) return '';
  const lines = ['[project-memory] Shared memory changed while you were working. Updated decisions:', ''];
  for (const entry of fresh) {
    lines.push(`- **${entry.key}** — ${entry.decision}`);
    if (entry.rationale.length > 0) lines.push(`  - why: ${entry.rationale}`);
  }
  lines.push('', 'Apply these from now on. If one contradicts your current plan, stop and report the conflict rather than choosing silently.');
  return lines.join('\n');
}

/** Record every current entry as seen, returning the new watermark map. */
export function markSeen(manifest: ProjectManifest, seen: Record<string, number>): Record<string, number> {
  const next: Record<string, number> = { ...seen };
  for (const entry of Object.values(manifest.memories)) next[entry.key] = entry.revision;
  return next;
}

/** Render the human-readable mirror written to `.dsh-project/SHARED_MEMORY.md`. */
export function renderMemoryMirror(manifest: ProjectManifest): string {
  const entries = sortedMemories(manifest);
  const header = ['# Shared project memory', '', `Revisions: manifest r${manifest.revision}, prefix v${manifest.prefixVersion}.`, '', 'Generated by dsh-project-beta; edits here are overwritten. Use `project_memory_sync` instead.', ''];
  if (entries.length === 0) {
    header.push('_No shared decisions recorded yet._', '');
    return header.join('\n');
  }
  for (const entry of entries) {
    header.push(`## ${entry.key}`, '', entry.decision, '');
    if (entry.rationale.length > 0) header.push(`_Why:_ ${entry.rationale}`, '');
    header.push(`_Revision ${entry.revision}, author \`${entry.authorThreadId}\`, updated ${new Date(entry.updatedAt).toISOString()}._`, '');
  }
  return header.join('\n');
}
