import assert from 'node:assert/strict';
import test from 'node:test';
import { runAndWatch } from '../agent/helpers/flow.ts';

const meta = (tick: number) => ({ sessionId: 'session', worldEpoch: 1, mapId: 'map', gameTick: tick, uiFrame: tick, snapshotId: `snapshot-${tick}` });
const response = (data: any, tick: number) => ({ success: true as const, requestId: 'request', meta: meta(tick), data });

function watchGame(items: any[]) {
  let running = false, tick = 0;
  const pauses: boolean[] = [], speeds: number[] = [];
  const game = {
    status: async () => response({}, tick),
    events: { poll: async (cursor = 0) => response({ cursor, gap: false, events: [] }, tick) },
    state: { pawns: async (args: any) => {
      if (running) tick += 1;
      const source = args.colonistsOnly ? items.filter(pawn => pawn.colonist) : items;
      const offset = args.cursor ?? 0, limit = args.limit;
      const page = source.slice(offset, offset + limit);
      const nextCursor = offset + page.length < source.length ? offset + page.length : null;
      return response({ items: page, total: source.length, offset, limit, nextCursor, truncated: nextCursor !== null }, tick);
    } },
    runtime: {
      pause: async () => { running = false; pauses.push(true); return response({}, tick); },
      speed: async (speed: number) => { running = true; speeds.push(speed); return response({}, tick); },
    },
  };
  return { game, pauses, speeds };
}

test('the 101st spawned hostile stops runAndWatch before its tick budget', async () => {
  const items = [...Array.from({ length: 100 }, (_, index) => ({ id: `Animal${index}`, spawned: true, hostile: false, colonist: index < 3 })), { id: 'Enemy101', spawned: true, hostile: true, colonist: false }];
  const fixture = watchGame(items);
  const watched = await runAndWatch(fixture.game as any, { ticks: 100, pollMs: 100, timeoutMs: 1000, stopOnNewLetter: false });
  assert.equal(watched.reason, 'hostile');
  assert.equal(watched.pawns?.[100].id, 'Enemy101');
  assert.ok(fixture.pauses.length >= 2, 'paged read pauses once and finally pauses again');
  assert.deepEqual(fixture.speeds, [], 'a hostile already present must not receive a free simulation interval');
  assert.equal(watched.elapsedTicks, 0);
});

test('a downed initial colonist on the final page is attention, not a safe tick advance', async () => {
  const items = Array.from({ length: 101 }, (_, index) => ({ id: `Colonist${index}`, spawned: true, hostile: false, colonist: true, downed: index === 100 }));
  const fixture = watchGame(items);
  const watched = await runAndWatch(fixture.game as any, { ticks: 100, pollMs: 100, timeoutMs: 1000, stopOnNewLetter: false });
  assert.equal(watched.reason, 'colonist-needs-attention');
  assert.equal(watched.pawns?.[100].downed, true);
  assert.equal(fixture.pauses.length, 2, 'initial paged roster and finally pause; no second observation after unsafe advance');
  assert.deepEqual(fixture.speeds, []);
});

test('a harmless multi-page observation resumes the requested speed only while watching continues', async () => {
  const items = Array.from({ length: 101 }, (_, index) => ({ id: `Animal${index}`, spawned: true, hostile: false, colonist: index < 3 }));
  const fixture = watchGame(items);
  const watched = await runAndWatch(fixture.game as any, { ticks: 2, pollMs: 100, timeoutMs: 1000, stopOnNewLetter: false });
  assert.equal(watched.reason, 'tick-budget');
  assert.deepEqual(fixture.speeds, [3, 3], 'the final budget observation remains paused');
});

test('an incomplete pawn observation throws and still pauses in finally', async () => {
  const fixture = watchGame([{ id: 'Colonist', colonist: true }]);
  fixture.game.state.pawns = async (args: any) => response({ items: [{ id: 'Colonist', colonist: true }], total: 2, offset: args.cursor ?? 0, limit: args.limit, nextCursor: args.cursor ?? 0, truncated: true }, 0);
  await assert.rejects(runAndWatch(fixture.game as any, { ticks: 10, pollMs: 100, timeoutMs: 1000 }), /cursor did not advance/);
  assert.equal(fixture.pauses.length, 2, 'the incomplete paged read pauses before the finally pause');
});

test('a world changed during the initial roster is never advanced', async () => {
  const fixture = watchGame([{ id: 'NewColonist', colonist: true }]);
  const original = fixture.game.state.pawns;
  fixture.game.state.pawns = async args => {
    const page = await original(args);
    page.meta.worldEpoch = 2;
    return page;
  };
  const watched = await runAndWatch(fixture.game as any, { ticks: 10, pollMs: 100 });
  assert.equal(watched.reason, 'world-changed');
  assert.deepEqual(fixture.speeds, []);
  assert.equal(fixture.pauses.length, 1);
});

test('an already-cancelled watch never starts the simulation', async () => {
  const fixture = watchGame([{ id: 'Colonist', colonist: true }]);
  const controller = new AbortController();
  controller.abort();
  const watched = await runAndWatch(fixture.game as any, { ticks: 10, signal: controller.signal });
  assert.equal(watched.reason, 'cancelled');
  assert.deepEqual(fixture.speeds, []);
  assert.equal(fixture.pauses.length, 1);
});

