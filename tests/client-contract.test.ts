import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { Bridge } from '../packages/runtime/src/bridge.ts';
import { Game, RimError } from '../packages/sdk/src/index.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('GABP preserves fragmented UTF-8 frames and rejects pending work after disconnect', async () => {
  const server = net.createServer(socket => {
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const boundary = buffer.indexOf('\r\n\r\n'); if (boundary < 0) return;
        const length = Number(/Content-Length: (\d+)/.exec(buffer.toString('ascii', 0, boundary))?.[1]);
        if (buffer.length < boundary + 4 + length) return;
        const request = JSON.parse(buffer.subarray(boundary + 4, boundary + 4 + length).toString());
        buffer = buffer.subarray(boundary + 4 + length);
        if (request.method === 'disconnect') { socket.destroy(); return; }
        const body = Buffer.from(JSON.stringify({ v: 'gabp/1', type: 'response', id: request.id, result: request.method === 'session/hello' ? { agentId: 'fixture' } : { text: '雷霆⚡', args: request.params } }));
        const frame = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
        // One-byte writes can split a four-byte UTF-8 code point and every header delimiter.
        for (let index = 0; index < frame.length; index++) socket.write(frame.subarray(index, index + 1));
      }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address() as net.AddressInfo;
  const bridge = new Bridge({ host: '127.0.0.1', port: address.port, token: 'test-only' });
  try {
    await bridge.connect();
    assert.deepEqual(await bridge.request('echo', { empty: '', zero: 0, flag: false }), { text: '雷霆⚡', args: { empty: '', zero: 0, flag: false } });
    await assert.rejects(bridge.request('disconnect'), /DISCONNECTED/);
    assert.equal(bridge.ready, false);
  } finally { bridge.close(); server.close(); }
});

test('SDK, CLI, Python and official MCP transport preserve the common result and errors', async () => {
  const seen: any[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const call = JSON.parse(raw); seen.push(call);
    const meta = { sessionId: 'test', worldEpoch: 9, mapId: 'Map_1', gameTick: 123, uiFrame: 45, snapshotId: 'snapshot' };
    const result = call.method === 'failure' ? { success: false, requestId: call.requestId, meta, error: { code: 'STALE_UI_REFERENCE', message: 'expired' } }
      : { success: true, requestId: call.requestId, meta, data: call.method === 'session.sequence.begin' ? { token: 'sequence' } : call.args };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address() as net.AddressInfo;
  const directory = mkdtempSync(path.join(tmpdir(), 'rimplay-test-'));
  const config = { url: `http://127.0.0.1:${address.port}`, token: 'test-only' };
  const configPath = path.join(directory, 'runtime.json'); writeFileSync(configPath, JSON.stringify(config));
  const args = { text: '医生⚡', empty: '', zero: 0, enabled: false };
  const child = async (exe: string, argv: string[], env: NodeJS.ProcessEnv = {}) => {
    const process = spawn(exe, argv, { env: { ...globalThis.process.env, ...env, RIMUIMCP_CONFIG: configPath }, windowsHide: true });
    let stdout = '', stderr = ''; process.stdout.on('data', data => stdout += data); process.stderr.on('data', data => stderr += data);
    const [code] = await once(process, 'close'); assert.equal(code, 0, stderr); return JSON.parse(stdout);
  };
  let mcp: Client | undefined;
  try {
    const game = new Game(config);
    const result = await game.call('echo', args); assert.deepEqual(result.data, args); assert.equal(result.meta.gameTick, 123);
    await assert.rejects(game.call('failure'), (error: unknown) => error instanceof RimError && error.code === 'STALE_UI_REFERENCE');
    await game.sequence(async () => { await game.ui.locator({ ownerId: 'Human1', rowKey: 'Doctor' }).click({ button: 'right' }); });
    const input = seen.find(call => call.method === 'ui.input'); assert.equal(input.sequenceToken, 'sequence'); assert.equal(input.args.button, 'right');
    const cli = await child(process.execPath, ['apps/cli/src/main.ts', 'echo', JSON.stringify(args)]); assert.deepEqual(cli.data, args);
    const python = process.env.RIMUIMCP_PYTHON ?? 'C:\\Users\\ping\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe';
    const source = 'import asyncio,json\nfrom rimuimcp import connect\nasync def main():\n g=await connect()\n r=await g.call("echo",json.loads(' + JSON.stringify(JSON.stringify(args)) + '))\n print(json.dumps(r))\nasyncio.run(main())';
    const py = await child(python, ['-c', source], { PYTHONPATH: path.resolve('packages/python') }); assert.deepEqual(py.data, args);
    mcp = new Client({ name: 'contract-test', version: '1' });
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: ['apps/mcp/src/main.ts'], env: { ...process.env as Record<string, string>, RIMUIMCP_CONFIG: configPath } }));
    const answer: any = await mcp.callTool({ name: 'rimuimcp_call', arguments: { method: 'echo', args } });
    assert.deepEqual(JSON.parse(answer.content[0].text).data, args);
    const failure: any = await mcp.callTool({ name: 'rimuimcp_call', arguments: { method: 'failure' } });
    assert.equal(failure.isError, true); assert.equal(JSON.parse(failure.content[0].text).error.code, 'STALE_UI_REFERENCE');
  } finally { await mcp?.close(); server.close(); }
});
