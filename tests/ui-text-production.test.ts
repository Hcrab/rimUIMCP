import assert from 'node:assert/strict';
import test from 'node:test';
import {ensureBill, type BillPlan} from '../agent/helpers/production.ts';

const meta = {sessionId: 'test-session', worldEpoch: 1, mapId: 'map', gameTick: 10, uiFrame: 20, snapshotId: 'snapshot'};
const result = <T>(data: T) => ({success: true, requestId: 'test-request', meta, data});

function billFixture(surfaces: string[], options: {recipe?: string; acceptCheckbox?: boolean} = {}) {
  const recipe = options.recipe ?? 'CookMealSimple';
  const station = {id: 'FueledStove1', sessionId: meta.sessionId, worldEpoch: meta.worldEpoch, type: 'Thing_ThingWithComps'};
  const billReference = {id: 'Bill1', sessionId: meta.sessionId, worldEpoch: meta.worldEpoch, type: 'Bill_Production'};
  let selected = false;
  let targetCount = 0;
  let radius = 3;
  let includeEquipped = false;
  const selectors: Record<string, unknown>[] = [];
  const nodes = [
    {targetId: 'add-bill', surface: 'main-tab:Inspect', role: 'button', name: 'Add bill', actionable: true},
    {targetId: 'details', surface: 'main-tab:Inspect', role: 'button', name: 'Details...', actionable: true, ownerId: station.id, rowKey: `Bill_${recipe}_42`},
    ...surfaces.flatMap((surface, index) => [
      {targetId: `count-${index}`, surface, role: 'text_field', name: 'Count', actionable: true, source: 'gui.text_field'},
      {targetId: `radius-${index}`, surface, role: 'slider', name: 'Radius', actionable: true, source: 'rp.slider'},
      {targetId: `clear-${index}`, surface, role: 'button', name: 'Clear all', actionable: true},
      {targetId: `close-${index}`, surface, role: 'button', name: 'Close', actionable: true},
      ...(recipe === 'Make_Bow_Short' ? [{targetId: `equipped-${index}`, surface, role: 'checkbox', name: '包括已装备的', actionable: true}] : []),
    ]),
  ];
  const settings = () => result({fields: {
    loadID: 42,
    'repeatMode.defName': 'TargetCount',
    targetCount,
    ingredientSearchRadius: radius,
    suspended: false,
    includeEquipped,
  }});
  const game: any = {
    sequence: async (fn: (game: any) => Promise<unknown>) => fn(game),
    state: {
      read: async (ref: any, options: Record<string, unknown> = {}) => {
        if (ref === 'selection') return result({items: selected ? [station] : []});
        if (ref === 'game' && options.thingId === station.id) return result(station);
        if (ref === billReference) return settings();
        throw new Error(`Unexpected state.read fixture call: ${String(ref)}`);
      },
      bills: async () => result({items: [{owner: {id: station.id}, bills: [{recipe, reference: billReference}]}]}),
    },
    ui: {
      snapshot: async () => result({nodes}),
      locator: (selector: Record<string, unknown>) => ({
        click: async () => { selectors.push({action: 'click', ...selector}); return result({}); },
        fill: async (text: string) => { targetCount = Number(text); selectors.push({action: 'fill', ...selector}); return result({}); },
        setValue: async (value: number) => { radius = Number(value); selectors.push({action: 'setValue', ...selector}); return result({}); },
        setChecked: async (value: boolean) => { if (options.acceptCheckbox !== false) includeEquipped = value; selectors.push({action: 'setChecked', ...selector}); return result({}); },
      }),
    },
    thing: () => ({select: async () => { selected = true; return result({}); }}),
  };
  return {game, selectors, get targetCount() { return targetCount; }, get radius() { return radius; }};
}

test('ensureBill accepts many controls in one BillConfig surface but rejects distinct windows', async () => {
  const plan: BillPlan = {stationId: 'FueledStove1', recipe: 'CookMealSimple', menuLabel: 'Cook simple meal', mode: 'TargetCount', count: 12, radius: 30};
  const oneWindow = billFixture(['Dialog_BillConfig:one']);
  const updated = await ensureBill(oneWindow.game, plan);
  assert.equal(updated.status, 'updated');
  assert.equal(oneWindow.targetCount, 12);
  assert.equal(oneWindow.radius, 30);
  assert.ok(oneWindow.selectors.some(selector => selector.action === 'click' && selector.name === 'Details...'));
  assert.ok(oneWindow.selectors.some(selector => selector.action === 'click' && selector.name === 'Close'));

  const twoWindows = billFixture(['Dialog_BillConfig:one', 'Dialog_BillConfig:two']);
  await assert.rejects(() => ensureBill(twoWindows.game, plan), /Expected one bill configuration window; found 2/);
  assert.equal(twoWindows.targetCount, 0);
  assert.equal(twoWindows.radius, 3);
});

test('equipped weapons count through the Chinese checkbox and unchanged requests do not toggle it again', async () => {
  const fixture = billFixture(['Dialog_BillConfig:one'], {recipe: 'Make_Bow_Short'});
  const plan: BillPlan = {stationId: 'FueledStove1', recipe: 'Make_Bow_Short', menuLabel: '制作短弓', mode: 'TargetCount', count: 3, includeEquipped: true};
  const first = await ensureBill(fixture.game, plan);
  assert.equal(first.settings.includeEquipped, true);
  assert.equal(fixture.selectors.filter(s => s.action === 'setChecked').length, 1);
  assert.equal((await ensureBill(fixture.game, plan)).status, 'unchanged');
  assert.equal(fixture.selectors.filter(s => s.action === 'setChecked').length, 1);
});

test('a processed equipment checkbox without a matching game state is rejected', async () => {
  const fixture = billFixture(['Dialog_BillConfig:one'], {recipe: 'Make_Bow_Short', acceptCheckbox: false});
  await assert.rejects(ensureBill(fixture.game, {stationId: 'FueledStove1', recipe: 'Make_Bow_Short', menuLabel: '制作短弓', mode: 'TargetCount', count: 3, includeEquipped: true}), /requested fields were not observed/);
});
