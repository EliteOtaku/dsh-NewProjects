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
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { ProjectError } from './errors.js';
import { parseIndex, serialiseIndex } from './knowledge.js';
import type { KnowledgeIndex } from './knowledge.js';

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

/** Remaining room in a collection run: characters and file slots. */
interface CollectBudget {
  remaining: number;
  files: number;
}

/** One document read from disk, ready to index. */
export interface CollectedDocument {
  /** Path as the caller bound it when relative, otherwise absolute; used for citation. */
  path: string;
  text: string;
}

/** Result of collecting knowledge for a set of roots. */
export interface CollectResult {
  documents: CollectedDocument[];
  warnings: string[];
  /** Characters read, before chunking. */
  totalChars: number;
  /** True when the collection stopped early because it hit the capacity ceiling. */
  truncated: boolean;
}

/** Options for {@link collectKnowledge}. */
export interface CollectOptions {
  /** Directory relative paths resolve against. */
  rootDir: string;
  /** Hard ceiling on total characters; collection stops once it is exceeded. */
  maxChars: number;
  /**
   * Hard ceiling on indexed files; collection stops once it is reached.
   *
   * The official limit is phrased this way — a folder contributes "its first 100 files" —
   * and a file count is the bound that actually protects the walk: one directory of ten
   * thousand small files passes any character budget while still taking minutes to read.
   */
  maxFiles?: number;
  /** Per-file byte cap. */
  maxFileBytes?: number;
  signal?: AbortSignal;
}

/**
 * Rewrite a path with forward slashes.
 *
 * The index is read back as citations in prompts and tool results, and the plugin runs on
 * every platform: a project indexed on Windows must not produce `kb\a.md` citations that a
 * Linux run cannot match against the same file.
 */
function toPosixPath(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

function isBinaryName(name: string): boolean {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot <= 0) return false;
  return BINARY_EXTENSIONS.has(lower.slice(dot));
}

/**
 * Directories that never hold knowledge.
 *
 * One predicate because three walks share the rule (collection, `tree` and the staleness
 * stamp): if they disagreed, the tree would offer a file the index never reads, or the
 * stamp would miss a change inside a directory the index does read.
 */
function isSkippedDirectory(name: string): boolean {
  if (IGNORED_DIRECTORIES.has(name)) return true;
  // Dot-directories are tooling state far more often than knowledge.
  return name.startsWith('.') && name !== '.';
}

/**
 * Read one bound path, descending into directories.
 *
 * Directories are walked breadth-first in stable name order so two runs over the same tree
 * index the same documents in the same order; an index whose order depends on filesystem
 * enumeration order would make every rebuild look like a change.
 */
