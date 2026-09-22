import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { connect, RimError } from '../packages/sdk/src/index.ts';
import { Bridge } from '../packages/runtime/src/bridge.ts';
const game = await connect(), status = await game.status();
assert.equal(status.data.fixtureMode, false);
const bridge = new Bridge(JSON.parse(readFileSync('work/connection.json', 'utf8')));
let names: string[];
try { await bridge.connect(); names = (await bridge.request('tools/list')).tools.map((t: any) => t.name); }
finally { bridge.close(); }
assert.deepEqual(names, ['rimuimcp/call']);
await assert.rejects(game.call('fixture.spawn', { def: 'Steel', x: 0, z: 0 }), e => e instanceof RimError && e.code === 'FIXTURE_DISABLED');
assert.equal(status.data.patches.optionalPatchFailureCount, 0);
const roots = await game.state.roots(), layout = await game.ui.snapshot();
assert.ok(layout.data.surfaces.length > 0);
const directory = 'runs/normal-gate-' + new Date().toISOString().replaceAll(':', '-'); mkdirSync(directory, { recursive: true });
const result = { passed: true, fixtureMode: false, names, fixtureRejected: true, patches: status.data.patches, meta: status.meta, roots: Object.keys(roots.data), surfaces: layout.data.surfaces.map((s: any) => s.type) };
writeFileSync(directory + '/results.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify({ directory, ...result }, null, 2));