test('an existing mental break remains visible when colonist control is false', async () => {
  const fixture = watchGame([{id: 'Flynn', colonist: false, factionIsPlayer: true, humanlike: true, mentalState: 'Wander_OwnRoom'}]);
  const watched = await runAndWatch(fixture.game as any, {ticks: 10, pollMs: 100});
  assert.equal(watched.reason, 'colonist-needs-attention');
  assert.deepEqual(fixture.speeds, [], 'existing mental breaks remain paused');
});

test('the caller can stop before the first advance, including a predator already targeting a resident', async () => {
  const fixture = watchGame([{id: 'Colonist', colonist: true}]);
  const watched = await runAndWatch(fixture.game as any, {ticks: 10, pollMs: 100, stopWhen: () => 'predator-hunting-colonist'});
  assert.equal(watched.reason, 'predator-hunting-colonist');
  assert.deepEqual(fixture.speeds, []);
});

test('a map switch during the initial observation does not start the new map', async () => {
  const fixture = watchGame([{id: 'Colonist', colonist: true}]);
  const original = fixture.game.state.pawns;
  fixture.game.state.pawns = async args => {
    const page = await original(args);
    page.meta.mapId = 'other-map';
    return page;
  };
  const watched = await runAndWatch(fixture.game as any, {ticks: 10, pollMs: 100});
  assert.equal(watched.reason, 'world-changed');
  assert.deepEqual(fixture.speeds, []);
});

test('a resident losing control during observation still stops the watch', async () => {
  const pawn = {id: 'Flynn', colonist: true, factionIsPlayer: true, humanlike: true, mentalState: null as string | null};
  const fixture = watchGame([pawn]);
  const original = fixture.game.state.pawns;
  let reads = 0;
  fixture.game.state.pawns = async args => {
    if (++reads > 1) {pawn.colonist = false; pawn.mentalState = 'Berserk';}
    return original(args);
  };
  const watched = await runAndWatch(fixture.game as any, {ticks: 10, pollMs: 100});
  assert.equal(watched.reason, 'colonist-needs-attention');
});

test('a watched prisoner disappearing after a complete observation returns its missing ID', async () => {
  const colonist = {id: 'Colonist', colonist: true};
  const prisoner = {id: 'Friedman', colonist: false, prisoner: true};
  const items = [colonist, prisoner];
  const fixture = watchGame(items);
  const original = fixture.game.state.pawns;
  let reads = 0;
  fixture.game.state.pawns = async args => {
    if (++reads === 2) items.splice(1, 1);
    return original(args);
  };
  const watched = await runAndWatch(fixture.game as any, {
    ticks: 10, pollMs: 100, timeoutMs: 1000, stopOnNewLetter: false,
    watchedPawnIds: ['Friedman', 'Friedman'],
  });
  assert.equal(watched.reason, 'watched-pawn-missing');
  assert.deepEqual(watched.watchedPawnIds, ['Friedman']);
  assert.deepEqual(watched.missingPawnIds, ['Friedman']);
  assert.deepEqual(fixture.speeds, [3]);
});

test('a watched prisoner missing before start stops without advancing and reports the ID', async () => {
  const fixture = watchGame([{id: 'Colonist', colonist: true}]);
  const watched = await runAndWatch(fixture.game as any, {
    ticks: 10, pollMs: 100, timeoutMs: 1000, watchedPawnIds: ['Friedman'],
  });
  assert.equal(watched.reason, 'watched-pawn-missing');
  assert.deepEqual(watched.missingPawnIds, ['Friedman']);
  assert.deepEqual(fixture.speeds, []);
});

test('a watched non-colonist downed pawn stops with the dedicated attention reason', async () => {
  const fixture = watchGame([
    {id: 'Colonist', colonist: true},
    {id: 'Friedman', colonist: false, prisoner: true, downed: true},
  ]);
  const watched = await runAndWatch(fixture.game as any, {
    ticks: 10, pollMs: 100, timeoutMs: 1000, watchedPawnIds: ['Friedman'],
  });
  assert.equal(watched.reason, 'watched-pawn-needs-attention');
  assert.deepEqual(watched.missingPawnIds, []);
  assert.deepEqual(fixture.speeds, []);
});

test('without a watch list a wild pawn mental state does not stop the global flow', async () => {
  const fixture = watchGame([
    {id: 'Colonist', colonist: true},
    {id: 'Sheep65031', colonist: false, animal: true, mentalState: 'PanicFlee'},
  ]);
  const watched = await runAndWatch(fixture.game as any, {
    ticks: 1, pollMs: 100, timeoutMs: 1000, stopOnNewLetter: false,
  });
  assert.equal(watched.reason, 'tick-budget');
  assert.deepEqual(watched.watchedPawnIds, []);
});

test('watched pawn IDs reject invalid input before starting the flow', async () => {
  const fixture = watchGame([{id: 'Colonist', colonist: true}]);
  await assert.rejects(
    runAndWatch(fixture.game as any, {ticks: 10, watchedPawnIds: [''] as any}),
    /watchedPawnIds/,
  );
  assert.deepEqual(fixture.speeds, []);
  assert.equal(fixture.pauses.length, 0);
});
