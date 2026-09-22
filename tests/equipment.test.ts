import assert from 'node:assert/strict';
import test from 'node:test';
import { wear } from '../agent/helpers/equipment.ts';

const meta = (gameTick = 0) => ({
  sessionId: 'session',
  worldEpoch: 1,
  mapId: 'Map_0',
  gameTick,
  uiFrame: gameTick,
  snapshotId: `snapshot-${gameTick}`,
});

const result = (data: any, gameTick = 0) => ({
  success: true as const,
  requestId: 'request',
  meta: meta(gameTick),
  data,
});

function equipmentFixture(options: {
  pawnId: string;
  thingId: string;
  menuName: string;
  initialEquipment?: boolean;
  delayedEquipment?: boolean;
}) {
  let running = false;
  let tick = 0;
  let transferRequested = false;
  let equipmentTransferred = options.initialEquipment ?? false;
  let apparelWorn = false;
  let selected = false;
  let equipmentObservedDuringWatch = false;
  const number = Number(options.thingId.match(/\d+$/)?.[0]);
  const pawnRef = { id: 'obj:pawn', sessionId: 'session', worldEpoch: 1, type: 'Verse.Pawn' };
  const targetRef = { id: 'obj:thing', sessionId: 'session', worldEpoch: 1, type: 'Verse.ThingWithComps' };
  const calls = { pawnReads: 0, query: 0, groundReads: 0, pawnSelects: 0, mapClicks: 0, menuClicks: 0, speeds: 0, pauses: 0 };

  const pawnRow = () => ({
    id: options.pawnId,
    colonist: true,
    factionIsPlayer: true,
    humanlike: true,
    spawned: true,
    dead: false,
    downed: false,
    mentalState: null,
    equipment: equipmentTransferred ? [{ id: options.thingId, def: 'Gun_MachinePistol', reference: targetRef }] : [],
  });

  const game: any = {
    sequence: async (fn: (game: any) => Promise<unknown>) => fn(game),
    status: async () => result({}, tick),
    events: { poll: async (cursor = 0) => result({ cursor, gap: false, events: [] }, tick) },
    state: {
      pawns: async (args: any) => {
        calls.pawnReads += 1;
        if (running && options.delayedEquipment && transferRequested) {
          equipmentTransferred = true;
          equipmentObservedDuringWatch = true;
          tick = 120;
        }
        const items = [pawnRow()];
        const offset = args.cursor ?? 0;
        return result({ items, total: 1, offset, limit: args.limit, nextCursor: null, truncated: false }, tick);
      },
      read: async (root: string, args: any) => {
        if (root === 'selection') return result({ items: selected ? [{ ref: pawnRef, id: options.pawnId }] : [] }, tick);
        if (root !== 'game') throw new Error(`unexpected state root ${root}`);
        if (args.thingId === options.thingId && args.fields?.includes('positionInt')) {
          calls.groundReads += 1;
          return result({ fields: { positionInt: { x: 5, z: 6 } } }, tick);
        }
        if (args.thingId === options.pawnId) return result(pawnRef, tick);
        return result(targetRef, tick);
      },
      query: async () => {
        calls.query += 1;
        return result({ items: apparelWorn ? [{ thingIDNumber: number, 'def.defName': 'Apparel_Pants' }] : [] }, tick);
      },
    },
    thing: (id: string) => ({
      select: async () => {
        assert.equal(id, options.pawnId);
        calls.pawnSelects += 1;
        selected = true;
        return result({ inputProcessed: true }, tick);
      },
    }),
    map: {
      click: async () => {
        calls.mapClicks += 1;
        return result({ inputProcessed: true }, tick);
      },
    },
    ui: {
      snapshot: async () => result({ nodes: [{ actionable: true, surface: 'FloatMenu', role: 'button', name: options.menuName }] }, tick),
      locator: () => ({
        click: async () => {
          calls.menuClicks += 1;
          transferRequested = true;
          if (!options.delayedEquipment && options.thingId.startsWith('Gun_')) equipmentTransferred = true;
          if (options.thingId.startsWith('Apparel_')) apparelWorn = true;
          return result({ inputProcessed: true }, tick);
        },
      }),
    },
    runtime: {
      speed: async () => {
        calls.speeds += 1;
        running = true;
        return result({}, tick);
      },
      pause: async () => {
        calls.pauses += 1;
        running = false;
        return result({}, tick);
      },
      nextFrame: async () => result({}, tick),
    },
  };

  return { game, calls, equipmentObservedDuringWatch: () => equipmentObservedDuringWatch, equipmentTransferred: () => equipmentTransferred, apparelWorn: () => apparelWorn };
}

test('an already equipped gun is idempotent without reading the ground target or sending input', async () => {
  const fixture = equipmentFixture({ pawnId: 'Human8372', thingId: 'Gun_MachinePistol63951', menuName: 'Equip machine pistol', initialEquipment: true });

  const observed = await wear(fixture.game, 'Human8372', 'Gun_MachinePistol63951');

  assert.deepEqual(observed, { status: 'already-equipped', pawnId: 'Human8372', thingId: 'Gun_MachinePistol63951' });
  assert.equal(fixture.calls.groundReads, 0);
  assert.equal(fixture.calls.pawnSelects, 0);
  assert.equal(fixture.calls.mapClicks, 0);
  assert.equal(fixture.calls.menuClicks, 0);
  assert.equal(fixture.calls.speeds, 0);
});

test('an Equip order is accepted from pawn equipment after a delayed transfer', async () => {
  const fixture = equipmentFixture({ pawnId: 'Human8372', thingId: 'Gun_MachinePistol63951', menuName: 'Equip machine pistol', delayedEquipment: true });

  const observed = await wear(fixture.game, 'Human8372', 'Gun_MachinePistol63951');

  assert.equal(observed.status, 'equipped');
  assert.equal(fixture.equipmentTransferred(), true);
  assert.equal(fixture.equipmentObservedDuringWatch(), true, 'the weapon became equipment during the bounded watch');
  assert.equal(fixture.calls.groundReads, 1);
  assert.equal(fixture.calls.menuClicks, 1);
  assert.equal(fixture.calls.speeds, 1);
  assert.equal(fixture.calls.pauses, 1, 'the existing watch still pauses in its finally block');
});

test('a Force wear order still accepts apparel through wornApparel', async () => {
  const fixture = equipmentFixture({ pawnId: 'Human8372', thingId: 'Apparel_Pants42', menuName: 'Force wear pants' });

  const observed = await wear(fixture.game, 'Human8372', 'Apparel_Pants42');

  assert.equal(observed.status, 'worn');
  assert.equal(fixture.apparelWorn(), true);
  assert.equal(fixture.calls.groundReads, 1);
  assert.equal(fixture.calls.menuClicks, 1);
  assert.equal(fixture.calls.speeds, 0, 'the existing immediate apparel acceptance remains intact');
});
