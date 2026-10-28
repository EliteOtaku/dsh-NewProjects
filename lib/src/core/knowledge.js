/**
 * Project knowledge: an index threads read from, not content threads are handed.
 *
 * This module used to implement the two-mode behaviour of claude.ai *chat* Projects — load
 * the knowledge in full while it fits the window, switch to a retrieval tool past a
 * threshold. That was the wrong product. Claude Code Projects has no such mechanism: its
 * documentation never uses the words "knowledge", "retrieval" or "RAG", and what it gives a
 * thread instead is
 *
 * - a readable mount (`the folders and files it can read under /mnt/project-files`), and
 * - an index file read at startup, with bodies opened on demand: "Every cloud thread reads
 *   the index file `MEMORY.md` when it starts and opens the other files when it needs them".
 *
 * So the shape here is paths-first. The prompt carries an *index* — what documents exist and
 * how big they are — and the thread reads the bodies off disk when it needs them. Three
 * consequences, all of them subtractions:
 *
 * - No context budget. Nothing varies with the model's window because no document body sits
 *   in the prefix. The one documented budget for standing prompt text is the 16,000
 *   characters Projects allows for project instructions, and that is enforced where the
 *   charter is assembled, not here.
 * - No staleness. The thread reads the file, so it reads today's bytes. The *index* can lag,
 *   but a lagging index only mis-ranks search hits; the citation it returns still points at
 *   a file whose current contents the thread can read. {@link renderKnowledgeIndexSection}
 *   therefore states when the index was built instead of pretending it is authoritative.
 * - No mode flag, and no mode. There is nothing to switch, so there is nothing to leave
 *   behind and nothing to oscillate at a boundary.
 *
 * BM25 search survives as a convenience — a second way in when a thread does not know which
 * file to open — not as a mechanism. Everything here is pure: no filesystem, no clock beyond
 * what the caller passes. Ranking treats Latin words and CJK characters alike, because a
 * keyword search that only understands whitespace-delimited words finds nothing in Chinese.
 */
import { fingerprint } from './util.js';
/** Largest chunk handed back by one search hit. */
export const MAX_CHUNK_CHARS = 1_200;
/** Cap on lines per chunk, so a file of short lines still yields addressable passages. */
const MAX_CHUNK_LINES = 60;
/** Lines repeated at the start of the next chunk, so a hit is never cut mid-thought. */
const OVERLAP_LINES = 2;
/** Chunks returned when the caller does not say. */
export const DEFAULT_SEARCH_LIMIT = 5;
/** Hard ceiling on hits per search, so one call cannot flood the context. */
export const MAX_SEARCH_LIMIT = 20;
/**
 * Ceiling on indexed documents.
 *
 * Mirrors the official collection limit, which counts entries rather than characters: a
 * folder contributes "its first 100 files up to 200 MB, without any files over 30 MB". The
 * index is a search aid, so a bound on how many documents it holds is the bound that matters;
 * the old `budget x 10` figure was derived from a context budget that no longer exists.
 */
export const MAX_KNOWLEDGE_FILES = 100;
/**
 * Ceiling on indexed characters.
 *
 * Not a prompt budget — nothing here reaches the prompt. It bounds the on-disk index file,
 * which holds every document chunked into JSON. 20M characters keeps that file in the tens
 * of megabytes; past it, collection stops and says so, because an index that silently omits
 * files makes search look exhaustive when it is not.
 */
export const MAX_KNOWLEDGE_INDEX_CHARS = 20_000_000;
/** An empty index, used before the first build and when a project has no knowledge. */
export function emptyIndex(sources = [], builtAt = 0) {
    return { schema: 1, builtAt, sources: [...sources], docs: [], totalChars: 0 };
}
/**
 * Split one document into chunks.
 *
 * Chunks break on line boundaries where possible so a hit is a readable passage, carry a
 * small overlap so a fact spanning a boundary is still retrievable, and hard-split any single
 * line longer than the chunk cap — minified assets are one line of a megabyte, and refusing to
 * index them would hide real content.
 */
