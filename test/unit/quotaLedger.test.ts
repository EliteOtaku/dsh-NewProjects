/**
 * The user-wide daily thread ledger.
 *
 * The one thing these tests are really about: the enforced quota is "200 new threads per day
 * **across your projects**", so the counter has to be outside any single project's manifest.
 * Every case here is a way that invariant used to be breakable — a second project with its
 * own budget, a rejected batch that still spent quota, a second process that overwrote the
 * first one's count.
 *
 * They use a real temporary file because the ledger's correctness lives in its locking and
 * its atomic rename; an in-memory stub would test the stub.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { isProjectError } from '../../src/core/errors.js';
import {
  defaultQuotaLedgerPath,
  emptyLedger,
  GLOBAL_DAILY_THREAD_LIMIT,
  parseLedger,
  QUOTA_LEDGER_ENV,
  QuotaLedger,
} from '../../src/core/quotaLedger.js';

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function ledgerPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-project-ledger-'));
  roots.push(root);
  return join(root, 'quota.json');
}

const DAY_MS = Date.parse('2026-03-04T10:00:00Z');
/** Same wall clock, next calendar day. */
const NEXT_DAY_MS = DAY_MS + 24 * 60 * 60 * 1000;

describe('ledger location', () => {
  it('honours the environment override', () => {
    assert.equal(
      defaultQuotaLedgerPath({ [QUOTA_LEDGER_ENV]: '/tmp/custom/quota.json' }),
      '/tmp/custom/quota.json',
    );
  });

  it('ignores a blank override rather than writing to an empty path', () => {
    const resolved = defaultQuotaLedgerPath({ [QUOTA_LEDGER_ENV]: '   ' });
    assert.ok(resolved.endsWith(join('.dsh', 'dsh-newprojects', 'quota.json')));
  });

  it('defaults outside any project, which is the whole point', () => {
    const resolved = defaultQuotaLedgerPath({});
    // A path under a project root would reintroduce per-project counting by the back door.
    assert.ok(!resolved.includes('.dsh-project'));
  });
});

describe('parsing', () => {
  it('treats an absent ledger as an empty day', () => {
    assert.deepEqual(parseLedger(undefined, '2026-03-04'), emptyLedger('2026-03-04'));
  });

  it('treats a corrupt ledger as an empty day instead of failing', () => {
    // Refusing to start threads because a cache file got truncated would be worse than
    // briefly under-counting; the next write repairs the file.
    assert.equal(parseLedger('{not json', '2026-03-04').created, 0);
    assert.equal(parseLedger('{"schema":2,"created":9}', '2026-03-04').created, 0);
  });

  it('discards counts from an earlier day', () => {
    const stale = JSON.stringify({ schema: 1, day: '2026-03-03', created: 200, byProject: { a: 200 } });
    const rolled = parseLedger(stale, '2026-03-04');
    assert.equal(rolled.day, '2026-03-04');
    assert.equal(rolled.created, 0);
    assert.deepEqual(rolled.byProject, {});
  });

  it('drops nonsense per-project entries without losing the total', () => {
    const odd = JSON.stringify({
      schema: 1,
      day: '2026-03-04',
      created: 5,
      byProject: { good: 3, negative: -2, text: 'x' },
    });
    const parsed = parseLedger(odd, '2026-03-04');
    assert.equal(parsed.created, 5);
    assert.deepEqual(parsed.byProject, { good: 3 });
  });
});

