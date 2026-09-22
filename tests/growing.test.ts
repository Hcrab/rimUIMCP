import assert from 'node:assert/strict';
import test from 'node:test';
import {ensureGrowingZone} from '../agent/helpers/growing.ts';

type Cell = {x: number; z: number};
type Zone = {ref: any; cells: Cell[]; crop: string};
const rectangle = (from: Cell, to: Cell) => {
  const cells: Cell[] = [];
  for (let x = Math.min(from.x, to.x); x <= Math.max(from.x, to.x); x++) for (let z = Math.min(from.z, to.z); z <= Math.max(from.z, to.z); z++) cells.push({x, z});
  return cells;
};

class GrowingGame {
  zones: Zone[];
  selected: any = null;
  clickTargets: any[] = [];
  clickCount = 0;
  controlClicks: string[] = [];
  dragCount = 0;
  menuOpen = false;
  applyCropChoice = true;
  createOnDrag: {from: Cell; to: Cell; crop: string} | null = null;
  constructor(zones: Zone[]) { this.zones = zones; }
  state = {
    read: async (ref: any, options: any = {}) => {
      if (ref === 'currentMap') return {data: {items: this.zones.map(zone => zone.ref)}};
      if (ref === 'selection') return {data: {items: this.selected ? [this.selected] : []}};
      if (ref === 'designator') return {data: {fields: {selectedDesignator: null}}};
      const zone = this.zones.find(candidate => candidate.ref.id === ref.id);
      if (!zone) throw new Error(`Unknown reference ${ref.id}`);
      const fields: any = {};
      if (options.fields?.includes('cells')) fields.cells = {items: zone.cells};
      if (options.fields?.includes('plantDefToGrow.defName')) fields['plantDefToGrow.defName'] = zone.crop;
      return {data: {fields}};
    },
    describe: async () => ({data: {fields: [{name: 'cells', readable: true}, {name: 'plantDefToGrow', readable: true}]}}),
  };
  ui = {
    panel: () => ({open: async () => {}}),
    action: (actionId: string) => ({click: async () => { this.controlClicks.push(actionId); }}),
    press: async () => {},
    snapshot: async () => {
      const nodes: any[] = [{actionable: true, surface: 'architect', actionId: 'designator.Designator_ZoneAdd_Growing'}];
      if (this.menuOpen) nodes.push({actionable: true, surface: 'FloatMenu', role: 'button', name: 'Rice plant'});
      else if (this.zones.some(zone => zone.ref.id === this.selected?.id)) nodes.push({actionable: true, surface: 'selection-gizmos', role: 'button', name: 'Plant: Potato plant'});
      return {data: {nodes}};
    },
    locator: (selector: any) => ({click: async () => {
      this.controlClicks.push(selector.name);
      if (selector.name?.startsWith('Plant:')) this.menuOpen = true;
      if (selector.name === 'Rice plant') {
        this.menuOpen = false;
        if (this.applyCropChoice) this.zones.find(zone => zone.ref.id === this.selected.id)!.crop = 'Plant_Rice';
      }
    }}),
  };
  map = {
    click: async () => { this.selected = this.clickTargets[Math.min(this.clickCount++, this.clickTargets.length - 1)] ?? null; },
    drag: async () => {
      this.dragCount += 1;
      if (this.createOnDrag) this.zones.push({ref: {id: `zone-${this.zones.length}`, sessionId: 'test', worldEpoch: 1, type: 'RimWorld.Zone_Growing'}, cells: rectangle(this.createOnDrag.from, this.createOnDrag.to), crop: this.createOnDrag.crop});
    },
  };
  call = async () => ({data: {}});
  sequence = async <T>(work: () => Promise<T>) => work();
}

const ref = (id: string, type = 'RimWorld.Zone_Growing') => ({id, sessionId: 'test', worldEpoch: 1, type});
const plan = {from: {x: 10, z: 10}, to: {x: 11, z: 11}, cropDef: 'Plant_Rice', menuLabel: 'Rice plant'};