export function chunkText(text) {
    const normalised = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    // Empty input has no passage to point at. Without this the loop's final `push` would emit
    // one blank chunk, and a search could then "find" an empty document.
    if (normalised.length === 0)
        return [];
    const lines = normalised.split('\n');
    const chunks = [];
    let buffer = [];
    let bufferChars = 0;
    let bufferStart = 1;
    const push = (endLine) => {
        if (buffer.length === 0)
            return;
        chunks.push({
            ordinal: chunks.length,
            startLine: bufferStart,
            endLine,
            text: buffer.join('\n'),
        });
        // Carry trailing lines into the next chunk so a passage spanning the break is findable.
        const carry = OVERLAP_LINES > 0 ? buffer.slice(-OVERLAP_LINES) : [];
        buffer = [...carry];
        bufferChars = buffer.reduce((sum, line) => sum + line.length + 1, 0);
        bufferStart = Math.max(bufferStart, endLine - carry.length + 1);
    };
    for (const [index, line] of lines.entries()) {
        const lineNumber = index + 1;
        // A single enormous line is split by characters; without this a minified file becomes
        // one unsearchable blob and every query that matches it returns the whole thing.
        if (line.length > MAX_CHUNK_CHARS) {
            push(lineNumber - 1);
            bufferStart = lineNumber;
            for (let offset = 0; offset < line.length; offset += MAX_CHUNK_CHARS) {
                const slice = line.slice(offset, offset + MAX_CHUNK_CHARS);
                chunks.push({
                    ordinal: chunks.length,
                    startLine: lineNumber,
                    endLine: lineNumber,
                    text: slice,
                });
            }
            buffer = [];
            bufferChars = 0;
            continue;
        }
        const projected = bufferChars + line.length + 1;
        if (buffer.length > 0 && (projected > MAX_CHUNK_CHARS || buffer.length >= MAX_CHUNK_LINES)) {
            push(lineNumber - 1);
        }
        if (buffer.length === 0)
            bufferStart = lineNumber;
        buffer.push(line);
        bufferChars += line.length + 1;
    }
    push(lines.length);
    return chunks;
}
/** Index one document's text. */
export function indexDocument(path, text) {
    return {
        path,
        sha: fingerprint(text),
        chars: text.length,
        chunks: chunkText(text),
    };
}
/** Build a complete index from already-read documents. */
export function buildIndex(documents, sources, builtAt) {
    const docs = documents.map((doc) => indexDocument(doc.path, doc.text));
    return {
        schema: 1,
        builtAt,
        sources: [...sources],
        docs,
        totalChars: docs.reduce((sum, doc) => sum + doc.chars, 0),
    };
}
/** Serialise an index for disk. */
export function serialiseIndex(index) {
    return `${JSON.stringify(index, null, 2)}\n`;
}
/**
 * Parse a stored index, returning `undefined` when it is absent or unreadable.
 *
 * A corrupt index is treated as "no index yet" rather than an error: the next build
 * regenerates it from the files, which are the source of truth.
 */
export function parseIndex(text) {
    try {
        const parsed = JSON.parse(text);
        if (parsed.schema !== 1 || !Array.isArray(parsed.docs))
            return undefined;
        const docs = parsed.docs.filter((doc) => typeof doc === 'object' &&
            doc !== null &&
            typeof doc.path === 'string' &&
            Array.isArray(doc.chunks));
        return {
            schema: 1,
            builtAt: typeof parsed.builtAt === 'number' ? parsed.builtAt : 0,
            sources: Array.isArray(parsed.sources) ? parsed.sources.filter((s) => typeof s === 'string') : [],
            docs,
            totalChars: docs.reduce((sum, doc) => sum + (typeof doc.chars === 'number' ? doc.chars : 0), 0),
        };
    }
    catch {
        return undefined;
    }
}
/** Describe the current knowledge state for the panel and the prompt. */
export function resolveKnowledgeState(index, warnings = []) {
    return {
        docs: index.docs.length,
        chunks: index.docs.reduce((sum, doc) => sum + doc.chunks.length, 0),
        totalChars: index.totalChars,
        builtAt: index.builtAt,
        sources: [...index.sources],
        warnings: [...warnings],
    };
}
/** Characters per token for the rough budget arithmetic in warnings. */
const CHARS_PER_TOKEN = 4;
/** A short human-readable summary, used by the command and the panel. */
export function describeKnowledge(state) {
    const approxTokens = Math.round(state.totalChars / CHARS_PER_TOKEN);
    if (state.docs === 0) {
        return 'no project knowledge yet; `/project knowledge add <path>` to index files or folders';
    }
    const head = `${state.docs} document(s), ${state.chunks} chunk(s), ${state.totalChars} chars (~${approxTokens} tokens)`;
    return `${head}, listed in the charter and read from disk on demand; \`project_knowledge_search\` ranks passages`;
}
// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/;
/**
 * Split text into search terms.
 *
 * Latin runs stay whole words; CJK has no spaces, so each run becomes overlapping bigrams.
 * A single-character run stays itself. Without the bigrams a query of Chinese words matches
 * nothing at all, which silently turns retrieval off for half the world's users.
 */
