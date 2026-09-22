import assert from 'node:assert/strict';
import test from 'node:test';
import { PawnPagingError, readAllPawns } from '../agent/helpers/pawns.ts';

const pawns = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `Pawn${index + 1}` }));
const meta = (tick = 40, sessionId = 'session', worldEpoch = 1) => ({ sessionId, worldEpoch, mapId: 'map', gameTick: tick, uiFrame: tick, snapshotId: `${sessionId}-${worldEpoch}-${tick}` });
const result = (data: any, observation = meta()) => ({ success: true as const, requestId: 'request', meta: observation, data });

function metadataGame(items: any[], overrides: { total?: (offset: number, count: number) => number; meta?: (offset: number) => any } = {}) {
  return { state: { pawns: async (args: any) => {
    const offset = args.cursor ?? 0, limit = args.limit;
    const page = items.slice(offset, offset + limit);
    const total = overrides.total?.(offset, page.length) ?? items.length;
    const nextCursor = offset + page.length < total ? offset + page.length : null;
    return result({ items: page, total, offset, limit, nextCursor, truncated: nextCursor !== null }, overrides.meta?.(offset) ?? meta());
  } } };
}

test('returns explicit complete metadata for a single page, exact boundary, and empty set', async () => {
  for (const count of [7, 100, 0]) {
    let pauses = 0;
    const read = await readAllPawns(metadataGame(pawns(count)) as any, { pageSize: 100, pauseForConsistency: async () => { pauses += 1; } });
    assert.equal(read.data.total, count);
    assert.equal(read.data.truncated, false);
    assert.equal(read.data.nextCursor, null);
    assert.equal(read.data.complete, true);
    assert.equal(read.data.pages.length, 1);
    assert.equal(read.data.pages[0].truncated, false);
    assert.equal(pauses, 0);
  }
});

test('restarts a multi-page scan under pause and retains page-level truncation evidence', async () => {
  let pauses = 0;
  const read = await readAllPawns(metadataGame(pawns(205)) as any, { pageSize: 100, pauseForConsistency: async () => { pauses += 1; } });
  assert.equal(pauses, 1);
  assert.equal(read.resumeRequired, true);
  assert.equal(read.data.consistency, 'paused-restart');
  assert.equal(read.data.pageCount, 3);
  assert.deepEqual(read.data.pages.map(page => page.truncated), [true, true, false]);
  assert.deepEqual(read.data.items.map(pawn => pawn.id), pawns(205).map(pawn => pawn.id));
});

test('supports a legacy items-only bridge by reading through its empty tail page', async () => {
  let pauses = 0;
  const game = { state: { pawns: async (args: any) => result({ items: pawns(100).slice(args.cursor ?? 0, (args.cursor ?? 0) + args.limit) }) } };
  const read = await readAllPawns(game as any, { pageSize: 100, pauseForConsistency: async () => { pauses += 1; } });
  assert.equal(pauses, 1);
  assert.equal(read.data.bridge, 'legacy');
  assert.equal(read.data.total, 100);
  assert.equal(read.data.pages.length, 2);
  assert.equal(read.data.pages[1].count, 0);
});

test('rejects incomplete metadata, stalled pages, changed totals, and a changed world', async () => {
  const partial = { state: { pawns: async () => result({ items: [], total: 0 }) } };
  await assert.rejects(readAllPawns(partial as any), PawnPagingError);

  const stalled = { state: { pawns: async (args: any) => result({ items: pawns(1), total: 2, offset: args.cursor ?? 0, limit: args.limit, nextCursor: args.cursor ?? 0, truncated: true }) } };
  await assert.rejects(readAllPawns(stalled as any, { pageSize: 1, pauseForConsistency: async () => {} }), /cursor did not advance/);

  const changingTotal = metadataGame(pawns(101), { total: offset => offset === 0 ? 101 : 102 });
  await assert.rejects(readAllPawns(changingTotal as any, { pageSize: 100, pauseForConsistency: async () => {} }), /total changed/);

  const changingWorld = metadataGame(pawns(101), { meta: offset => meta(40, offset === 0 ? 'session' : 'other') });
  await assert.rejects(readAllPawns(changingWorld as any, { pageSize: 100, pauseForConsistency: async () => {} }), /changed session or world/);

  const missingFinalPage = { state: { pawns: async (args: any) => {
    const offset = args.cursor ?? 0;
    return result({ items: offset === 0 ? pawns(100) : [], total: 101, offset, limit: args.limit, nextCursor: null, truncated: false });
  } } };
  await assert.rejects(readAllPawns(missingFinalPage as any, { pageSize: 100, pauseForConsistency: async () => {} }), /count mismatch/);
});

test('rejects duplicate ids, unstable game ticks, and a page-budget overrun', async () => {
  const duplicates = metadataGame([{ id: 'same' }, { id: 'same' }]);
  await assert.rejects(readAllPawns(duplicates as any), /repeated pawn id/);

  const ticks = metadataGame(pawns(101), { meta: offset => meta(offset === 0 ? 40 : 41) });
  await assert.rejects(readAllPawns(ticks as any, { pageSize: 100, pauseForConsistency: async () => {} }), /changed game tick/);

  await assert.rejects(readAllPawns(metadataGame(pawns(201)) as any, { pageSize: 100, maxPages: 2, pauseForConsistency: async () => {} }), /safety budget/);
});

test('the page budget does not issue a discarded extra page', async () => {
  const game = metadataGame(pawns(201));
  const original = game.state.pawns;
  const cursors: number[] = [];
  game.state.pawns = async args => { cursors.push(args.cursor); return original(args); };
  await assert.rejects(readAllPawns(game as any, { maxPages: 2, pauseForConsistency: async () => {} }), /safety budget/);
  assert.deepEqual(cursors, [0, 0, 100], 'one probe followed by the two permitted retained pages');
});
