import assert from 'node:assert/strict';
import test from 'node:test';
import { scannerCandidate, runScannerShift } from '../agent/helpers/science.ts';

const worker = { id: 'Talia', spawned: true, factionIsPlayer: true, humanlike: true, job: 'Research', needs: { food: .8, rest: .8, mood: .7 } };
test('scanner orders preserve meals, sleep, medical work and low needs', () => {
  assert.equal(scannerCandidate(worker), true);
  for (const job of ['Ingest', 'LayDown', 'TendPatient', 'Rescue', 'HaulToCell']) assert.equal(scannerCandidate({ ...worker, job }), false);
  for (const name of ['food', 'rest', 'mood']) assert.equal(scannerCandidate({ ...worker, needs: { ...worker.needs, [name]: .1 } }), false);
  assert.equal(scannerCandidate({ ...worker, drafted: true }), false);
});

function fixture(items: any[]) {
  let pauses = 0, speeds = 0, reads = 0;
  const meta = { sessionId: 's', worldEpoch: 1, mapId: 'map', gameTick: 20, uiFrame: 1, snapshotId: 'snap' };
  const response = (data: any) => ({ success: true, requestId: 'r', meta, data });
  const game = {
    status: async () => response({}),
    runtime: { pause: async () => { pauses++; }, speed: async () => { speeds++; } },
    events: { poll: async () => response({ cursor: 1, gap: false, events: [] }) },
    state: {
      pawns: async ({ cursor, limit }: any) => {
        const page = items.slice(cursor, cursor + limit), next = cursor + page.length < items.length ? cursor + page.length : null;
        return response({ items: page, total: items.length, offset: cursor, limit, nextCursor: next, truncated: next !== null });
      },
      read: async () => { reads++; throw new Error('unexpected scanner read or mutation'); },
    },
  };
  return { game, counts: () => ({ pauses, speeds, reads }), options: { scannerId: 'Scanner', scannerRef: { id: 'obj:1', sessionId: 's', worldEpoch: 1, type: 'Scanner' }, workerIds: ['Talia'], menuLabel: 'Prioritize scanning', ticks: 1000, deadline: Date.now() + 1000 } };
}

test('scanner never issues an order or advances with a hostile on page two', async () => {
  const f = fixture([worker, ...Array.from({ length: 99 }, (_, i) => ({ id: 'Animal' + i })), { id: 'Enemy', hostile: true, spawned: true }]);
  const result = await runScannerShift(f.game as any, f.options);
  assert.equal(result.reason, 'hostile');
  assert.equal(f.counts().speeds, 0);
  assert.equal(f.counts().reads, 0);
  assert.ok(f.counts().pauses >= 2);
});

test('scanner stops for a resident mental break even when colonist control is false', async () => {
  const f = fixture([{ ...worker, colonist: false, mentalState: 'Berserk' }]);
  assert.equal((await runScannerShift(f.game as any, f.options)).reason, 'colonist-needs-attention');
  assert.equal(f.counts().speeds, 0);
});

test('expired and cancelled scanner shifts never advance or read stale objects', async () => {
  for (const cancelled of [false, true]) {
    const f = fixture([worker]);
    const controller = new AbortController();
    if (cancelled) controller.abort();
    const result = await runScannerShift(f.game as any, { ...f.options, deadline: cancelled ? f.options.deadline : 0, signal: controller.signal });
    assert.equal(result.reason, cancelled ? 'cancelled' : 'deadline');
    assert.deepEqual(f.counts(), { pauses: 2, speeds: 0, reads: 0 });
  }
});

test('scanner reference from a previous world is rejected before work', async () => {
  const f = fixture([worker]);
  const result = await runScannerShift(f.game as any, { ...f.options, scannerRef: { ...f.options.scannerRef, worldEpoch: 0 } });
  assert.equal(result.reason, 'world-changed');
  assert.equal(f.counts().reads, 0);
});

test('scanner read failure still leaves simulation paused', async () => {
  const f = fixture([worker]);
  await assert.rejects(runScannerShift(f.game as any, f.options), /unexpected scanner read/);
  assert.equal(f.counts().pauses, 2);
  assert.equal(f.counts().speeds, 0);
});