describe('reserving', () => {
  it('counts one project against the shared ceiling', async () => {
    const ledger = new QuotaLedger(await ledgerPath());
    const state = await ledger.reserve('p1', 3, DAY_MS);
    assert.equal(state.created, 3);
    assert.equal(state.project, 3);
    assert.equal(state.max, GLOBAL_DAILY_THREAD_LIMIT);
  });

  it('counts two projects against the same ceiling', async () => {
    // The defect this whole module exists to fix: two manifests meant two budgets.
    const ledger = new QuotaLedger(await ledgerPath(), { max: 10 });
    await ledger.reserve('p1', 6, DAY_MS);
    const state = await ledger.reserve('p2', 4, DAY_MS);
    assert.equal(state.created, 10);
    assert.equal(state.project, 4);
    await assert.rejects(
      () => ledger.reserve('p3', 1, DAY_MS),
      (error: unknown) => isProjectError(error) && error.code === 'QUOTA_EXCEEDED',
    );
  });

  it('spends nothing when a batch is refused', async () => {
    const path = await ledgerPath();
    const ledger = new QuotaLedger(path, { max: 5 });
    await ledger.reserve('p1', 4, DAY_MS);
    const before = await readFile(path, 'utf8');
    await assert.rejects(() => ledger.reserve('p2', 2, DAY_MS));
    // All-or-nothing, byte for byte: a rejected batch must not leave a partial dent that the
    // user then has to wait out.
    assert.equal(await readFile(path, 'utf8'), before);
    assert.equal((await ledger.snapshot('p2', DAY_MS)).created, 4);
  });

  it('reports who is holding the budget', async () => {
    const ledger = new QuotaLedger(await ledgerPath(), { max: 50 });
    await ledger.reserve('p1', 7, DAY_MS);
    await ledger.reserve('p2', 2, DAY_MS);
    const mine = await ledger.snapshot('p1', DAY_MS);
    assert.equal(mine.created, 9);
    assert.equal(mine.project, 7);
  });

  it('rejects a zero or negative reservation as a caller bug', async () => {
    const ledger = new QuotaLedger(await ledgerPath());
    await assert.rejects(
      () => ledger.reserve('p1', 0, DAY_MS),
      (error: unknown) => isProjectError(error) && error.code === 'INVALID_INPUT',
    );
  });

  it('resets on the next calendar day', async () => {
    const ledger = new QuotaLedger(await ledgerPath(), { max: 5 });
    await ledger.reserve('p1', 5, DAY_MS);
    await assert.rejects(() => ledger.reserve('p1', 1, DAY_MS));
    const tomorrow = await ledger.reserve('p1', 5, NEXT_DAY_MS);
    assert.equal(tomorrow.created, 5);
    assert.equal(tomorrow.day, (await ledger.snapshot('p1', NEXT_DAY_MS)).day);
  });
});

describe('releasing', () => {
  it('gives back reservations that never became threads', async () => {
    const ledger = new QuotaLedger(await ledgerPath(), { max: 10 });
    await ledger.reserve('p1', 5, DAY_MS);
    await ledger.release('p1', 2, DAY_MS);
    const state = await ledger.snapshot('p1', DAY_MS);
    assert.equal(state.created, 3);
    assert.equal(state.project, 3);
  });

  it('never drops below zero, and forgets a project at zero', async () => {
    const path = await ledgerPath();
    const ledger = new QuotaLedger(path, { max: 10 });
    await ledger.reserve('p1', 2, DAY_MS);
    await ledger.release('p1', 9, DAY_MS);
    assert.equal((await ledger.snapshot('p1', DAY_MS)).created, 0);
    const document = JSON.parse(await readFile(path, 'utf8')) as { byProject: Record<string, number> };
    assert.deepEqual(document.byProject, {});
  });
});

describe('sharing one file', () => {
  it('does not lose a count when two ledgers write the same file', async () => {
    // Two instances model two Host processes, or a reloaded plugin beside one still running:
    // they share this file by definition, which is why the write path takes a lock and
    // re-reads inside it rather than trusting an in-process queue.
    const path = await ledgerPath();
    const a = new QuotaLedger(path, { max: 200 });
    const b = new QuotaLedger(path, { max: 200 });
    await Promise.all([
      ...Array.from({ length: 10 }, () => a.reserve('p1', 1, DAY_MS)),
      ...Array.from({ length: 10 }, () => b.reserve('p2', 1, DAY_MS)),
    ]);
    const state = await a.snapshot('p1', DAY_MS);
    assert.equal(state.created, 20);
    assert.equal(state.project, 10);
  });

  it('breaks a lock left behind by a dead process', async () => {
    const path = await ledgerPath();
    // A crash mid-write leaves the lock forever; without stale-lock recovery the plugin
    // would refuse to start threads until someone deleted the file by hand. Backdated,
    // because a lock that is merely *held* must still be waited for — only an abandoned one
    // may be broken, and age is the only signal available across processes.
    await writeFile(`${path}.lock`, '999999\n', 'utf8');
    const longAgo = new Date(Date.now() - 60_000);
    await utimes(`${path}.lock`, longAgo, longAgo);
    const ledger = new QuotaLedger(path, { max: 5 });
    const state = await ledger.reserve('p1', 1, DAY_MS);
    assert.equal(state.created, 1);
  });
});
