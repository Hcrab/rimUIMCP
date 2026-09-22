import type { Game } from '../../packages/sdk/src/index.ts';
import { requireLocalizedNode, selectorForUiNode } from './ui-text.ts';

/** No staffing policy here: the AI supplies the pawn, work type and desired priority. */
export async function setPriority(game: Game, pawnId: string, workType: string, target: number) {
  if (!Number.isInteger(target) || target < 0 || target > 4) throw new Error('Priority must be 0–4.');
  return game.sequence(async () => {
    await game.ui.panel('work').open();
    const layout = (await game.ui.snapshot()).data;
    const manualPriorities = requireLocalizedNode(layout.nodes, 'manualPriorities', {
      predicate: node => node.actionable === true && node.role === 'checkbox',
    });
    await game.ui.locator(selectorForUiNode(manualPriorities)).setChecked(true);
    const cell = game.ui.locator({ surface: 'main.work', role: 'work-cell', ownerId: pawnId, rowKey: workType });
    let clicks = 0;
    for (; clicks < 5; clicks++) {
      const node = (await cell.read()).data;
      if (node.disabled) throw new Error(`${pawnId} cannot do ${workType}`);
      const current = Number(node.valueText);
      if (current === target) return { pawnId, workType, target, clicks };
      const forward = (target - current + 5) % 5, backward = (current - target + 5) % 5;
      await game.ui.input({ targetId: node.targetId, action: 'click', button: forward <= backward ? 'right' : 'left' });
    }
    throw new Error(`Priority did not reach ${target} after ${clicks} verified clicks.`);
  });
}

export async function setPriorities(game: Game, rows: { pawnId: string; workType: string; priority: number }[]) {
  return game.sequence(async () => {
    const results = [];
    for (const row of rows) results.push(await setPriority(game, row.pawnId, row.workType, row.priority));
    return results;
  });
}
