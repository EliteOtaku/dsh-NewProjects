/**
 * A canonical manifest for tests.
 *
 * Kept in one place so every suite starts from the same shape; a test that needs a
 * deviation should patch this object rather than hand-build a manifest, which is how
 * fixtures drift out of sync with the real type.
 */

import type { ProjectManifest } from '../../src/types.js';

/** Options that a test may override. */
export interface ManifestOverrides {
  rootDir?: string;
  name?: string;
  dailyThreadQuotaMax?: number;
  dailyThreadsCreated?: number;
  quotaDay?: string;
  pausedAt?: number;
  pauseReason?: string;
  maxConcurrentThreads?: number;
  threads?: ProjectManifest['threads'];
}

/** Build a manifest with the given overrides. */
export function makeManifest(overrides: ManifestOverrides = {}): ProjectManifest {
  return {
    projectId: 'prj-test',
    name: overrides.name ?? 'demo',
    revision: 0,
    rootDir: overrides.rootDir ?? '/tmp/demo',
    instructionsPath: `${overrides.rootDir ?? '/tmp/demo'}/.dsh-project/PROJECT_INSTRUCTIONS.md`,
    knowledgePaths: [],
    dailyThreadQuotaMax: overrides.dailyThreadQuotaMax ?? 200,
    dailyThreadsCreated: overrides.dailyThreadsCreated ?? 0,
    quotaDay: overrides.quotaDay ?? '2026-01-02',
    memories: {},
    threads: overrides.threads ?? {},
    createdAt: Date.parse('2026-01-01T00:00:00Z'),
    updatedAt: Date.parse('2026-01-01T00:00:00Z'),
    ciPollIntervalMs: 60_000,
    prefixVersion: 0,
    ...(overrides.pausedAt === undefined ? {} : { pausedAt: overrides.pausedAt }),
    ...(overrides.pauseReason === undefined ? {} : { pauseReason: overrides.pauseReason }),
    ...(overrides.maxConcurrentThreads === undefined ? {} : { maxConcurrentThreads: overrides.maxConcurrentThreads }),
  };
}
