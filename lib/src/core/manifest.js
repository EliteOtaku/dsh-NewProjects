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
/** Directory holding all plugin-owned project state, relative to the project root. */
export const PROJECT_DIR = '.dsh-project';
/** The durable record file name. */
export const MANIFEST_FILE = 'manifest.json';
/** Default instruction file, preferred over `AGENTS.md`. */
export const INSTRUCTIONS_FILE = 'PROJECT_INSTRUCTIONS.md';
/** Transient rename failures Windows reports when another process briefly holds the target. */
const RETRYABLE_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY']);
/** Attempts before a rename is treated as a real failure. */
const RENAME_ATTEMPTS = 5;
/**
 * Replace a file atomically, retrying the Windows-only transient failures.
 *
 * On POSIX a rename over an open file succeeds, so this is a no-op there. On Windows it fails
 * with `EPERM`/`EBUSY` whenever an indexer, an antivirus scanner, or a second reader holds the
 * destination for a moment — a condition that clears by itself in milliseconds. Retrying is the
 * difference between a record write that occasionally fails for no reason the user can act on
 * and one that does not; a genuine permission problem still fails after the last attempt.
 */
async function renameWithRetry(from, to) {
    let lastError;
    for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt += 1) {
        try {
            await rename(from, to);
            return;
        }
        catch (error) {
            const code = error.code;
            if (typeof code !== 'string' || !RETRYABLE_RENAME.has(code))
                throw error;
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 5 * 2 ** attempt));
        }
    }
    throw lastError;
}
export function projectPaths(rootDir) {
    const projectDir = join(rootDir, PROJECT_DIR);
    return {
        rootDir,
        projectDir,
        manifestPath: join(projectDir, MANIFEST_FILE),
        instructionsPath: join(projectDir, INSTRUCTIONS_FILE),
        memoryMirrorPath: join(projectDir, 'SHARED_MEMORY.md'),
        worktreeRoot: join(projectDir, 'worktrees'),
        knowledgeIndexPath: join(projectDir, 'KNOWLEDGE_INDEX.json'),
    };
}
/** Content written to `.dsh-project/.gitignore` so local state stays untracked. */
const PROJECT_GITIGNORE = [
    'manifest.json',
    'manifest.json.tmp',
    'SHARED_MEMORY.md',
    // Rebuildable from the bound files, so it is derived state rather than a project artefact.
    'KNOWLEDGE_INDEX.json',
    'KNOWLEDGE_INDEX.json.tmp',
    // Thread worktrees live inside the project directory so one cleanup removes them, and
    // git must never see a checkout nested in its own repository.
    'worktrees/',
    '*.log',
    '',
].join('\n');
/**
 * Serialised, atomic reader/writer for one project's manifest.
 *
 * Concurrent `update` calls queue in call order. Each queued mutation re-reads the
 * file, so a caller never observes a stale base and no CAS retry loop is needed
 * inside the plugin's own process.
 */
export class ManifestStore {
    rootDir;
    clock;
    paths;
    queue = Promise.resolve();
    constructor(rootDir, clock) {
        this.rootDir = rootDir;
        this.clock = clock;
        this.paths = projectPaths(rootDir);
    }
    /** Read the manifest, or `undefined` when the project was never initialised. */
    async tryRead() {
        const text = await readFile(this.paths.manifestPath, 'utf8').catch((error) => {
            if (isMissing(error))
                return undefined;
            throw new ProjectError('PROJECT_NOT_INITIALIZED', `cannot read ${this.paths.manifestPath}`, {
                cause: String(error),
            });
        });
        if (text === undefined)
            return undefined;
        return parseSnapshot(text, this.paths.manifestPath);
    }
    /** Read the manifest or fail with a typed "not initialised" error. */
    async read() {
        const snapshot = await this.tryRead();
        if (snapshot === undefined) {
            throw new ProjectError('PROJECT_NOT_INITIALIZED', `no project record at ${this.paths.manifestPath}; run \`/project init\` first`);
        }
        return snapshot;
    }
    /** Whether a project record exists on disk. */
    async exists() {
        return (await this.tryRead()) !== undefined;
    }
    /**
     * Apply one mutation under the CAS guard.
     *
     * The mutator receives a detached copy so it cannot alias stored state; its
     * returned manifest is re-stamped with `revision + 1` and `updatedAt`.
     */
    async update(mutator) {
        const task = this.queue.then(async () => {
            const snapshot = await this.read();
            const draft = cloneJson(snapshot.manifest);
            const outcome = mutator(draft);
            const next = {
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
    async create(manifest) {
        if (await this.exists()) {
            throw new ProjectError('INVALID_INPUT', `project already initialised at ${this.paths.manifestPath}`);
        }
        await mkdir(this.paths.projectDir, { recursive: true });
        const stamped = {
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
    async writeAtomic(manifest, expectedVersion) {
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
        const document = { schema: 1, manifest };
        const body = `${JSON.stringify(document, null, 2)}\n`;
        const tmp = `${this.paths.manifestPath}.tmp`;
        await writeFile(tmp, body, 'utf8');
        await renameWithRetry(tmp, this.paths.manifestPath);
    }
    /** Delete the record and its scratch files (project de-initialisation). */
    async destroy() {
        await rm(this.paths.manifestPath, { force: true });
        await rm(`${this.paths.manifestPath}.tmp`, { force: true });
    }
}
/** Create the on-disk scaffold that must exist for a usable project. */
async function ensureProjectScaffold(paths) {
    await mkdir(paths.projectDir, { recursive: true });
    await writeIfAbsent(join(paths.projectDir, '.gitignore'), PROJECT_GITIGNORE);
    await writeIfAbsent(paths.instructionsPath, [
        '# Project instructions',
        '',
        'Long-lived guidance every thread in this project must follow.',
        'Edit this file directly; it is mounted into each thread\'s system prompt.',
        '',
    ].join('\n'));
}
async function writeIfAbsent(path, body) {
    const existing = await readFile(path, 'utf8').catch(() => undefined);
    if (existing !== undefined)
        return;
    await writeFile(path, body, 'utf8');
}
/** Parse and structurally validate one manifest document. */
export function parseSnapshot(text, path) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (error) {
        throw new ProjectError('INVALID_INPUT', `project record at ${path} is not valid JSON`, {
            cause: String(error),
        });
    }
    const document = parsed;
    if (document === null || typeof document !== 'object' || document.schema !== 1) {
        throw new ProjectError('INVALID_INPUT', `project record at ${path} has an unsupported schema`);
    }
    const manifest = document.manifest;
    if (manifest === undefined || typeof manifest !== 'object') {
        throw new ProjectError('INVALID_INPUT', `project record at ${path} is missing its manifest`);
    }
    if (!Array.isArray(manifest.knowledgePaths))
        manifest.knowledgePaths = [];
    if (manifest.memories === undefined || typeof manifest.memories !== 'object')
        manifest.memories = {};
    if (manifest.threads === undefined || typeof manifest.threads !== 'object')
        manifest.threads = {};
    return { manifest, version: typeof manifest.revision === 'number' ? manifest.revision : 0 };
}
function isMissing(error) {
    return typeof error === 'object' && error !== null && error.code === 'ENOENT';
}
