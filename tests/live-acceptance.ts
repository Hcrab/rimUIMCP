import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { connect, RimError } from '../packages/sdk/src/index.ts';

const game = await connect();
const directory = 'runs/acceptance-' + new Date().toISOString().replaceAll(':', '-');
mkdirSync(directory, { recursive: true });
const results: any[] = [];
async function check(name: string, fn: () => Promise<unknown>) {
  const started = performance.now();
  try { const evidence = await fn(); results.push({ name, passed: true, ms: performance.now() - started, evidence }); console.log('PASS ' + name); }
  catch (error) { results.push({ name, passed: false, ms: performance.now() - started, error: error instanceof RimError ? error.result : String(error) }); console.error('FAIL ' + name + ': ' + (error as Error).message); }
  writeFileSync(directory + '/results.json', JSON.stringify(results, null, 2));
}
await game.runtime.pause();
await check('all registered game patches applied', async () => {
  const status = await game.status();
  assert.equal(status.data.patches.optionalPatchFailureCount, 0);
  return status.data.patches;
});
let pawns: any[];
await check('game-thread snapshots and open field exploration', async () => {
  const roots = await game.state.roots();
  assert.ok(roots.data.game.id);
  const description = await game.state.describe(roots.data.game);
  assert.ok(description.data.fields.some((field: any) => field.name === 'playSettings'));
  const read = await game.state.read(roots.data.game, { fields: ['playSettings'], depth: 0 });
  assert.ok(read.data.fields.playSettings.id);
  pawns = (await game.state.pawns({ budgetMs: 250 })).data.items;
  assert.ok(pawns.length > 0 && pawns[0].ref.sessionId === roots.meta.sessionId);
  return { meta: roots.meta, pawnIds: pawns.map(p => p.id) };
});
await check('UI frames continue while simulation is paused', async () => {
  const before = (await game.status()).meta;
  const after = (await game.runtime.nextFrame(3)).meta;
  assert.equal(before.gameTick, after.gameTick); assert.ok(after.uiFrame >= before.uiFrame + 3);
  return { before, after };
});
await check('open collection pagination, cycle identity and bounded observation', async () => {
  const first = await game.state.query({ root: 'currentMap.pawns', derived: false, fields: ['thingIDNumber'], limit: 1, budgetMs: 500 });
  assert.ok(first.data.nextCursor > 0);
  const second = await game.state.query({ root: 'currentMap.pawns', derived: false, fields: ['thingIDNumber'], limit: 1, cursor: first.data.nextCursor, budgetMs: 500 });
  assert.notEqual(first.data.items[0].thingIDNumber, second.data.items[0].thingIDNumber);
  const tracker = await game.state.read(pawns[0].ref, { fields: ['jobs'], depth: 1, budgetMs: 500 });
  assert.equal(tracker.data.fields.jobs.fields.pawn.id, pawns[0].ref.id);
  await assert.rejects(game.state.read(pawns[0].ref, { depth: 8, maxNodes: 5 }), e => e instanceof RimError && e.code === 'BUDGET_EXCEEDED');
  return { first: first.data, second: second.data, cyclicPawnRef: tracker.data.fields.jobs.fields.pawn };
});
await check('visible work table, manual priorities, five real right clicks', async () => {
  await game.ui.panel('work').open();
  await game.ui.locator({ role: 'checkbox', name: 'Manual priorities' }).setChecked(true);
  const snapshot = await game.ui.snapshot();
  const node = snapshot.data.nodes.find((n: any) => n.role === 'work-cell' && !n.disabled && n.rowKey === 'Doctor');
  assert.ok(node);
  const cell = game.ui.locator({ role: 'work-cell', ownerId: node.ownerId, rowKey: node.rowKey });
  const before = Number(node.valueText), samples: number[] = [];
  await game.sequence(async () => {
    for (let i = 0; i < 5; i++) {
      const started = performance.now(); const input = await cell.click({ button: 'right' }); samples.push(performance.now() - started);
      assert.equal(input.data.inputProcessed, true);
      assert.equal(Number((await cell.read()).data.valueText), (before + i + 1) % 5);
    }
  });
  const actual = (await game.state.pawns({ budgetMs: 250 })).data.items.find((p: any) => p.id === node.ownerId).work[node.rowKey].priority;
  assert.equal(actual, before);
  return { ownerId: node.ownerId, workType: node.rowKey, before, after: actual, samples, screenshot: (await game.ui.screenshot('acceptance-work')).data.path };
});
await check('ambiguous selectors are rejected', async () => {
  await assert.rejects(game.ui.locator({ role: 'button' }).click(), error => error instanceof RimError && error.code === 'AMBIGUOUS_TARGET');
});
await check('exact tick advance and return to pause', async () => {
  const before = (await game.status()).meta;
  const result = await game.runtime.advance(120);
  assert.equal(result.meta.gameTick - before.gameTick, 120);
  const after = await game.runtime.nextFrame(3); assert.equal(after.meta.gameTick, result.meta.gameTick);
  return { before: before.gameTick, after: result.meta.gameTick, result: result.data };
});
await check('map selection and visible draft control', async () => {
  await game.ui.press('Escape');
  const pawn = (await game.state.pawns({ budgetMs: 250 })).data.items[0];
  await game.pawn(pawn.id).select();
  await game.ui.action('draft').activate();
  const after = (await game.state.pawns({ budgetMs: 250 })).data.items.find((p: any) => p.id === pawn.id);
  assert.equal(after.drafted, !pawn.drafted);
  const screenshot = (await game.ui.screenshot('acceptance-draft')).data.path;
  await game.ui.action('draft').activate();
  return { pawnId: pawn.id, screenshot };
});
const failed = results.filter(result => !result.passed);
console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, directory }));
if (failed.length) process.exitCode = 1;