test('terrain omissions require explicit partial mode and are reported while changing the actual zone', async () => {
  const growing = ref('partial'), cells = rectangle(plan.from, plan.to).slice(1);
  const strict = new GrowingGame([{ref:growing,cells,crop:'Plant_Potato'}]);
  await assert.rejects(ensureGrowingZone(strict as any,plan),/overlaps/);
  assert.equal(strict.dragCount,0);
  const game = new GrowingGame([{ref:growing,cells,crop:'Plant_Potato'}]);
  game.clickTargets=[growing];
  const result=await ensureGrowingZone(game as any,{...plan,allowPartial:true});
  assert.equal(result.cropDef,'Plant_Rice');
  assert.deepEqual(result.excludedCells,[plan.from]);
  assert.deepEqual(result.cells,cells);
  assert.equal(game.dragCount,0);
});

test('partial mode cannot change a zone extending beyond the requested rectangle', async () => {
  const game = new GrowingGame([{ref:ref('outside'),cells:[plan.from,{x:50,z:50}],crop:'Plant_Potato'}]);
  await assert.rejects(ensureGrowingZone(game as any,{...plan,allowPartial:true}),/overlaps/);
  assert.deepEqual(game.controlClicks,[]);
});

test('repeating an already confirmed growing request does not click the GUI', async () => {
  const game = new GrowingGame([{ref: ref('rice'), cells: rectangle(plan.from, plan.to), crop: 'Plant_Rice'}]);
  const result = await ensureGrowingZone(game as any, plan);
  assert.equal(result.status, 'unchanged');
  assert.equal(game.clickCount, 0);
  assert.deepEqual(game.controlClicks, []);
});

test('retries map selection until the actual growing zone is selected above a plant', async () => {
  const growing = ref('rice'), plant = ref('plant', 'RimWorld.Plant');
  const game = new GrowingGame([{ref: growing, cells: rectangle(plan.from, plan.to), crop: 'Plant_Potato'}]);
  game.clickTargets = [plant, growing];
  const result = await ensureGrowingZone(game as any, plan);
  assert.equal(result.status, 'updated');
  assert.equal(result.cropDef, 'Plant_Rice');
  assert.equal(game.clickCount, 2);
  assert.ok(game.controlClicks.includes('Plant: Potato plant'));
  assert.ok(game.controlClicks.includes('Rice plant'));
});

test('rejects a crop menu input that did not change the growing-zone field', async () => {
  const growing = ref('potato');
  const game = new GrowingGame([{ref: growing, cells: rectangle(plan.from, plan.to), crop: 'Plant_Potato'}]);
  game.clickTargets = [growing];
  game.applyCropChoice = false;
  await assert.rejects(ensureGrowingZone(game as any, plan), /still reports Plant_Potato instead of Plant_Rice/);
});

test('does not create or change a zone when the requested rectangle overlaps another zone', async () => {
  const game = new GrowingGame([{ref: ref('existing'), cells: rectangle({x: 11, z: 10}, {x: 12, z: 11}), crop: 'Plant_Potato'}]);
  await assert.rejects(ensureGrowingZone(game as any, plan), /overlaps existing zone/);
  assert.equal(game.clickCount, 0);
  assert.equal(game.dragCount, 0);
  assert.deepEqual(game.controlClicks, []);
});

test('creates one requested rectangle and confirms its default crop without a second zone', async () => {
  const game = new GrowingGame([]);
  game.createOnDrag = {from: plan.from, to: plan.to, crop: 'Plant_Potato'};
  const potato = {...plan, cropDef: 'Plant_Potato', menuLabel: 'Potato plant'};
  assert.equal((await ensureGrowingZone(game as any, potato)).status, 'created');
  assert.equal((await ensureGrowingZone(game as any, potato)).status, 'unchanged');
  assert.equal(game.dragCount, 1);
  assert.equal(game.zones.length, 1);
});
