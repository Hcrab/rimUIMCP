import type {Game, ObjectRef} from '../../packages/sdk/src/index.ts';
import {clearDesignator, designateRectangle, type Cell} from './architect.ts';
import {requireLocalizedNode, requireUniqueUiNode, selectorForUiNode} from './ui-text.ts';

export type GrowingPlan = {from: Cell; to: Cell; cropDef: string; menuLabel: string; allowPartial?: boolean};
type ZoneCells = {ref: ObjectRef; cells: Cell[]; growing: boolean};

const cellKey = (cell: Cell) => `${cell.x},${cell.z}`;
const sameRef = (left: ObjectRef, right: ObjectRef) => left.id === right.id && left.sessionId === right.sessionId && left.worldEpoch === right.worldEpoch;

function rectangle(plan: GrowingPlan) {
  for (const value of [plan.from.x, plan.from.z, plan.to.x, plan.to.z]) if (!Number.isInteger(value)) throw new Error('Growing-zone coordinates must be integers.');
  const cells: Cell[] = [];
  for (let x = Math.min(plan.from.x, plan.to.x); x <= Math.max(plan.from.x, plan.to.x); x++) {
    for (let z = Math.min(plan.from.z, plan.to.z); z <= Math.max(plan.from.z, plan.to.z); z++) cells.push({x, z});
  }
  return cells;
}

async function zones(game: Game): Promise<ZoneCells[]> {
  const refs = (await game.state.read('currentMap', {path: 'zoneManager.allZones', budgetMs: 500})).data.items as ObjectRef[];
  return Promise.all(refs.map(async ref => {
    const read = await game.state.read(ref, {fields: ['cells'], depth: 1, budgetMs: 500});
    return {ref, cells: (read.data.fields.cells?.items ?? []) as Cell[], growing: ref.type.endsWith('Zone_Growing')};
  }));
}

function exact(zone: ZoneCells, target: Cell[]) {
  const wanted = new Set(target.map(cellKey));
  return zone.cells.length === wanted.size && zone.cells.every(cell => wanted.has(cellKey(cell)));
}

function overlaps(zone: ZoneCells, target: Set<string>) {
  return zone.cells.some(cell => target.has(cellKey(cell)));
}

async function findTarget(game: Game, target: Cell[], allowPartial = false) {
  const all = await zones(game), wanted = new Set(target.map(cellKey));
  const exactZones = all.filter(zone => exact(zone, target));
  if (exactZones.length > 1) throw new Error('More than one zone owns the requested growing rectangle; inspect the overlapping zones.');
  const partialZones = allowPartial ? all.filter(zone => zone.growing && zone.cells.length > 0 && zone.cells.every(cell => wanted.has(cellKey(cell)))) : [];
  if (!exactZones.length && partialZones.length > 1) throw new Error('Several growing zones lie inside the requested rectangle; choose one explicitly.');
  const match = exactZones[0] ?? partialZones[0];
  if (match && !match.growing) throw new Error(`The requested rectangle is already a ${match.ref.type}, not a growing zone.`);
  const collisions = all.filter(zone => zone !== match && overlaps(zone, wanted));
  if (collisions.length) throw new Error(`The requested growing rectangle overlaps existing zone(s): ${collisions.map(zone => zone.ref.type).join(', ')}.`);
  return match;
}

async function growingState(game: Game, ref: ObjectRef) {
  const description = (await game.state.describe(ref)).data;
  const readable = new Set(description.fields.filter((field: any) => field.readable).map((field: any) => field.name));
  if (!readable.has('cells') || !readable.has('plantDefToGrow')) throw new Error('Zone_Growing does not expose cells and plantDefToGrow for confirmation.');
  const read = await game.state.read(ref, {fields: ['cells', 'plantDefToGrow.defName'], depth: 1, budgetMs: 500});
  const cropDef = read.data.fields['plantDefToGrow.defName'];
  if (typeof cropDef !== 'string') throw new Error('Zone_Growing did not return plantDefToGrow.defName.');
  return {cells: (read.data.fields.cells?.items ?? []) as Cell[], cropDef};
}

async function selectGrowingZone(game: Game, zone: ObjectRef, cell: Cell) {
  await clearDesignator(game);
  await game.call('ui.reveal', cell);
  for (let attempt = 0; attempt < 8; attempt++) {
    await game.map.click(cell.x, cell.z);
    const selected = (await game.state.read('selection', {path: 'selected', budgetMs: 500})).data.items as ObjectRef[];
    if (selected?.some(ref => sameRef(ref, zone))) return;
  }
  throw new Error('Could not select the requested growing zone through its map cell after 8 clicks.');
}

async function chooseCrop(game: Game, menuLabel: string) {
  const plant = requireLocalizedNode((await game.ui.snapshot()).data.nodes, 'plant', {
    match: 'prefix', predicate: (node: any) => node.actionable && node.surface === 'selection-gizmos' && node.role === 'button',
  });
  await game.ui.locator(selectorForUiNode(plant)).click();
  const choices = (await game.ui.snapshot()).data.nodes.filter((node: any) => node.actionable && typeof node.surface === 'string' && node.surface.includes('FloatMenu'));
  const choice = requireUniqueUiNode(choices, (node: any) => node.role === 'button' && node.name === menuLabel, `Crop menu choice "${menuLabel}"`);
  await game.ui.locator(selectorForUiNode(choice)).click();
}

/** Creates a growing rectangle. Explicit allowPartial accepts terrain omissions and reports the omitted cells. */
export async function ensureGrowingZone(game: Game, plan: GrowingPlan) {
  return game.sequence(async () => {
    if (!plan.cropDef) throw new Error('cropDef is required.');
    if (!plan.menuLabel) throw new Error('menuLabel is required.');
    const target = rectangle(plan);
    let zone = await findTarget(game, target, plan.allowPartial), created = false;
    if (!zone) {
      await designateRectangle(game, 'Zone', 'designator.Designator_ZoneAdd_Growing', plan.from, plan.to);
      zone = await findTarget(game, target, plan.allowPartial);
      if (!zone) throw new Error('Growing-zone input completed, but no zone owns the requested rectangle.');
      created = true;
    }
    let current = await growingState(game, zone.ref);
    const wanted = new Set(target.map(cellKey));
    if (!current.cells.length || (plan.allowPartial ? !current.cells.every(cell => wanted.has(cellKey(cell))) : !exact({ref: zone.ref, cells: current.cells, growing: true}, target))) throw new Error('Growing zone cells no longer match the requested rectangle.');
    const actualCells = current.cells;
    const actualKeys = new Set(actualCells.map(cellKey));
    const excludedCells = target.filter(cell => !actualKeys.has(cellKey(cell)));
    if (current.cropDef === plan.cropDef) return {status: created ? 'created' : 'unchanged', zone: zone.ref, cells: current.cells, excludedCells, cropDef: current.cropDef};
    await selectGrowingZone(game, zone.ref, current.cells[0]);
    await chooseCrop(game, plan.menuLabel);
    current = await growingState(game, zone.ref);
    if (!exact({ref: zone.ref, cells: current.cells, growing: true}, actualCells)) throw new Error('Growing zone cells changed while selecting the crop.');
    if (current.cropDef !== plan.cropDef) throw new Error(`Crop control processed input, but zone still reports ${current.cropDef} instead of ${plan.cropDef}.`);
    return {status: created ? 'created' : 'updated', zone: zone.ref, cells: current.cells, excludedCells, cropDef: current.cropDef};
  });
}
