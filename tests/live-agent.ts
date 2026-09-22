import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect, RimError } from '../packages/sdk/src/index.ts';
const game = await connect();
const directory = 'runs/agent-acceptance-' + new Date().toISOString().replaceAll(':', '-'); mkdirSync(directory, { recursive: true });
const run = (await game.scripts.run('tests/fixtures/ask-agent.ts', { budgetMs: 90000 })).data;
let request: any;
for (let i = 0; i < 100; i++) {
  request = (await game.agent.pending()).data.items.find((q: any) => q.scriptId === run.id);
  if (request) break; await new Promise(r => setTimeout(r, 100));
}
assert.ok(request); assert.equal((await game.scripts.status(run.id)).data.status, 'waiting-for-agent');
assert.equal((await game.status()).data.ui.occupied, false);
await game.ui.panel('schedule').open(); // Another client has the GUI while the program asks the AI.
const answer = { priority: (request.context.original + 2) % 5 };
await game.agent.respond(request.id, answer); await game.agent.respond(request.id, answer);
await assert.rejects(game.agent.respond(request.id, { priority: 99 }), e => e instanceof RimError && e.code === 'REQUEST_ID_CONFLICT');
let status: any;
for (let i = 0; i < 100; i++) { status = (await game.scripts.status(run.id)).data; if (status.ended) break; await new Promise(r => setTimeout(r, 100)); }
assert.equal(status.status, 'succeeded', status.directory);
assert.ok(status.sourceSha256); const output = readFileSync(status.directory + '/stdout.log', 'utf8');
assert.ok(output.includes('Doctor')); assert.equal((await game.status()).data.ui.occupied, false);
const evidence = { passed: true, request, answer, status, output };
writeFileSync(directory + '/results.json', JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence, null, 2));