async function collectPath(
  bound: string,
  options: CollectOptions,
  budget: CollectBudget,
  result: CollectResult,
  signal: AbortSignal | undefined,
): Promise<void> {
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

  const queue: string[] = [absolute];
  while (queue.length > 0) {
    if (signal?.aborted === true) return;
    const directory = queue.shift();
    if (directory === undefined) break;

    const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
      result.warnings.push(`could not list ${toPosixPath(relative(options.rootDir, directory))}: ${String(error)}`);
      return [];
    });
    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of sorted) {
      if (entry.isDirectory()) {
        if (isSkippedDirectory(entry.name)) continue;
        queue.push(join(directory, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (isBinaryName(entry.name)) continue;
      if (budget.remaining <= 0 || budget.files <= 0) {
        result.truncated = true;
        return;
      }
      await readOne(
        join(directory, entry.name),
        toPosixPath(relative(options.rootDir, join(directory, entry.name))),
        options,
        budget,
        result,
      );
    }
  }
}

async function readOne(
  absolute: string,
  display: string,
  options: CollectOptions,
  budget: CollectBudget,
  result: CollectResult,
): Promise<void> {
  const maxBytes = options.maxFileBytes ?? MAX_KNOWLEDGE_FILE_BYTES;
  const info = await stat(absolute).catch(() => undefined);
  if (info === undefined) return;
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
  if (text.trim().length === 0) return;

  budget.remaining -= text.length;
  budget.files -= 1;
  result.documents.push({ path: display, text });
  result.totalChars += text.length;
}

/** Read every bound path into indexable documents. */
export async function collectKnowledge(
  paths: readonly string[],
  options: CollectOptions,
): Promise<CollectResult> {
  const result: CollectResult = { documents: [], warnings: [], totalChars: 0, truncated: false };
  const budget: CollectBudget = {
    remaining: Math.max(1, options.maxChars),
    files: options.maxFiles === undefined ? Number.POSITIVE_INFINITY : Math.max(1, options.maxFiles),
  };
  for (const bound of paths) {
    const trimmed = bound.trim();
    if (trimmed.length === 0) continue;
    await collectPath(trimmed, options, budget, result, options.signal);
    // Both ceilings are reported by name. "Collection stopped" without saying which limit
    // was hit leaves the user guessing whether to split a file or drop one.
    if (budget.files <= 0) {
      result.truncated = true;
      result.warnings.push(
        `knowledge collection stopped at the ${String(options.maxFiles)}-file limit; later paths were not indexed`,
      );
      break;
    }
    if (budget.remaining <= 0) {
      result.truncated = true;
      result.warnings.push(
        `knowledge collection stopped at the ${options.maxChars}-character capacity; later paths were not indexed`,
      );
      break;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Navigating bound knowledge without an index
//
// The index is a convenience: it ranks passages the model already guessed keywords for.
// Mounted knowledge is a folder, so the model needs the plain folder operations too —
// list a tree, read a line window — or a search miss leaves it with no way in at all.
// Both read the project root rather than the caller's checkout: a thread's worktree only
// holds what was committed when its branch was cut, so an uncommitted knowledge file
// exists under the project root and nowhere else.
// ---------------------------------------------------------------------------

/** Default and hard bounds for the `tree` action. */
export const DEFAULT_TREE_DEPTH = 2;
export const MAX_TREE_DEPTH = 4;
export const DEFAULT_TREE_LIMIT = 200;
export const MAX_TREE_LIMIT = 500;

/** Default and hard bounds for the `read` action. */
export const DEFAULT_READ_LINES = 200;
export const MAX_READ_LINES = 2_000;

/** One row of {@link listKnowledgeTree}. */
export interface KnowledgeTreeEntry {
  /** Path relative to the project root, so it can be passed straight back to `read`. */
  path: string;
  kind: 'file' | 'dir';
  /**
   * Size in bytes, for files.
   *
   * Bytes rather than characters: describing a file must not require reading it, which is
   * the whole point of a paths-first knowledge model. A byte count is enough to tell a
   * two-page note from a transcript.
   */
  bytes?: number;
}

/** Result of {@link listKnowledgeTree}. */
export interface KnowledgeTreeResult {
  /** Requested directory, relative to the project root (`.` for the root itself). */
  path: string;
  entries: KnowledgeTreeEntry[];
  /** True when a limit cut the walk; {@link note} says which one. */
  truncated: boolean;
  /** Names the limit that stopped the walk; empty when the tree is complete. */
  note: string;
  limit: number;
  depth: number;
}

/** One line window of a knowledge file, as returned by {@link readKnowledgeFile}. */
export interface KnowledgeFileSlice {
  /** Path relative to the project root. */
  path: string;
  /** First line of the window (1-based). */
  from: number;
  /** Last line of the window (1-based); `from - 1` when the window is empty. */
  to: number;
  totalLines: number;
  /** True when lines exist after the window, so the caller knows it saw a fragment. */
  truncated: boolean;
  text: string;
}

/** Clamp a caller-supplied integer into `[min, max]`, or fall back when it is absent. */
function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * Resolve one caller-supplied path against the project root, refusing anything outside it.
 *
 * Both actions go through this one function on purpose: a second copy of the escape check
 * would drift, and the copy that drifted would be the one that let `../../secrets` through.
 */
function resolveInsideRoot(rootDir: string, candidate: string): { absolute: string; display: string } {
  const trimmed = candidate.trim();
  if (trimmed.length === 0) throw new ProjectError('INVALID_INPUT', 'path must not be empty');
  const absolute = resolve(rootDir, trimmed);
  const rel = relative(rootDir, absolute);
  if (rel.length === 0) return { absolute, display: '.' };
  // A path on another Windows drive comes back absolute from `relative`, so the `..` test
  // alone would miss it.
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new ProjectError(
      'INVALID_INPUT',
      `path \`${trimmed}\` is outside the project root; knowledge is read from the project root only`,
    );
  }
  return { absolute, display: toPosixPath(rel) };
}

/**
 * List a directory tree under the project root.
 *
 * Bounded by depth and entry count, and every cut is named in {@link KnowledgeTreeResult.note}:
 * half a tree that does not say it is half a tree is worse than no tree, because the model
 * reads it as the complete picture and stops looking.
 */
export async function listKnowledgeTree(
  rootDir: string,
  options: { path?: string; depth?: number; limit?: number } = {},
): Promise<KnowledgeTreeResult> {
  const { absolute, display } = resolveInsideRoot(rootDir, options.path ?? '.');
  const depth = clampInt(options.depth, DEFAULT_TREE_DEPTH, 1, MAX_TREE_DEPTH);
  const limit = clampInt(options.limit, DEFAULT_TREE_LIMIT, 1, MAX_TREE_LIMIT);

  const info = await stat(absolute).catch(() => undefined);
  if (info === undefined) throw new ProjectError('INVALID_INPUT', `knowledge path does not exist: \`${display}\``);
  if (!info.isDirectory()) throw new ProjectError('INVALID_INPUT', `\`${display}\` is a file; use action "read"`);

  const entries: KnowledgeTreeEntry[] = [];
  let hitLimit = false;
  let hitDepth = false;

  const walk = async (directory: string, level: number): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const sorted = [...children].sort((a, b) => a.name.localeCompare(b.name));
    for (const child of sorted) {
      if (hitLimit) return;
      const childPath = join(directory, child.name);
      if (child.isDirectory()) {
        if (isSkippedDirectory(child.name)) continue;
        if (entries.length >= limit) {
          hitLimit = true;
          return;
        }
        entries.push({ path: toPosixPath(relative(rootDir, childPath)), kind: 'dir' });
        if (level >= depth) {
          hitDepth = true;
          continue;
        }
        await walk(childPath, level + 1);
        continue;
      }
      if (!child.isFile() || isBinaryName(child.name)) continue;
      if (entries.length >= limit) {
        hitLimit = true;
        return;
      }
      const childInfo = await stat(childPath).catch(() => undefined);
      entries.push({
        path: toPosixPath(relative(rootDir, childPath)),
        kind: 'file',
        ...(childInfo === undefined ? {} : { bytes: childInfo.size }),
      });
    }
  };

  await walk(absolute, 1);
  entries.sort((a, b) => a.path.localeCompare(b.path));

  const notes: string[] = [];
  if (hitLimit) {
    notes.push(
      `stopped at the ${limit}-entry limit; raise \`limit\` (max ${MAX_TREE_LIMIT}) or narrow \`path\` to see the rest`,
    );
  }
  if (hitDepth) {
    notes.push(`directories at depth ${depth} were not expanded; raise \`depth\` (max ${MAX_TREE_DEPTH})`);
  }
  return { path: display, entries, truncated: hitLimit || hitDepth, note: notes.join(' '), limit, depth };
}

/**
 * Read one line window of a knowledge file.
 *
 * Oversized files are an error only when no window was asked for. Refusing outright would
 * make the largest, most useful documents unreadable; truncating silently would make a
 * partial answer look complete. Asking for a window is the caller saying which trade it
 * wants, and `truncated` then states exactly what it got.
 */
export async function readKnowledgeFile(
  rootDir: string,
  options: { path: string; from?: number; lines?: number },
): Promise<KnowledgeFileSlice> {
  const { absolute, display } = resolveInsideRoot(rootDir, options.path);
  const info = await stat(absolute).catch(() => undefined);
  if (info === undefined) throw new ProjectError('INVALID_INPUT', `knowledge path does not exist: \`${display}\``);
  if (info.isDirectory()) throw new ProjectError('INVALID_INPUT', `\`${display}\` is a directory; use action "tree"`);

  const windowed = options.from !== undefined || options.lines !== undefined;
  if (info.size > MAX_KNOWLEDGE_FILE_BYTES && !windowed) {
    throw new ProjectError(
      'INVALID_INPUT',
      `\`${display}\` is ${info.size} bytes, larger than the ${MAX_KNOWLEDGE_FILE_BYTES / (1024 * 1024)} MB knowledge file cap; pass \`from\` and/or \`lines\` to read a window of it`,
    );
  }

  const text = await readFile(absolute, 'utf8').catch(() => undefined);
  if (text === undefined) throw new ProjectError('INVALID_INPUT', `could not read \`${display}\``);
  // Same rule as collection: a NUL byte in the first block is the cheapest reliable binary
  // signal for files whose extension lies.
  if (text.slice(0, 4_096).includes('\u0000')) {
    throw new ProjectError(
      'INVALID_INPUT',
      `\`${display}\` looks like binary content (a NUL byte in the first 4096 bytes); knowledge read only serves text files`,
    );
  }

  const normalised = text.replace(/\r\n/g, '\n');
  const lines = normalised.length === 0 ? [] : (normalised.endsWith('\n') ? normalised.slice(0, -1) : normalised).split('\n');
  const totalLines = lines.length;
  const from = clampInt(options.from, 1, 1, Number.MAX_SAFE_INTEGER);
  const count = clampInt(options.lines, DEFAULT_READ_LINES, 1, MAX_READ_LINES);
  const start = from - 1;
  const slice = start >= totalLines ? [] : lines.slice(start, start + count);
  const to = slice.length === 0 ? from - 1 : from + slice.length - 1;
  return { path: display, from, to, totalLines, truncated: to < totalLines, text: slice.join('\n') };
}

/**
 * Fingerprint everything the bound paths currently contain.
 *
 * Structurally the same trick as `conventionsStamp`: stat each entry and hash the
 * `path:size:mtime` triples into one string. `searchProjectKnowledge` compares it with the
 * stamp stored in the index and rebuilds on a mismatch, which is what removed the manual
 * rebuild step.
 *
 * The parts are sorted, so the fingerprint depends on the tree rather than on enumeration
 * order; otherwise every search would look stale and rebuild forever.
 */
export async function knowledgeStamp(roots: readonly string[], rootDir: string): Promise<string> {
  const parts: string[] = [`roots:${JSON.stringify(roots)}`];

  const walk = async (absolute: string, display: string): Promise<void> => {
    const info = await stat(absolute).catch(() => undefined);
    if (info === undefined) {
      parts.push(`missing:${display}`);
      return;
    }
    if (!info.isDirectory()) {
      parts.push(`file:${display}:${info.size}:${Math.round(info.mtimeMs)}`);
      return;
    }
    parts.push(`dir:${display}:${Math.round(info.mtimeMs)}`);
    const children = await readdir(absolute, { withFileTypes: true }).catch(() => []);
    const sorted = [...children].sort((a, b) => a.name.localeCompare(b.name));
    for (const child of sorted) {
      if (child.isDirectory()) {
        if (isSkippedDirectory(child.name)) continue;
        await walk(join(absolute, child.name), `${display}/${child.name}`);
        continue;
      }
      if (!child.isFile() || isBinaryName(child.name)) continue;
      await walk(join(absolute, child.name), `${display}/${child.name}`);
    }
  };

  for (const bound of roots) {
    const trimmed = bound.trim();
    if (trimmed.length === 0) continue;
    const absolute = resolve(rootDir, trimmed);
    const rel = relative(rootDir, absolute);
    await walk(absolute, rel.length === 0 ? '.' : toPosixPath(rel));
  }
  parts.sort();
  return parts.join('|');
}

/** Read a stored index, treating any problem as "not built yet". */
export async function readIndexFile(path: string): Promise<KnowledgeIndex | undefined> {
  const text = await readFile(path, 'utf8').catch(() => undefined);
  return text === undefined ? undefined : parseIndex(text);
}

/** Persist an index atomically (tmp + rename), matching the manifest store's approach. */
export async function writeIndexFile(path: string, index: KnowledgeIndex): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, serialiseIndex(index), 'utf8');
  await rename(tmp, path);
}
