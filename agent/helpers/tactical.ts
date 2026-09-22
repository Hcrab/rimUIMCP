import type {Game, ObservationMeta} from '../../packages/sdk/src/index.ts';
import {clearDesignator, type Cell} from './architect.ts';
import {ensureDrafted} from './pawn.ts';
import {selectThing} from './selection.ts';

type MenuChoice = {actionable: boolean; surface: string; role: string; name?: string | null; disabled?: boolean | null};

function sameWorld(before: ObservationMeta, after: ObservationMeta) {
  if (before.sessionId !== after.sessionId || before.worldEpoch !== after.worldEpoch || before.mapId !== after.mapId)
    throw new Error('World or map changed during tactical input.');
}

async function closeMainPanels(game: Game) {
  await clearDesignator(game);
  const nodes = (await game.ui.snapshot()).data.nodes;
  const surfaces = new Set<string>(nodes.map((n: any) => n.surface).filter((s: any) => typeof s === 'string' && s.startsWith('main-tab:') && s !== 'main-tab:Inspect'));
  for (const surface of surfaces) {
    const action = 'panel.' + surface.slice('main-tab:'.length).toLowerCase();
    if (nodes.some((n: any) => n.actionId === action)) await game.ui.action(action).click();
  }
}

async function selectOnlyThing(game: Game, id: string) {
  const target = (await game.state.read('game', {thingId: id, budgetMs:500, maxNodes:100000})).data;
  const selected = async () => {
    const result = await game.state.read('selection', {path: 'selected', budgetMs:500, maxNodes:100000});
    const rows = result.data.items;
    const reference = rows?.[0]?.ref ?? rows?.[0];
    return rows?.length === 1 && reference?.id === target.id && reference?.sessionId === target.sessionId && reference?.worldEpoch === target.worldEpoch;
  };
  if (await selected()) return;
  await selectThing(game,id);
  if (!await selected()) throw new Error(`Single selection of ${id} was not observed; no tactical command was issued.`);
}

/** Toggle the real door gizmo. A held-open order does not itself open a closed door. */
export async function setDoorHoldOpen(game: Game, doorId: string, wanted: boolean) {
  return game.sequence(async () => {
    const read = () => game.state.read('game', {thingId: doorId, budgetMs:500, maxNodes:100000, fields: ['def.defName', 'holdOpenInt', 'openInt']});
    const before = await read();
    if (before.data.fields['def.defName'] !== 'Door' || typeof before.data.fields.holdOpenInt !== 'boolean')
      throw new Error(`${doorId} is not a readable vanilla door.`);
    let after = before;
    const changed = before.data.fields.holdOpenInt !== wanted;
    if (changed) {
      await closeMainPanels(game);
      await selectOnlyThing(game, doorId);
      const nodes = (await game.ui.snapshot()).data.nodes.filter((n: any) => n.actionable && n.surface === 'selection-gizmos' && n.ownerId === doorId && n.actionId === 'command.Misc3');
      if (nodes.length !== 1) throw new Error(`The hold-open gizmo for ${doorId} is not uniquely visible.`);
      await game.ui.locator({surface: 'selection-gizmos', ownerId: doorId, actionId: 'command.Misc3'}).click();
      after = await read();
      sameWorld(before.meta, after.meta);
      if (after.data.fields.holdOpenInt !== wanted) throw new Error(`Hold-open input for ${doorId} was not accepted.`);
    }
    return {doorId, changed, holdOpen: after.data.fields.holdOpenInt, open: after.data.fields.openInt, meta: after.meta};
  });
}

export function moveOrderAccepted(fields: Record<string, any>, cell: Cell) {
  const position = fields.positionInt;
  if (position?.x === cell.x && position?.z === cell.z) return 'arrived';
  const target = fields['jobs.curJob.targetA.cellInt'];
  return fields['jobs.curJob.def.defName'] === 'Goto' && target?.x === cell.x && target?.z === cell.z ? 'accepted' : null;
}

/** Single-pawn ground order; never right-click an enemy with a mixed selection. */
export async function moveDrafted(game: Game, pawnId: string, cell: Cell) {
  if (![cell.x, cell.z].every(Number.isInteger)) throw new Error('A move needs integer map cells.');
  return game.sequence(async () => {
    await closeMainPanels(game);
    await selectOnlyThing(game, pawnId);
    await ensureDrafted(game, pawnId, true);
    const read = () => game.state.read('game', {thingId: pawnId, budgetMs:500, maxNodes:100000, fields: ['positionInt', 'jobs.curJob.def.defName', 'jobs.curJob.targetA.cellInt']});
    const before = await read();
    let accepted = moveOrderAccepted(before.data.fields, cell);
    if (accepted) return {pawnId, cell, status: accepted, changed: false, meta: before.meta};
    await selectOnlyThing(game, pawnId);
    await game.call('ui.reveal', cell);
    await game.map.click(cell.x, cell.z, {button: 'right'});
    const choices = ((await game.ui.snapshot()).data.nodes as MenuChoice[]).filter(node => node.actionable && node.surface.includes('FloatMenu') && node.role === 'button');
    if (choices.length) {
      const moves = choices.filter(node => !node.disabled && ['走到这里', 'Go here'].includes(node.name ?? ''));
      if (moves.length !== 1) throw new Error(`Ground move has no unique visible menu choice: ${choices.map(node => node.name).join(' | ')}`);
      await game.ui.locator({surface: moves[0].surface, role: 'button', name: moves[0].name!, exact: true}).click();
    }
    const after = await read();
    sameWorld(before.meta, after.meta);
    accepted = moveOrderAccepted(after.data.fields, cell);
    if (!accepted) throw new Error(`Ground order for ${pawnId} was not observed as Goto(${cell.x},${cell.z}); inspect the menu or blocked cell.`);
    return {pawnId, cell, status: accepted, changed: true, meta: after.meta};
  });
}
