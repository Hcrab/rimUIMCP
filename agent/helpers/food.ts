import type {Game} from '../../packages/sdk/src/index.ts';
import {readAllPawns} from './pawns.ts';
import {selectThing} from './selection.ts';
import {queryAll} from './observe.ts';
import {findLocalizedNodes, requireLocalizedNode, requireUniqueUiNode, selectorForUiNode, type UiNode} from './ui-text.ts';

type FoodUiNode = UiNode & {
  targetId: string; actionable: boolean; surface: string; name: string | null;
  screenRect: {x: number; y: number; width: number; height: number};
};
const foodUi = async (game: Game) => (await game.call<{nodes: FoodUiNode[]}>('ui.snapshot')).data.nodes;

/** Uses the selected pawn's observed name only to locate its Assign row; verifies by pawn ID. */
export async function ensureFoodPolicy(game: Game, pawnId: string, policyName: string) {
  return game.sequence(async () => {
    const observation = await readAllPawns(game, {colonistsOnly: true});
    const pawn = observation.data.items.find(p => p.id === pawnId);
    if (!pawn) throw new Error('Colonist missing: ' + pawnId);
    const read = async () => game.state.read('game', {thingId: pawnId, fields: ['foodRestriction.curPolicy.label']});
    const before = await read();
    const current = before.data.fields['foodRestriction.curPolicy.label'];
    if (current === policyName) return {pawnId, policyName, changed: false};
    if (observation.data.items.filter(p => p.name === pawn.name).length !== 1)
      throw new Error('Assign row names are ambiguous; select an individual pawn policy control.');
    await game.ui.panel('assign').open();
    const nodes = await foodUi(game);
    const row = nodes.find(n => n.actionable && n.surface === 'main-tab:Assign' && n.name === pawn.name);
    const header = requireLocalizedNode(nodes, 'manageFoodPolicies', {
      predicate: n => n.actionable && n.surface === 'main-tab:Assign',
    });
    if (!row || !header) throw new Error('Food policy column or colonist row is not visible.');
    const candidates = nodes.filter(n => n.actionable && n.surface === row.surface && n.name === current &&
      n.screenRect.y >= row.screenRect.y && n.screenRect.y < row.screenRect.y + row.screenRect.height &&
      n.screenRect.x < header.screenRect.x + header.screenRect.width &&
      n.screenRect.x + n.screenRect.width > header.screenRect.x);
    if (candidates.length !== 1) throw new Error('Food policy cell is ambiguous or outside the visible table.');
    await game.ui.locator(selectorForUiNode(candidates[0])).click();
    const choice = requireUniqueUiNode((await foodUi(game)), n => n.actionable && n.surface.includes('FloatMenu') && n.name === policyName, `Food policy "${policyName}"`);
    await game.ui.locator(selectorForUiNode(choice)).click();
    const after = await read();
    if (after.meta.sessionId !== before.meta.sessionId || after.meta.worldEpoch !== before.meta.worldEpoch)
      throw new Error('World changed during food policy selection.');
    if (after.data.fields['foodRestriction.curPolicy.label'] !== policyName)
      throw new Error('Food policy input was processed but not applied to the requested pawn.');
    return {pawnId, policyName, changed: true, meta: after.meta};
  });
}

/** Configures an actual hopper through Storage. Ingredient choices belong to the caller. */
export async function configureHopper(game: Game, hopperId: string, allowed: {def: string; search: string}[]) {
  return game.sequence(async () => {
    const target = await game.state.read('game', {thingId: hopperId, fields: ['def.defName', 'settings.priorityInt']});
    if (target.data.fields['def.defName'] !== 'Hopper') throw new Error('Expected an actual hopper.');
    const ref = (await game.state.read('game', {thingId: hopperId})).data;
    const readAllowed = async () => (await queryAll(game, {ref, path: 'settings.filter.allowedDefs', derived: false, fields: ['defName']})).items.map(i => i.defName).sort();
    const expected = [...new Set(allowed.map(a => a.def))].sort();
    if (!expected.length) throw new Error('Supply hopper needs at least one allowed ingredient.');
    if (target.data.fields['settings.priorityInt'] === 'Critical' && JSON.stringify(await readAllowed()) === JSON.stringify(expected))
      return {hopperId, changed: false};
    await selectThing(game, hopperId);
    let nodes = await foodUi(game);
    if (!findLocalizedNodes(nodes, 'clearAll', {predicate: n => n.actionable && n.role === 'button'}).length) {
      const storage = requireLocalizedNode(nodes, 'storage', {predicate: n => n.actionable && n.role === 'button'});
      await game.ui.locator(selectorForUiNode(storage)).click();
    }
    nodes = await foodUi(game);
    const clearAll = requireLocalizedNode(nodes, 'clearAll', {predicate: n => n.actionable && n.role === 'button'});
    const surface = clearAll.surface;
    if (!surface) throw new Error('Hopper storage controls not visible.');
    await game.ui.locator(selectorForUiNode(clearAll)).click();
    for (const item of allowed) {
      await game.ui.locator({surface, role: 'text_field', source: 'gui.text_field'}).fill(item.search);
      await game.ui.locator({surface, role: 'checkbox', actionId: 'filter.thing.' + item.def}).setChecked(true);
    }
    await game.ui.locator({surface, role: 'text_field', source: 'gui.text_field'}).fill('');
    const priorityButton = requireLocalizedNode((await foodUi(game)), 'priority', {
      match: 'prefix', predicate: n => n.actionable && n.role === 'button' && n.surface === surface,
    });
    await game.ui.locator(selectorForUiNode(priorityButton)).click();
    const priority = requireLocalizedNode((await foodUi(game)), 'storagePriorityCritical', {
      predicate: n => n.actionable && n.role === 'button' && n.surface.includes('FloatMenu'),
    });
    await game.ui.locator(selectorForUiNode(priority)).click();
    const after = await game.state.read(ref, {fields: ['settings.priorityInt']});
    if (after.data.fields['settings.priorityInt'] !== 'Critical' || JSON.stringify(await readAllowed()) !== JSON.stringify(expected))
      throw new Error('Hopper storage result does not match the requested policy.');
    return {hopperId, changed: true, allowed: expected, meta: after.meta};
  });
}
