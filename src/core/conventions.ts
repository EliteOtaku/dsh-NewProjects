/**
 * Repository conventions the agent is expected to follow.
 *
 * Official behaviour, copied exactly: `CLAUDE.md`, `.claude/CLAUDE.md`, and `.claude/rules/` **at
 * the repository root** are "Loaded from every repository when the thread starts". Everything
 * else is explicitly *not* loaded — permission rules in `.claude/settings.json` are "Not applied",
 * and nested `CLAUDE.md` files in subdirectories are not part of the contract.
 *
 * Reading more than that would be easy here (we have the whole disk) and would be wrong: the
 * charter is the byte-identical prefix every thread shares, so anything that grows with the size
 * of the checkout silently destroys the prompt cache the design depends on.
 *
 * Order is fixed — `CLAUDE.md`, `.claude/CLAUDE.md`, then `.claude/rules/*.md` sorted by name —
 * so the same repository produces the same bytes on every render.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/** Root-level convention files, in render order. */
export const CONVENTION_FILES: readonly string[] = ['CLAUDE.md', join('.claude', 'CLAUDE.md')];

/** Directory whose `*.md` files are appended after the two fixed files. */
export const RULES_DIR = join('.claude', 'rules');

/**
 * Total budget for the conventions section, in characters.
 *
 * Same figure the instructions budget uses: they are the same kind of text (standing prompt for
 * every thread), and the official number applies to the whole of it. Enforced as a truncation
 * with a warning — a repository with a 200 KB `CLAUDE.md` still needs its first pages.
 */
export const MAX_CONVENTIONS_CHARS = 16_000;

/** One convention file as read from the repository. */
export interface ConventionDocument {
  /** Repository-relative path, always POSIX separators so it renders the same everywhere. */
  path: string;
  text: string;
}

/** Result of one collection pass. */
export interface ConventionCollection {
  documents: ConventionDocument[];
  warnings: string[];
  truncated: boolean;
}

/** Strip a UTF-8 BOM; leaving it in puts an invisible character in the middle of the prefix. */
function clean(text: string): string {
  return text.replace(/^\uFEFF/, '');
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

/** Read one file, or `undefined` when it is missing or unreadable. */
async function readIfPresent(absolute: string, warnings: string[]): Promise<string | undefined> {
  try {
    return clean(await readFile(absolute, 'utf8'));
  } catch (error) {
    const code = (error as { code?: string }).code;
    // A missing convention file is the normal case, not a problem worth reporting.
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    warnings.push(`could not read ${absolute}: ${code ?? String(error)}`);
    return undefined;
  }
}

/**
 * Collect root-level conventions.
 *
 * Never throws: a project whose conventions cannot be read still works, and the caller renders
 * what it got. Missing files are silent; unreadable ones leave a warning.
 */
export async function collectConventions(
  rootDir: string,
  options: { maxChars?: number } = {},
): Promise<ConventionCollection> {
  const budget = Math.max(1, options.maxChars ?? MAX_CONVENTIONS_CHARS);
  const warnings: string[] = [];
  const documents: ConventionDocument[] = [];
  let used = 0;
  let truncated = false;

  const push = (path: string, raw: string): boolean => {
    const text = raw.trimEnd();
    if (text.length === 0) return true;
    const remaining = budget - used;
    if (remaining <= 0) {
      truncated = true;
      return false;
    }
    if (text.length > remaining) {
      documents.push({ path, text: text.slice(0, remaining) });
      used = budget;
      truncated = true;
      return false;
    }
    documents.push({ path, text });
    used += text.length;
    return true;
  };

  for (const file of CONVENTION_FILES) {
    const text = await readIfPresent(join(rootDir, file), warnings);
    if (text === undefined) continue;
    if (!push(toPosix(file), text)) break;
  }

  if (!truncated) {
    const rulesDir = join(rootDir, RULES_DIR);
    let names: string[] = [];
    try {
      const entries = await readdir(rulesDir, { withFileTypes: true });
      names = entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
        .map((entry) => entry.name)
        // Sorted by name: the filesystem's order is not stable across machines, and an unstable
        // order would show up as "the prefix changed" on every render.
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        warnings.push(`could not list ${rulesDir}: ${code ?? String(error)}`);
      }
    }
    for (const name of names) {
      const text = await readIfPresent(join(rulesDir, name), warnings);
      if (text === undefined) continue;
      if (!push(toPosix(join(RULES_DIR, name)), text)) break;
    }
  }

  if (truncated) {
    warnings.push(`repository conventions exceeded ${budget} characters and were truncated`);
  }
  return { documents, warnings, truncated };
}

/**
 * Cheap change detector for the collection above.
 *
 * The charter re-renders on every prompt assembly, so re-reading the files each time would be
 * wasteful; this key changes only when a file's size or mtime does. `undefined` means the same
 * thing as an empty collection — neither is worth a read.
 */
export async function conventionsStamp(rootDir: string): Promise<string> {
  const parts: string[] = [];
  const add = async (absolute: string, label: string): Promise<void> => {
    try {
      const info = await stat(absolute);
      parts.push(`${label}:${info.size}:${Math.round(info.mtimeMs)}`);
    } catch {
      parts.push(`${label}:-`);
    }
  };
  for (const file of CONVENTION_FILES) await add(join(rootDir, file), toPosix(file));
  try {
    const entries = await readdir(join(rootDir, RULES_DIR), { withFileTypes: true });
    const names = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => entry.name)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const name of names) await add(join(rootDir, RULES_DIR, name), toPosix(join(RULES_DIR, name)));
  } catch {
    parts.push(`${toPosix(RULES_DIR)}:-`);
  }
  return parts.join('|');
}

/**
 * Render the conventions section.
 *
 * Empty collection renders nothing at all: an empty heading would tell every thread "this
 * repository has conventions, and they are blank".
 */
export function renderConventions(documents: readonly ConventionDocument[]): string {
  if (documents.length === 0) return '';
  const blocks: string[] = [
    '## Repository conventions',
    '',
    'Loaded from the repository root when this thread started. Follow them; where they conflict with your task, say so instead of silently picking one.',
    '',
  ];
  for (const document of documents) {
    blocks.push(`### ${document.path}`, '', document.text, '');
  }
  return blocks.join('\n').trimEnd();
}

/** Repository-relative path helper for callers that already know the root. */
export function relativeConventionPath(rootDir: string, absolute: string): string {
  return toPosix(relative(rootDir, absolute));
}
