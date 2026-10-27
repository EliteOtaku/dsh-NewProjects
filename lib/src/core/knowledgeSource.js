/**
 * Turning bound knowledge paths into indexable text.
 *
 * The manifest stores paths, but a project's knowledge is the *content* under them: a folder
 * bound as knowledge means every readable file inside it. This module is the only place that
 * touches the filesystem for knowledge, so the rest of the feature stays testable on plain
 * strings.
 *
 * Skips are deliberate and reported. A knowledge folder that silently omits `node_modules`
 * is fine; one that silently omits a 300 KB design doc because it tripped a limit must say
 * so, or the user will believe the project knows something it does not.
 */
import { readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { parseIndex, serialiseIndex } from './knowledge.js';
/** Largest single file we will index. */
export const MAX_KNOWLEDGE_FILE_BYTES = 2 * 1024 * 1024;
/** Files we never descend into: dependencies, VCS internals, plugin state, build output. */
const IGNORED_DIRECTORIES = new Set([
    '.git',
    '.hg',
    '.svn',
    'node_modules',
    'bower_components',
    'dist',
    'build',
    'out',
    'target',
    'coverage',
    '__pycache__',
    '.venv',
    'venv',
    '.next',
    '.nuxt',
    '.cache',
    '.dsh-project',
    '.idea',
    '.vscode',
]);
/** Extensions that are never text; reading them only produces replacement characters. */
const BINARY_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff', '.avif',
    '.pdf', '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.tar',
    '.mp3', '.wav', '.flac', '.ogg', '.m4a', '.mp4', '.mov', '.avi', '.mkv', '.webm',
    '.woff', '.woff2', '.ttf', '.otf', '.eot',
    '.exe', '.dll', '.so', '.dylib', '.a', '.o', '.obj', '.class', '.jar', '.wasm',
    '.sqlite', '.db', '.bin', '.dat', '.pyc', '.node', '.asar',
]);
/**
 * Rewrite a path with forward slashes.
 *
 * The index is read back as citations in prompts and tool results, and the plugin runs on
 * every platform: a project indexed on Windows must not produce `kb\a.md` citations that a
 * Linux run cannot match against the same file.
 */
function toPosixPath(path) {
    return sep === '/' ? path : path.split(sep).join('/');
}
function isBinaryName(name) {
    const lower = name.toLowerCase();
    const dot = lower.lastIndexOf('.');
    if (dot <= 0)
        return false;
    return BINARY_EXTENSIONS.has(lower.slice(dot));
}
/**
 * Read one bound path, descending into directories.
 *
 * Directories are walked breadth-first in stable name order so two runs over the same tree
 * index the same documents in the same order; an index whose order depends on filesystem
 * enumeration order would make every rebuild look like a change.
 */
async function collectPath(bound, options, budget, result, signal) {
    const absolute = resolve(options.rootDir, bound);
    const display = toPosixPath(bound.trim());
    const info = await stat(absolute).catch(() => undefined);
    if (info === undefined) {
        result.warnings.push(`knowledge path does not exist: ${display}`);
        return;
    }
    if (info.isFile()) {
        await readOne(absolute, display, options, budget, result);
        return;
    }
    if (!info.isDirectory()) {
        result.warnings.push(`knowledge path is neither a file nor a directory: ${display}`);
        return;
    }
    const queue = [absolute];
    while (queue.length > 0) {
        if (signal?.aborted === true)
            return;
        const directory = queue.shift();
        if (directory === undefined)
            break;
        const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
            result.warnings.push(`could not list ${toPosixPath(relative(options.rootDir, directory))}: ${String(error)}`);
            return [];
        });
        const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of sorted) {
            if (entry.isDirectory()) {
                if (IGNORED_DIRECTORIES.has(entry.name))
                    continue;
                if (entry.name.startsWith('.') && entry.name !== '.') {
                    // Dot-directories are tooling state far more often than knowledge.
                    continue;
                }
                queue.push(join(directory, entry.name));
                continue;
            }
            if (!entry.isFile())
                continue;
            if (isBinaryName(entry.name))
                continue;
            if (budget.remaining <= 0) {
                result.truncated = true;
                return;
            }
            await readOne(join(directory, entry.name), toPosixPath(relative(options.rootDir, join(directory, entry.name))), options, budget, result);
        }
    }
}
async function readOne(absolute, display, options, budget, result) {
    const maxBytes = options.maxFileBytes ?? MAX_KNOWLEDGE_FILE_BYTES;
    const info = await stat(absolute).catch(() => undefined);
    if (info === undefined)
        return;
    if (info.size > maxBytes) {
        result.warnings.push(`skipped ${display}: ${info.size} bytes exceeds the ${maxBytes}-byte file cap`);
        return;
    }
    const text = await readFile(absolute, 'utf8').catch(() => undefined);
    if (text === undefined) {
        result.warnings.push(`could not read ${display}`);
        return;
    }
    // A NUL byte in the first block is the cheapest reliable binary signal for files whose
    // extension lies (vendored blobs, mislabelled assets).
    if (text.slice(0, 4_096).includes('\u0000')) {
        result.warnings.push(`skipped ${display}: looks like binary content`);
        return;
    }
    if (text.trim().length === 0)
        return;
    budget.remaining -= text.length;
    result.documents.push({ path: display, text });
    result.totalChars += text.length;
}
/** Read every bound path into indexable documents. */
export async function collectKnowledge(paths, options) {
    const result = { documents: [], warnings: [], totalChars: 0, truncated: false };
    const budget = { remaining: Math.max(1, options.maxChars) };
    for (const bound of paths) {
        const trimmed = bound.trim();
        if (trimmed.length === 0)
            continue;
        await collectPath(trimmed, options, budget, result, options.signal);
        if (budget.remaining <= 0) {
            result.truncated = true;
            result.warnings.push(`knowledge collection stopped at the ${options.maxChars}-character capacity; later paths were not indexed`);
            break;
        }
    }
    return result;
}
/** Read a stored index, treating any problem as "not built yet". */
export async function readIndexFile(path) {
    const text = await readFile(path, 'utf8').catch(() => undefined);
    return text === undefined ? undefined : parseIndex(text);
}
/** Persist an index atomically (tmp + rename), matching the manifest store's approach. */
export async function writeIndexFile(path, index) {
    const tmp = `${path}.tmp`;
    await writeFile(tmp, serialiseIndex(index), 'utf8');
    await rename(tmp, path);
}
