/**
 * The project Library: the files threads produced, and how to read one back.
 *
 * Official: the "Library" tab holds "the files and folders you added and the files threads
 * produced". On Anthropic's cloud that needs real storage, because the sandbox can vanish
 * and payout is a copy. Locally there is no such constraint — every thread's worktree is on
 * this disk — so the Library is a **manifest plus on-demand reads**, not a new storage
 * layer. That is why everything here except `readOutput` is pure: the list is metadata and
 * survives the worktree being reclaimed; only opening a file touches the disk.
 *
 * Two rules that keep the list honest:
 *
 *   - A file that no longer exists is still listed, and reading it says so. Hiding it would
 *     make "the thread produced this" silently false.
 *   - The list carries what changed (`added` / `modified` / `deleted`), because "this thread
 *     touched twenty files" is not the same question as "what did it add".
 */
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
/** Largest file the `read` action returns; larger ones are reported as truncated. */
export const MAX_OUTPUT_READ_BYTES = 200_000;
/** How much of a file is inspected when deciding whether it is binary. */
const BINARY_PROBE_BYTES = 4_096;
/**
 * Map one `git diff --name-status` letter onto the Library vocabulary.
 *
 * `T` (type change) counts as `modified`: a symlink that became a file is the same path with
 * different contents. `C` (copy) counts as `added` for the same reason a new path is new.
 */
function changeOf(letter) {
    switch (letter.charAt(0).toUpperCase()) {
        case 'A':
            return 'added';
        case 'D':
            return 'deleted';
        case 'C':
            return 'added';
        default:
            return 'modified';
    }
}
/**
 * Parse `git diff --name-status` output.
 *
 * Renames are deliberately not requested (`--no-renames`): a rename shows up as a deletion
 * plus an addition, which is what the Library should say — the old path is gone and a new one
 * appeared. Collapsing it into one `renamed` row hides the path a user might still be looking
 * for.
 */
export function parseNameStatus(text) {
    const outputs = [];
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0)
            continue;
        const [letter, ...rest] = trimmed.split('\t');
        if (letter === undefined || rest.length === 0)
            continue;
        // `--no-renames` yields exactly `STATUS\tpath`; a rename escape hatch keeps the new path
        // rather than dropping the row.
        const path = rest[rest.length - 1];
        if (path === undefined || path.length === 0)
            continue;
        outputs.push({ path, change: changeOf(letter) });
    }
    return outputs;
}
/**
 * Merge every thread's output list into one Library view, deduplicated by path.
 *
 * A path touched by several threads appears once, with all of them listed: the panel answers
 * "what exists" first, and "who made it" second. `change` prefers the strongest signal —
 * `added` beats `modified` beats `deleted`, because a path that still exists on some branch
 * is not, from the user's point of view, deleted.
 */
export function aggregateLibrary(threads) {
    const byPath = new Map();
    for (const thread of threads) {
        for (const output of thread.outputs ?? []) {
            const existing = byPath.get(output.path);
            if (existing === undefined) {
                byPath.set(output.path, { path: output.path, change: output.change, threads: [thread.threadId] });
                continue;
            }
            if (!existing.threads.includes(thread.threadId))
                existing.threads.push(thread.threadId);
            existing.change = strongerChange(existing.change, output.change);
        }
    }
    return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}
/** Rank changes by how much they say about whether a path exists. */
function strongerChange(left, right) {
    const rank = { added: 3, modified: 2, deleted: 1 };
    return rank[right] > rank[left] ? right : left;
}
/** True when the first bytes contain a NUL, the cheapest trustworthy binary signal. */
function looksBinary(bytes) {
    const limit = Math.min(bytes.length, BINARY_PROBE_BYTES);
    for (let index = 0; index < limit; index += 1) {
        if (bytes[index] === 0)
            return true;
    }
    return false;
}
/**
 * Read one Library file from a worktree.
 *
 * The failure text is deliberately specific: "not on disk" means the thread's worktree was
 * reclaimed or the thread deleted the file, and both are answers the user can act on. An
 * empty string would read as "the file is empty", which is a different fact.
 */
export async function readOutput(worktreePath, path) {
    const root = worktreePath.replace(/[\\/]+$/, '');
    const absolute = resolve(root, path);
    // A Library path arrives from a model or a command line, so it can contain `..`. Resolving
    // and then checking containment is the only form that survives `a/../../b`: string prefix
    // tests on the raw input do not.
    if (absolute !== root && !absolute.startsWith(root + sep)) {
        return { ok: false, path, reason: `${path} escapes the worktree at ${worktreePath}` };
    }
    const info = await stat(absolute).catch(() => undefined);
    if (info === undefined) {
        return {
            ok: false,
            path,
            reason: `not on disk under ${worktreePath} — the thread's worktree was reclaimed, or the thread deleted this file`,
        };
    }
    if (!info.isFile())
        return { ok: false, path, reason: `${path} is not a regular file` };
    const buffer = await readFile(absolute).catch(() => undefined);
    if (buffer === undefined)
        return { ok: false, path, reason: `could not read ${path}` };
    if (looksBinary(buffer))
        return { ok: false, path, reason: `${path} is binary, not text` };
    const truncated = buffer.length > MAX_OUTPUT_READ_BYTES;
    const slice = truncated ? buffer.subarray(0, MAX_OUTPUT_READ_BYTES) : buffer;
    return {
        ok: true,
        path,
        source: absolute,
        text: slice.toString('utf8'),
        truncated,
        bytes: buffer.length,
    };
}
