/**
 * Durable project record: atomic file IO with revision CAS.
 *
 * The Host `storage` service exposes no storage forms today, so this plugin owns
 * its own single-file record. All writes go through {@link ManifestStore.update},
 * which serialises in-process callers, re-reads the file, applies the mutation,
 * bumps `revision` by one, and replaces the file atomically (tmp + rename).
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ProjectError } from './errors.js';
import { cloneJson } from './util.js';
import type { Clock } from './util.js';
import type { ManifestDocument, ManifestSnapshot, ProjectManifest } from '../types.js';

/** Directory holding all plugin-owned project state, relative to the project root. */
export const PROJECT_DIR = '.dsh-project';
/** The durable record file name. */
export const MANIFEST_FILE = 'manifest.json';
/** Default instruction file, preferred over `AGENTS.md`. */
export const INSTRUCTIONS_FILE = 'PROJECT_INSTRUCTIONS.md';

/** Resolved paths for one project root. */
export interface ProjectPaths {
  rootDir: string;
  projectDir: string;
  manifestPath: string;
  instructionsPath: string;
  /** Rendered shared-memory mirror, refreshed on every memory write. */
  memoryMirrorPath: string;
}

export function projectPaths(rootDir: string): ProjectPaths {
  const projectDir = join(rootDir, PROJECT_DIR);
  return {
    rootDir,
    projectDir,
    manifestPath: join(projectDir, MANIFEST_FILE),
    instructionsPath: join(projectDir, INSTRUCTIONS_FILE),
    memoryMirrorPath: join(projectDir, 'SHARED_MEMORY.md'),
  };
}

/** Content written to `.dsh-project/.gitignore` so local state stays untracked. */
const PROJECT_GITIGNORE = ['manifest.json', 'manifest.json.tmp', 'SHARED_MEMORY.md', '*.log', ''].join('\n');

/** A mutation result paired with the manifest it produced. */
export interface MutationOutcome<R> {
  manifest: ProjectManifest;
  result: R;
}

/**
 * Serialised, atomic reader/writer for one project's manifest.
 *
 * Concurrent `update` calls queue in call order. Each queued mutation re-reads the
 * file, so a caller never observes a stale base and no CAS retry loop is needed
 * inside the plugin's own process.
 */
