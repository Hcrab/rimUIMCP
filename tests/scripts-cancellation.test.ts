import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Scripts } from '../packages/runtime/src/scripts.ts';

function temporaryRoot() { return mkdtempSync(path.join(os.tmpdir(), 'rimuimcp-scripts-test-')); }
function removeRoot(root: string) { rmSync(root, { recursive: true, force: true, maxRetries: 3 }); }
function bridge(tool: () => Promise<unknown> = async () => ({})) { return { tool } as any; }
async function waitForEnd(scripts: Scripts, id: string) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const status = scripts.status(id);
    if (status.ended) return status;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Script ${id} did not end`);
}

test('budget expiry survives a disconnected bridge in a strict independent Node host', async () => {
  const child = spawn(process.execPath, ['--unhandled-rejections=strict', 'tests/fixtures/scripts-cancellation-budget-host.ts'], {
    cwd: path.resolve('.'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  const [code] = await once(child, 'close') as [number | null];
  assert.equal(code, 0, stderr);
  const result = JSON.parse(stdout.trim());
  assert.equal(result.hostAlive, true);
  assert.equal(result.status, 'budget-exceeded');
  assert.equal(result.ended, true);
  assert.ok(result.cleanupErrors.some((error: any) => error.stage === 'session-cancel'));
});

test('normal completion remains succeeded and persists its terminal state', async () => {
  const root = temporaryRoot();
  try {
    writeFileSync(path.join(root, 'done.mjs'), "console.log('done');\n");
    const scripts = new Scripts(root, path.join(root, 'runtime.json'), bridge());
    const started = scripts.run({ path: 'done.mjs', budgetMs: 1000 });
    const status = await waitForEnd(scripts, started.id);
    assert.equal(status.status, 'succeeded');
    assert.equal(JSON.parse(readFileSync(path.join(status.directory, 'status.json'), 'utf8')).status, 'succeeded');
  } finally { removeRoot(root); }
});

test('repeated cancellation is idempotent and a close race preserves cancellation', async () => {
  const root = temporaryRoot();
  try {
    writeFileSync(path.join(root, 'wait-for-signal.mjs'), "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000); setTimeout(() => process.exit(99), 10000);\n");
    let cancellationCalls = 0;
    const scripts = new Scripts(root, path.join(root, 'runtime.json'), bridge(async () => { cancellationCalls++; return {}; }));
    const started = scripts.run({ path: 'wait-for-signal.mjs', budgetMs: 60000 });
    const [first, second] = await Promise.all([scripts.cancel(started.id), scripts.cancel(started.id)]);
    const status = await waitForEnd(scripts, started.id);
    assert.equal(cancellationCalls, 1);
    assert.equal(first.status, 'cancelled');
    assert.equal(second.status, 'cancelled');
    assert.equal(status.status, 'cancelled');
    assert.equal(status.reason, 'cancelled');
    assert.ok(status.ended, 'the local child process should be closed after cancellation');
  } finally { removeRoot(root); }
});

test('unknown script cancellation still reports a clear error', async () => {
  const root = temporaryRoot();
  try {
    const scripts = new Scripts(root, path.join(root, 'runtime.json'), bridge());
    await assert.rejects(scripts.cancel('missing'), /Unknown script ID/);
  } finally { removeRoot(root); }
});