export function tokenise(text) {
    const lower = text.toLowerCase();
    const terms = [];
    for (const match of lower.matchAll(/[a-z0-9_]+/g))
        terms.push(match[0]);
    let run = '';
    const flush = () => {
        if (run.length === 1)
            terms.push(run);
        else if (run.length > 1) {
            for (let index = 0; index + 1 < run.length; index += 1)
                terms.push(run.slice(index, index + 2));
        }
        run = '';
    };
    for (const char of lower) {
        if (CJK.test(char))
            run += char;
        else
            flush();
    }
    flush();
    return terms;
}
/** BM25 parameters; the standard defaults, with no tuning applied yet. */
const BM25_K1 = 1.2;
const BM25_B = 0.75;
/**
 * Search the index with BM25.
 *
 * BM25 rather than cosine similarity because it needs no embedding model: this plugin has to
 * work offline, on any machine, without shipping weights or calling a provider. Ties break on
 * path then chunk order so the same query returns the same passages — a retrieval tool whose
 * output shuffles between calls makes prompt caching useless.
 */
export function searchKnowledge(index, query, options = {}) {
    const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT));
    const queryTerms = [...new Set(tokenise(query))];
    if (queryTerms.length === 0)
        return [];
    const entries = [];
    for (const doc of index.docs) {
        for (const chunk of doc.chunks) {
            const tokens = tokenise(chunk.text);
            entries.push({ doc, chunk, length: tokens.length, tokens });
        }
    }
    if (entries.length === 0)
        return [];
    const totalLength = entries.reduce((sum, entry) => sum + entry.length, 0);
    const averageLength = totalLength / entries.length;
    const documentFrequency = new Map();
    for (const entry of entries) {
        for (const term of new Set(entry.tokens)) {
            documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
        }
    }
    const scored = [];
    for (const entry of entries) {
        const counts = new Map();
        for (const token of entry.tokens)
            counts.set(token, (counts.get(token) ?? 0) + 1);
        let score = 0;
        for (const term of queryTerms) {
            const frequency = counts.get(term);
            if (frequency === undefined)
                continue;
            const df = documentFrequency.get(term) ?? 0;
            const idf = Math.log(1 + (entries.length - df + 0.5) / (df + 0.5));
            const norm = entry.length > 0 ? 1 - BM25_B + (BM25_B * entry.length) / averageLength : 1;
            score += idf * ((frequency * (BM25_K1 + 1)) / (frequency + BM25_K1 * norm));
        }
        if (score <= 0)
            continue;
        scored.push({
            path: entry.doc.path,
            startLine: entry.chunk.startLine,
            endLine: entry.chunk.endLine,
            score,
            text: entry.chunk.text,
        });
    }
    scored.sort((a, b) => (b.score - a.score) || a.path.localeCompare(b.path) || a.startLine - b.startLine);
    return scored.slice(0, limit);
}
/** Render hits as the text a tool returns to the model. */
export function renderHits(hits) {
    if (hits.length === 0)
        return 'No project knowledge matched that query.';
    const blocks = [];
    for (const hit of hits) {
        const range = hit.startLine === hit.endLine ? `${hit.startLine}` : `${hit.startLine}-${hit.endLine}`;
        blocks.push(`## ${hit.path}:${range}`);
        blocks.push('');
        blocks.push(hit.text);
        blocks.push('');
    }
    return blocks.join('\n').trimEnd();
}
// ---------------------------------------------------------------------------
// Prompt rendering
// ---------------------------------------------------------------------------
/**
 * Whether a path is absolute, without pulling `node:path` into a pure module.
 *
 * Covers POSIX (`/x`), Windows drive (`C:\x`, `C:/x`) and UNC (`\\server\x`, matched by the
 * leading separator).
 */
