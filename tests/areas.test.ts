import assert from 'node:assert/strict';
import test from 'node:test';
import type { Game } from '../packages/sdk/src/index.ts';
import { allowedArea, assignAllowedArea } from '../agent/helpers/areas.ts';

function fixture(options: { accepted?: boolean; changedWorld?: boolean } = {}) {
  let selected: number | null = null, clicks = 0;
  const game = {
    status: async () => ({ meta: { sessionId: options.changedWorld && clicks ? 'new' : 'same', worldEpoch: 1, mapId: 'Map_0' } }),
    sequence: async (fn: () => unknown) => fn(),
    state: {
      read: async () => ({ data: { fields: { uniqueID: 0 } } }),
      query: async () => ({ data: { nextCursor: null, items: [
        { 'key.uniqueID': 1, 'value.ID': 5, 'value.labelInt': 'Another map' },
        { 'key.uniqueID': 0, 'value.ID': selected, 'value.labelInt': selected === null ? null : 'Scanner duty' },
      ] } }),
    },
    ui: {
      panel: () => ({ open: async () => {} }),
      locator: (selector: { ownerId: string; rowKey: string; actionId: string }) => ({ click: async () => {
        assert.equal(selector.ownerId, 'Human1345'); assert.equal(selector.actionId, 'schedule.area'); clicks++;
        if (options.accepted !== false) selected = selector.rowKey === 'unrestricted' ? null : Number(selector.rowKey);
      } }),
    },
  } as unknown as Game;
  return { game, clicks: () => clicks };
}

test('area assignment reads the current map instead of the first dictionary entry', async () => {
  const f = fixture();
  assert.equal((await allowedArea(f.game, 'Human1345')).areaId, null);
  assert.equal((await assignAllowedArea(f.game, 'Human1345', 5)).areaId, 5);
  assert.equal(f.clicks(), 1);
});

test('verified repeat assignment does not click the selector again', async () => {
  const f = fixture(); await assignAllowedArea(f.game, 'Human1345', 5);
  assert.equal((await assignAllowedArea(f.game, 'Human1345', 5)).status, 'unchanged');
  assert.equal(f.clicks(), 1);
});

test('processed input cannot claim an unobserved area assignment', async () => {
  const f = fixture({ accepted: false });
  await assert.rejects(assignAllowedArea(f.game, 'Human1345', 5), /not observed/);
});

test('a world change after the click invalidates the assignment result', async () => {
  const f = fixture({ changedWorld: true });
  await assert.rejects(assignAllowedArea(f.game, 'Human1345', 5), /World or map changed/);
});
