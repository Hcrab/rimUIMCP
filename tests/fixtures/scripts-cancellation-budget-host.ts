import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Scripts } from '../../packages/runtime/src/scripts.ts';

const root = mkdtempSync(path.join(os.tmpdir(), 'rimuimcp-cancel-'));
try {
  writeFileSync(path.join(root, 'never-ending.mjs'), "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000); setTimeout(() => process.exit(99), 10000);\n");
  const bridge = { tool: () => Promise.reject(new Error('BRIDGE_DISCONNECTED: session.cancel could not reach the game.')) };
  const scripts = new Scripts(root, path.join(root, 'runtime.json'), bridge as any);
  const started = scripts.run({ path: 'never-ending.mjs', budgetMs: 1000 });
  let status = started;
  for (let attempt = 0; attempt < 80; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    status = scripts.status(started.id);
    if (status.ended) break;
  }
  assert.equal(status.status, 'budget-exceeded');
  assert.equal(status.reason, 'budget-exceeded');
  assert.ok(status.ended, 'budget cancellation did not stop the child process');
  assert.ok(status.cleanupErrors?.some((error: any) => error.stage === 'session-cancel' && error.message.includes('BRIDGE_DISCONNECTED')));
  const saved = JSON.parse(readFileSync(path.join(status.directory, 'status.json'), 'utf8'));
  assert.equal(saved.status, 'budget-exceeded');
  assert.equal(saved.reason, 'budget-exceeded');
  assert.ok(saved.cleanupErrors.some((error: any) => error.stage === 'session-cancel'));
  await new Promise(resolve => setTimeout(resolve, 25));
  console.log(JSON.stringify({ hostAlive: true, status: saved.status, ended: Boolean(saved.ended), cleanupErrors: saved.cleanupErrors }));
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}