const ABSOLUTE_KNOWLEDGE_PATH = /^(?:[\\/]|[A-Za-z]:[\\/])/;
/** Whether `path` is absolute. */
export function isAbsoluteKnowledgePath(path) {
    return ABSOLUTE_KNOWLEDGE_PATH.test(path);
}
/** A Windows absolute path, where a backslash is a separator rather than a filename character. */
const WINDOWS_ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/;
/**
 * Render a path as it should appear in the prompt.
 *
 * Only Windows absolute paths are rewritten, because only there is a backslash a separator.
 * On a POSIX path a backslash is a legal character in a filename, so rewriting it would point
 * the thread at a file that does not exist. Everything else is already forward-slashed by the
 * source module when the index is built.
 */
export function toDisplayPath(path) {
    return WINDOWS_ABSOLUTE_PATH.test(path) ? path.replace(/\\/g, '/') : path;
}
/**
 * The knowledge index, as it appears in the charter.
 *
 * This is the whole of what knowledge contributes to the prompt: the catalogue, never the
 * contents. It mirrors what a Projects thread gets — an index read at startup plus files it
 * opens when it needs them — and it is why no document body and no context budget appear
 * anywhere in prompt assembly.
 *
 * Every document is listed with its size, because the size is what lets a thread choose:
 * "read the 2 KB decision record" and "read the 400 KB transcript" are different decisions
 * and a bare path list cannot tell them apart.
 *
 * Sorted by path and free of timestamps, so the charter stays byte-identical between
 * rebuilds. The index's age is stated in words rather than as a number: a thread cannot
 * usefully compare an epoch to "now", and what it needs to know is only that the file on disk
 * wins over the catalogue — which is exactly the failure mode this design removes.
 *
 * `rootDir` is rendered when the caller supplies it, for one reason: a thread's working
 * directory is its own worktree, not the project root, and a worktree contains only what was
 * committed when its branch was cut. A relative `docs/arch.md` therefore resolves inside the
 * thread's checkout, where it may be missing (added but uncommitted) or stale (committed after
 * the branch point). Stating the project root turns a silent miss into a lookup the thread can
 * actually perform. It costs one line in the prefix, and only that one line varies across
 * machines — the document list stays relative, so a prefix cache survives a path change better
 * than it would with per-document absolute paths.
 */
export function renderKnowledgeIndexSection(index, state, options = {}) {
    const bound = options.boundPaths ?? state.sources;
    if (index.docs.length === 0 && bound.length === 0)
        return '';
    const lines = [];
    lines.push('## Project knowledge');
    lines.push('');
    const rootDir = options.rootDir;
    if (rootDir !== undefined && isAbsoluteKnowledgePath(rootDir)) {
        lines.push(`Project root: \`${toDisplayPath(rootDir)}\``);
        lines.push('');
        lines.push('Relative paths below resolve against that project root, **not** against your own working directory. Your checkout is a worktree that holds only what was committed when your branch was cut, so a knowledge file that was added but not yet committed exists under the project root and not in your checkout, and one committed later than your branch point is stale in your checkout. Read knowledge from the project root.');
        lines.push('');
    }
    if (index.docs.length === 0) {
        // Bound but never indexed. The paths alone are still worth stating: they are where the
        // authoritative context lives, and a thread can read them without any index at all.
        lines.push('These paths hold the authoritative context for this project. Read the ones your task touches before making design decisions:');
        lines.push('');
        for (const path of bound)
            lines.push(`- \`${toDisplayPath(path)}\``);
        return lines.join('\n');
    }
    lines.push(`${state.docs} document(s) under ${bound.length} bound path(s) hold the authoritative context for this project. They are **not** reproduced here — read the ones your task touches, with your ordinary file tools, before making design decisions.`);
    lines.push('');
    const docs = [...index.docs].sort((a, b) => a.path.localeCompare(b.path));
    for (const doc of docs) {
        lines.push(`- \`${doc.path}\` — ${doc.chars} chars`);
    }
    lines.push('');
    lines.push('When you do not know which file answers your question, call `project_knowledge_search`: it ranks passages across all of them and cites `path:line`. Then open the file it points at. The file on disk is authoritative; the search index was built earlier and may lag it. Run `/project knowledge rebuild` after adding or removing files.');
    return lines.join('\n');
}
