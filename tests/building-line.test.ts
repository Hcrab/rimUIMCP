import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureBuildingLine } from '../agent/helpers/architect.ts';

const plan = { category: 'Structure', def: 'Wall', stuff: 'BlocksGranite' };
const meta = { sessionId: 'one', worldEpoch: 1, mapId: 'Map_0', gameTick: 1 };
const wall = (x: number) => ({ 'def.defName': 'Wall', positionInt: { x, z: 10 }, 'stuffInt.defName': 'BlocksGranite' });
function fixture(accepted: number[], existing: number[] = []) {
  let rows = existing.map(wall), selected = false, drags = 0;
  const result = (data: unknown) => ({ success: true, meta, data });
  const game: any = {
    sequence: async (fn: () => unknown) => fn(), call: async () => result({}),
    state: {
      query: async ({ root }: { root: string }) => {
        const items = root === 'defs' ? [{ defName: 'Wall', 'size.x': 1, 'size.z': 1 }] : rows;
        return result({ items, total: items.length, nextCursor: null });
      },
      read: async (root: string, options: any = {}) => {
        if (root === 'currentMap.blueprints') return result({ items: [] });
        if (root === 'designator' && options.fields.includes('selectedDesignator')) return result({ fields: { selectedDesignator: selected ? {} : null } });
        return result({ fields: { 'selectedDesignator.entDef.defName': 'Wall', 'selectedDesignator.stuffDef.defName': 'BlocksGranite' } });
      },
    },
    ui: {
      panel: () => ({ open: async () => {} }),
      snapshot: async () => result({ nodes: [{ actionable: true, actionId: 'build.Wall', surface: 'architect' }] }),
      action: () => ({ click: async () => { selected = true; } }),
      press: async () => { selected = false; },
    },
    map: { drag: async () => { drags++; rows = accepted.map(wall); return result({ inputProcessed: true }); } },
  };
  return { game, drags: () => drags, selected: () => selected };
}

test('a partially rejected drag reports the missing cell and clears its tool', async () => {
  const f = fixture([10, 12]);
  await assert.rejects(ensureBuildingLine(f.game, plan, { x: 10, z: 10 }, { x: 12, z: 10 }), /missing.*"x":11/);
  assert.equal(f.drags(), 1);
  assert.equal(f.selected(), false);
});

test('one verified drag creates the whole line; repeating it does not drag again', async () => {
  const f = fixture([10, 11, 12]);
  assert.equal((await ensureBuildingLine(f.game, plan, { x: 10, z: 10 }, { x: 12, z: 10 })).status, 'designated');
  assert.equal((await ensureBuildingLine(f.game, plan, { x: 10, z: 10 }, { x: 12, z: 10 })).status, 'existing');
  assert.equal(f.drags(), 1);
});
