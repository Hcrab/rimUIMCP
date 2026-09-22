import type {Game} from '../../packages/sdk/src/index.ts';
import {requireLocalizedNode, selectorForUiNode} from './ui-text.ts';

/** Select a known world object through the world map, then verify the loaded map. */
export async function showMap(game: Game, target: {mapId: string; tileId: number; worldObjectId: number}) {
  return game.sequence(async () => {
    await game.runtime.pause();
    if ((await game.state.map()).data.id === target.mapId && !(await game.state.world()).data.visible) return {changed: false};
    await game.ui.panel('world').open();
    let selected = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      await game.world.reveal(target.tileId);
      await game.runtime.nextFrame(20);
      await game.world.click(target.tileId);
      selected = (await game.state.world()).data.selectedObjectIds.includes(target.worldObjectId);
      if (selected) break;
    }
    if (!selected) throw Error(`World object ${target.worldObjectId} was not selected.`);
    const zoomIn = requireLocalizedNode((await game.ui.snapshot()).data.nodes, 'zoomIn', {
      predicate: node => node.actionable === true && node.role === 'button',
    });
    await game.ui.locator(selectorForUiNode(zoomIn)).click();
    const actual = (await game.state.map()).data.id;
    if (actual !== target.mapId) throw Error(`Expected ${target.mapId}, observed ${actual}.`);
    return {changed: true, mapId: actual};
  });
}
