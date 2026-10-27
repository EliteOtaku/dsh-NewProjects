/**
 * The knowledge layer: chunking, retrieval, and the automatic mode switch.
 *
 * The behaviour under test comes straight from how Projects describes itself: knowledge is
 * loaded in full while it fits, retrieval takes over automatically once it approaches the
 * limit, and it converts back when the content shrinks. A stored flag would break the last
 * part, so these tests change only sizes and assert the mode follows.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  buildIndex,
  chunkText,
  DEFAULT_CONTEXT_BUDGET_CHARS,
  describeKnowledge,
  emptyIndex,
  indexDocument,
  knowledgeCapacity,
  knowledgeMode,
  MAX_CHUNK_CHARS,
  MAX_SEARCH_LIMIT,
  parseIndex,
  RAG_CAPACITY_MULTIPLIER,
  renderHits,
  renderKnowledgeContextSection,
  renderKnowledgeRagNotice,
  resolveKnowledgeState,
  searchKnowledge,
  serialiseIndex,
  tokenise,
} from '../../src/core/knowledge.js';
import { collectKnowledge, readIndexFile, writeIndexFile } from '../../src/core/knowledgeSource.js';

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-project-knowledge-'));
  roots.push(root);
  return root;
}

describe('mode switch', () => {
  it('stays in context mode while the knowledge fits the budget', () => {
    assert.equal(knowledgeMode(100, DEFAULT_CONTEXT_BUDGET_CHARS), 'context');
    assert.equal(knowledgeMode(DEFAULT_CONTEXT_BUDGET_CHARS, DEFAULT_CONTEXT_BUDGET_CHARS), 'context');
  });

  it('switches to retrieval the moment the budget is exceeded', () => {
    assert.equal(knowledgeMode(DEFAULT_CONTEXT_BUDGET_CHARS + 1, DEFAULT_CONTEXT_BUDGET_CHARS), 'rag');
  });

  it('converts back when the knowledge shrinks again', () => {
    // The whole point of deriving the mode instead of storing it: no earlier state can keep a
    // now-small project in retrieval mode.
    const budget = 1_000;
    assert.equal(knowledgeMode(5_000, budget), 'rag');
    assert.equal(knowledgeMode(500, budget), 'context');
  });

  it('expands capacity by the documented multiplier', () => {
    assert.equal(knowledgeCapacity(1_000), 1_000 * RAG_CAPACITY_MULTIPLIER);
    assert.equal(RAG_CAPACITY_MULTIPLIER, 10);
  });

  it('never divides by a zero or negative budget', () => {
    assert.equal(knowledgeMode(10, 0), 'rag');
    assert.equal(knowledgeCapacity(0), RAG_CAPACITY_MULTIPLIER);
  });
});

describe('chunking', () => {
  it('keeps short text in one chunk with 1-based line numbers', () => {
    const chunks = chunkText('alpha\nbeta\ngamma');
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]?.startLine, 1);
    assert.equal(chunks[0]?.endLine, 3);
    assert.equal(chunks[0]?.text, 'alpha\nbeta\ngamma');
  });

  it('splits long text into several chunks that stay under the cap', () => {
    const lines = Array.from({ length: 400 }, (_, index) => `line ${String(index)} ${'x'.repeat(40)}`);
    const chunks = chunkText(lines.join('\n'));
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) assert.ok(chunk.text.length <= MAX_CHUNK_CHARS, `chunk was ${chunk.text.length}`);
  });

  it('numbers chunks consecutively from zero', () => {
    const chunks = chunkText(Array.from({ length: 300 }, () => 'y'.repeat(70)).join('\n'));
    assert.deepEqual(chunks.map((chunk) => chunk.ordinal), chunks.map((_, index) => index));
  });

  it('carries a two-line overlap so a passage spanning a break is still findable', () => {
    const lines = Array.from({ length: 300 }, (_, index) => `row${String(index)} ${'z'.repeat(60)}`);
    const chunks = chunkText(lines.join('\n'));
    const first = chunks[0];
    const second = chunks[1];
    assert.ok(first !== undefined && second !== undefined);
    const tailOfFirst = first.text.split('\n').slice(-2).join('\n');
    assert.ok(second.text.startsWith(tailOfFirst), 'second chunk should begin with the overlap');
  });

  it('hard-splits one enormous line instead of hiding it in an unsearchable blob', () => {
    // A minified asset is a single line; refusing to split it would make the whole file one
    // hit that dumps a megabyte into the context.
    const chunks = chunkText('q'.repeat(MAX_CHUNK_CHARS * 2 + 7));
    assert.ok(chunks.length >= 3);
    for (const chunk of chunks) assert.ok(chunk.text.length <= MAX_CHUNK_CHARS);
  });

  it('normalises CRLF so line numbers agree across platforms', () => {
    const chunks = chunkText('a\r\nb\r\nc');
    assert.equal(chunks[0]?.text, 'a\nb\nc');
    assert.equal(chunks[0]?.endLine, 3);
  });

  it('returns nothing for empty text', () => {
    assert.deepEqual(chunkText(''), []);
  });
});

describe('tokenise', () => {
  it('keeps latin words whole and lowercased', () => {
    assert.deepEqual(tokenise('Deploy Pipeline'), ['deploy', 'pipeline']);
  });

  it('splits CJK into overlapping bigrams so Chinese queries match', () => {
    // Without bigrams a whitespace tokeniser finds no terms at all in Chinese text, which
    // silently turns retrieval off.
    assert.deepEqual(tokenise('项目知识'), ['项目', '目知', '知识']);
  });

  it('keeps a single CJK character as its own term', () => {
    assert.deepEqual(tokenise('项目 和 知识'), ['项目', '和', '知识']);
  });

  it('ignores punctuation', () => {
    assert.deepEqual(tokenise('a-b_c!'), ['a', 'b_c']);
  });

  it('returns no terms for pure punctuation', () => {
    assert.deepEqual(tokenise('!!! ---'), []);
  });
});

describe('index build and round-trip', () => {
  it('records the character total across documents', () => {
    const index = buildIndex(
      [
        { path: 'a.md', text: 'one' },
        { path: 'b.md', text: 'three' },
      ],
      ['a.md', 'b.md'],
      123,
    );
    assert.equal(index.totalChars, 8);
    assert.equal(index.docs.length, 2);
    assert.equal(index.builtAt, 123);
  });

  it('survives a serialise/parse round trip', () => {
    const index = buildIndex([{ path: 'doc.md', text: 'hello world' }], ['doc.md'], 42);
    const restored = parseIndex(serialiseIndex(index));
    assert.deepEqual(restored, index);
  });

  it('treats a corrupt index as absent rather than throwing', () => {
    // The index is derived state: a bad one is rebuilt from the files, so failing here would
    // break the project for no reason.
    assert.equal(parseIndex('not json'), undefined);
    assert.equal(parseIndex('{"schema":2,"docs":[]}'), undefined);
    assert.equal(parseIndex('{"schema":1,"docs":"nope"}'), undefined);
  });

  it('drops malformed document entries instead of discarding the whole index', () => {
    const parsed = parseIndex('{"schema":1,"builtAt":5,"sources":[],"docs":[{"path":"ok.md","chunks":[],"chars":0},{"bad":true}]}');
    assert.equal(parsed?.docs.length, 1);
    assert.equal(parsed?.docs[0]?.path, 'ok.md');
  });

  it('starts empty', () => {
    const index = emptyIndex(['x'], 7);
    assert.equal(index.totalChars, 0);
    assert.deepEqual(index.docs, []);
    assert.equal(index.builtAt, 7);
  });

  it('fingerprints document content so an unchanged file is detectable', () => {
    const a = indexDocument('a.md', 'same text');
    const b = indexDocument('a.md', 'same text');
    const c = indexDocument('a.md', 'different text');
    assert.equal(a.sha, b.sha);
    assert.notEqual(a.sha, c.sha);
  });
});

describe('retrieval', () => {
  const index = buildIndex(
    [
      {
        path: 'docs/deploy.md',
        text: '# Deployment\n\nRun the release script after the tests pass. The release window is Tuesday.',
      },
      {
        path: 'docs/auth.md',
        text: '# Authentication\n\nTokens expire after one hour. Refresh uses the rotating secret.',
      },
      {
        path: 'docs/zh.md',
        text: '# 发布说明\n\n发布窗口定在每周二，必须等测试全部通过后才能执行发布脚本。',
      },
    ],
    ['docs'],
    1,
  );

  it('ranks the document that contains the terms', () => {
    const hits = searchKnowledge(index, 'release window');
    assert.ok(hits.length > 0);
    assert.equal(hits[0]?.path, 'docs/deploy.md');
  });

  it('finds Chinese content with a Chinese query', () => {
    const hits = searchKnowledge(index, '发布窗口');
    assert.ok(hits.length > 0);
    assert.equal(hits[0]?.path, 'docs/zh.md');
  });

  it('returns nothing for unrelated terms rather than the whole index', () => {
    assert.deepEqual(searchKnowledge(index, 'kubernetes helm chart'), []);
  });

  it('returns nothing for an empty query', () => {
    assert.deepEqual(searchKnowledge(index, '   '), []);
  });

  it('is deterministic: the same query returns the same passages in the same order', () => {
    // A retrieval tool whose output shuffles between calls makes the prompt prefix unstable.
    const first = searchKnowledge(index, 'release');
    const second = searchKnowledge(index, 'release');
    assert.deepEqual(first, second);
  });

  it('respects the limit and clamps it to the documented range', () => {
    const hits = searchKnowledge(index, 'release tokens', { limit: 1 });
    assert.equal(hits.length, 1);
    const many = searchKnowledge(index, 'release tokens the', { limit: 1_000 });
    assert.ok(many.length <= MAX_SEARCH_LIMIT);
  });

  it('reports the line range so a hit can be cited', () => {
    const hits = searchKnowledge(index, 'rotating secret');
    assert.ok(hits.length > 0);
    const hit = hits[0];
    assert.ok(hit !== undefined);
    assert.ok(hit.startLine >= 1);
    assert.ok(hit.endLine >= hit.startLine);
  });

  it('renders hits with path and line references', () => {
    const text = renderHits(searchKnowledge(index, 'rotating secret'));
    assert.match(text, /## docs\/auth\.md:\d+/);
    assert.match(text, /rotating secret/);
  });

  it('says so plainly when nothing matched', () => {
    assert.equal(renderHits([]), 'No project knowledge matched that query.');
  });
});

describe('state and rendering', () => {
  it('derives the mode from size and reports capacity', () => {
    const small = resolveKnowledgeState(buildIndex([{ path: 'a', text: 'aaa' }], [], 1), 1_000);
    assert.equal(small.mode, 'context');
    assert.equal(small.capacityChars, 10_000);
    const large = resolveKnowledgeState(buildIndex([{ path: 'a', text: 'x'.repeat(2_000) }], [], 1), 1_000);
    assert.equal(large.mode, 'rag');
  });

  it('describes an empty project as actionable, not as an error', () => {
    const state = resolveKnowledgeState(emptyIndex(), DEFAULT_CONTEXT_BUDGET_CHARS);
    assert.match(describeKnowledge(state), /no project knowledge yet/);
  });

  it('says context mode loads everything and retrieval mode does not', () => {
    const small = resolveKnowledgeState(buildIndex([{ path: 'a', text: 'aaa' }], [], 1), 1_000);
    assert.match(describeKnowledge(small), /loaded in full/);
    const large = resolveKnowledgeState(buildIndex([{ path: 'a', text: 'x'.repeat(2_000) }], [], 1), 1_000);
    assert.match(describeKnowledge(large), /project_knowledge_search/);
  });

  it('renders the full content in context mode, sorted by path', () => {
    // Sorting keeps the prefix byte-identical across runs; filesystem order would not.
    const index = buildIndex(
      [
        { path: 'z.md', text: 'last' },
        { path: 'a.md', text: 'first' },
      ],
      [],
      1,
    );
    const rendered = renderKnowledgeContextSection(index, resolveKnowledgeState(index, 1_000));
    assert.ok(rendered.indexOf('a.md') < rendered.indexOf('z.md'));
    assert.match(rendered, /first/);
    assert.match(rendered, /last/);
  });

  it('renders a retrieval notice that mentions the tool but carries no content', () => {
    const index = buildIndex([{ path: 'secret.md', text: 'the passphrase is hunter2' }], ['secret.md'], 1);
    const notice = renderKnowledgeRagNotice(resolveKnowledgeState(index, 1));
    assert.match(notice, /project_knowledge_search/);
    // The notice must not leak content: if it did, the mode would give no capacity at all.
    assert.doesNotMatch(notice, /hunter2/);
  });

  it('carries warnings through to the state', () => {
    const state = resolveKnowledgeState(emptyIndex(), 1_000, ['skipped big.bin']);
    assert.deepEqual(state.warnings, ['skipped big.bin']);
  });
});

describe('collecting from disk', () => {
  it('reads a single bound file', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'note.md'), '# Note\n\nhello', 'utf8');
    const result = await collectKnowledge(['note.md'], { rootDir: root, maxChars: 10_000 });
    assert.equal(result.documents.length, 1);
    assert.equal(result.documents[0]?.path, 'note.md');
    assert.equal(result.totalChars, 13);
  });

  it('descends a bound folder and skips dependency and build directories', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'kb', 'node_modules'), { recursive: true });
    await mkdir(join(root, 'kb', 'nested'), { recursive: true });
    await writeFile(join(root, 'kb', 'a.md'), 'alpha', 'utf8');
    await writeFile(join(root, 'kb', 'nested', 'b.md'), 'beta', 'utf8');
    await writeFile(join(root, 'kb', 'node_modules', 'junk.md'), 'noise', 'utf8');
    const result = await collectKnowledge(['kb'], { rootDir: root, maxChars: 10_000 });
    const paths = result.documents.map((doc) => doc.path).sort();
    // Citations are always posix-separated so one index stays readable on every platform.
    assert.deepEqual(paths, ['kb/a.md', 'kb/nested/b.md']);
  });

  it('indexes in stable order regardless of enumeration order', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'kb'));
    for (const name of ['c.md', 'a.md', 'b.md']) await writeFile(join(root, 'kb', name), name, 'utf8');
    const first = await collectKnowledge(['kb'], { rootDir: root, maxChars: 10_000 });
    const second = await collectKnowledge(['kb'], { rootDir: root, maxChars: 10_000 });
    assert.deepEqual(first.documents.map((doc) => doc.path), second.documents.map((doc) => doc.path));
    assert.deepEqual(first.documents.map((doc) => doc.path), ['kb/a.md', 'kb/b.md', 'kb/c.md']);
  });

  it('skips binary extensions without reading them', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'image.png'), 'not really a png', 'utf8');
    await writeFile(join(root, 'real.md'), 'text', 'utf8');
    const result = await collectKnowledge([root], { rootDir: root, maxChars: 10_000 });
    assert.deepEqual(result.documents.map((doc) => doc.path.split(/[\\/]/).pop()), ['real.md']);
  });

  it('skips content with NUL bytes even when the extension lies', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'liar.md'), 'text\u0000more', 'utf8');
    const result = await collectKnowledge([root], { rootDir: root, maxChars: 10_000 });
    assert.equal(result.documents.length, 0);
    assert.match(result.warnings.join('\n'), /binary/);
  });

  it('reports a missing path instead of silently indexing nothing', async () => {
    const root = await tempRoot();
    const result = await collectKnowledge(['absent.md'], { rootDir: root, maxChars: 10_000 });
    assert.equal(result.documents.length, 0);
    assert.match(result.warnings.join('\n'), /does not exist/);
  });

  it('stops at the character ceiling and says what it skipped', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'big.md'), 'x'.repeat(500), 'utf8');
    await writeFile(join(root, 'later.md'), 'y'.repeat(500), 'utf8');
    const result = await collectKnowledge([root], { rootDir: root, maxChars: 100 });
    assert.equal(result.truncated, true);
    assert.ok(result.documents.length <= 1);
    assert.match(result.warnings.join('\n'), /capacity/);
  });

  it('skips a file larger than the per-file cap and names it', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'huge.md'), 'z'.repeat(200), 'utf8');
    const result = await collectKnowledge([root], { rootDir: root, maxChars: 10_000, maxFileBytes: 50 });
    assert.equal(result.documents.length, 0);
    assert.match(result.warnings.join('\n'), /huge\.md/);
  });

  it('round-trips an index file through disk', async () => {
    const root = await tempRoot();
    const path = join(root, 'index.json');
    const index = buildIndex([{ path: 'a.md', text: 'hello' }], ['a.md'], 9);
    await writeIndexFile(path, index);
    const restored = await readIndexFile(path);
    assert.deepEqual(restored, index);
  });

  it('returns undefined for a missing index file', async () => {
    const root = await tempRoot();
    assert.equal(await readIndexFile(join(root, 'absent.json')), undefined);
  });
});
