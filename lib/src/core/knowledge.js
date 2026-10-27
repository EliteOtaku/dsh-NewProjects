/**
 * Project knowledge: the local implementation of Projects' RAG mode.
 *
 * Anthropic's Projects behave in two ways depending on how much knowledge the project holds:
 *
 * - While the knowledge still fits in the model's context, it is loaded in full and every
 *   answer works from it directly.
 * - Once it approaches the limit, the product switches to a retrieval tool ("project
 *   knowledge search") that expands capacity by up to 10x, and switches back automatically if
 *   the knowledge shrinks again.
 *
 * The switch is therefore *derived* from the current size, never a mode flag a user or a
 * previous run can leave behind. That is the only way "automatically converts back" can be
 * true, and it is why {@link knowledgeMode} takes sizes rather than state.
 *
 * Everything here is pure: no filesystem, no clock beyond what the caller passes. Ranking is
 * BM25 over a tokeniser that treats Latin words and CJK characters alike, because a keyword
 * search that only understands whitespace-delimited words finds nothing in Chinese text.
 */
import { fingerprint } from './util.js';
/**
 * Characters of knowledge that still fit in a prompt prefix.
 *
 * 96k characters is roughly 24k tokens: large enough that most projects never leave context
 * mode, small enough that the prefix stays a fraction of a modern window.
 */
export const DEFAULT_CONTEXT_BUDGET_CHARS = 96_000;
/** Anthropic expands project capacity "by up to 10x" once RAG turns on. */
export const RAG_CAPACITY_MULTIPLIER = 10;
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
 * Total capacity for a project: the in-context budget multiplied by the RAG expansion.
 *
 * Beyond this the collection stops and reports what it skipped. Silently dropping content
 * would make the index look complete while answers quietly miss files the user added.
 */
export function knowledgeCapacity(budgetChars) {
    return Math.max(1, budgetChars) * RAG_CAPACITY_MULTIPLIER;
}
/** Decide how the project should consume its knowledge right now. */
export function knowledgeMode(totalChars, budgetChars) {
    return totalChars <= Math.max(1, budgetChars) ? 'context' : 'rag';
}
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
export function resolveKnowledgeState(index, budgetChars, warnings = []) {
    const budget = Math.max(1, Math.round(budgetChars));
    return {
        mode: knowledgeMode(index.totalChars, budget),
        docs: index.docs.length,
        chunks: index.docs.reduce((sum, doc) => sum + doc.chunks.length, 0),
        totalChars: index.totalChars,
        budgetChars: budget,
        capacityChars: knowledgeCapacity(budget),
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
    const mode = state.mode === 'context'
        ? `loaded in full into the prompt prefix (${state.totalChars}/${state.budgetChars} chars)`
        : `retrieved on demand via project_knowledge_search (${state.totalChars}/${state.capacityChars} chars, ${RAG_CAPACITY_MULTIPLIER}x capacity)`;
    return `${head}, ${mode}`;
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
 * The in-context rendering: every document, in full.
 *
 * Sorted by path and stripped of timestamps so the prefix is byte-identical across sessions —
 * which is what keeps prompt caching working while the knowledge sits in the prefix.
 */
export function renderKnowledgeInline(index) {
    const blocks = [];
    const docs = [...index.docs].sort((a, b) => a.path.localeCompare(b.path));
    for (const doc of docs) {
        if (doc.chunks.length === 0)
            continue;
        blocks.push(`### ${doc.path}`);
        blocks.push('');
        blocks.push(doc.chunks.map((chunk) => chunk.text).join('\n'));
        blocks.push('');
    }
    return blocks.join('\n').trimEnd();
}
/**
 * The retrieval-mode notice.
 *
 * Deliberately short: in this mode the knowledge must NOT be in the prefix, which is the whole
 * reason the mode exists. The model is told the tool exists and what it covers, not the content.
 */
export function renderKnowledgeRagNotice(state) {
    const lines = [];
    lines.push('## Project knowledge (retrieval mode)');
    lines.push('');
    lines.push(`This project holds ${state.docs} document(s) / ${state.totalChars} characters of knowledge, which exceeds the ${state.budgetChars}-character context budget, so it is not loaded into this prompt.`);
    lines.push('');
    lines.push('Call `project_knowledge_search` with what you need to find out before making design decisions. Search by meaning-bearing words from the question, not by file name alone. Do not claim the project has no documentation before searching.');
    if (state.sources.length > 0) {
        lines.push('');
        lines.push('Indexed sources:');
        for (const source of state.sources)
            lines.push(`- \`${source}\``);
    }
    return lines.join('\n');
}
/** The context-mode heading that wraps {@link renderKnowledgeInline}. */
export function renderKnowledgeContextSection(index, state) {
    const inline = renderKnowledgeInline(index);
    if (inline.length === 0)
        return '';
    const lines = [];
    lines.push('## Project knowledge');
    lines.push('');
    lines.push(`The following ${state.docs} document(s) are the authoritative context for this project, loaded in full (${state.totalChars}/${state.budgetChars} characters). Read them before making design decisions.`);
    lines.push('');
    lines.push(inline);
    return lines.join('\n');
}