export class ManifestStore {
  readonly paths: ProjectPaths;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly rootDir: string,
    private readonly clock: Clock,
  ) {
    this.paths = projectPaths(rootDir);
  }

  /** Read the manifest, or `undefined` when the project was never initialised. */
  async tryRead(): Promise<ManifestSnapshot | undefined> {
    const text = await readFile(this.paths.manifestPath, 'utf8').catch((error: unknown) => {
      if (isMissing(error)) return undefined;
      throw new ProjectError('PROJECT_NOT_INITIALIZED', `cannot read ${this.paths.manifestPath}`, {
        cause: String(error),
      });
    });
    if (text === undefined) return undefined;
    return parseSnapshot(text, this.paths.manifestPath);
  }

  /** Read the manifest or fail with a typed "not initialised" error. */
  async read(): Promise<ManifestSnapshot> {
    const snapshot = await this.tryRead();
    if (snapshot === undefined) {
      throw new ProjectError(
        'PROJECT_NOT_INITIALIZED',
        `no project record at ${this.paths.manifestPath}; run \`/project init\` first`,
      );
    }
    return snapshot;
  }

  /** Whether a project record exists on disk. */
  async exists(): Promise<boolean> {
    return (await this.tryRead()) !== undefined;
  }

  /**
   * Apply one mutation under the CAS guard.
   *
   * The mutator receives a detached copy so it cannot alias stored state; its
   * returned manifest is re-stamped with `revision + 1` and `updatedAt`.
   */
  async update<R>(mutator: (draft: ProjectManifest) => MutationOutcome<R>): Promise<R> {
    const task = this.queue.then(async () => {
      const snapshot = await this.read();
      const draft = cloneJson(snapshot.manifest);
      const outcome = mutator(draft);
      const next: ProjectManifest = {
        ...outcome.manifest,
        revision: snapshot.version + 1,
        updatedAt: this.clock.now(),
      };
      // CAS on the revision we read, so a concurrent writer outside this queue is
      // detected instead of silently overwritten.
      await this.writeAtomic(next, snapshot.version);
      return outcome.result;
    });
    // Keep the queue alive even when this mutation rejects.
    this.queue = task.catch(() => undefined);
    return task;
  }

  /** Create the project record from scratch. Fails when one already exists. */
  async create(manifest: ProjectManifest): Promise<ProjectManifest> {
    if (await this.exists()) {
      throw new ProjectError('INVALID_INPUT', `project already initialised at ${this.paths.manifestPath}`);
    }
    await mkdir(this.paths.projectDir, { recursive: true });
    const stamped: ProjectManifest = {
      ...manifest,
      revision: 1,
      createdAt: this.clock.now(),
      updatedAt: this.clock.now(),
    };
    await this.writeAtomic(stamped);
    await ensureProjectScaffold(this.paths);
    return stamped;
  }

  /**
   * Overwrite the record.
   *
   * When `expectedVersion` is supplied this is a compare-and-swap: the on-disk revision
   * must still equal it, or the write is rejected with `STALE_REVISION`. The in-process
   * queue already serialises writers inside one engine, but two engines — a reloaded
   * plugin beside the one that is still holding a manifest, or the Host restarting
   * mid-turn — would otherwise silently drop whichever change landed second.
   */
  async writeAtomic(manifest: ProjectManifest, expectedVersion?: number): Promise<void> {
    await mkdir(dirname(this.paths.manifestPath), { recursive: true });
    if (expectedVersion !== undefined) {
      const onDisk = await this.tryRead();
      const current = onDisk?.version ?? 0;
      if (current !== expectedVersion) {
        throw new ProjectError('STALE_REVISION', `project record changed under this writer (expected r${String(expectedVersion)}, found r${String(current)})`, {
          expectedVersion,
          currentVersion: current,
        });
      }
    }
    const document: ManifestDocument = { schema: 1, manifest };
    const body = `${JSON.stringify(document, null, 2)}\n`;
    const tmp = `${this.paths.manifestPath}.tmp`;
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, this.paths.manifestPath);
  }

  /** Delete the record and its scratch files (project de-initialisation). */
  async destroy(): Promise<void> {
    await rm(this.paths.manifestPath, { force: true });
    await rm(`${this.paths.manifestPath}.tmp`, { force: true });
  }
}

/** Create the on-disk scaffold that must exist for a usable project. */
async function ensureProjectScaffold(paths: ProjectPaths): Promise<void> {
  await mkdir(paths.projectDir, { recursive: true });
  await writeIfAbsent(join(paths.projectDir, '.gitignore'), PROJECT_GITIGNORE);
  await writeIfAbsent(
    paths.instructionsPath,
    [
      '# Project instructions',
      '',
      'Long-lived guidance every thread in this project must follow.',
      'Edit this file directly; it is mounted into each thread\'s system prompt.',
      '',
    ].join('\n'),
  );
}

async function writeIfAbsent(path: string, body: string): Promise<void> {
  const existing = await readFile(path, 'utf8').catch(() => undefined);
  if (existing !== undefined) return;
  await writeFile(path, body, 'utf8');
}

/** Parse and structurally validate one manifest document. */
export function parseSnapshot(text: string, path: string): ManifestSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ProjectError('INVALID_INPUT', `project record at ${path} is not valid JSON`, {
      cause: String(error),
    });
  }
  const document = parsed as Partial<ManifestDocument> | null;
  if (document === null || typeof document !== 'object' || document.schema !== 1) {
    throw new ProjectError('INVALID_INPUT', `project record at ${path} has an unsupported schema`);
  }
  const manifest = document.manifest;
  if (manifest === undefined || typeof manifest !== 'object') {
    throw new ProjectError('INVALID_INPUT', `project record at ${path} is missing its manifest`);
  }
  if (!Array.isArray(manifest.knowledgePaths)) manifest.knowledgePaths = [];
  if (manifest.memories === undefined || typeof manifest.memories !== 'object') manifest.memories = {};
  if (manifest.threads === undefined || typeof manifest.threads !== 'object') manifest.threads = {};
  return { manifest, version: typeof manifest.revision === 'number' ? manifest.revision : 0 };
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT';
}
