import http from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Bridge } from './bridge.ts';
import { dispatch } from './actions.ts';
import type { Request } from './actions.ts';
import { Scripts } from './scripts.ts';
import { AgentMailbox } from './agent.ts';

const root = process.env.RIMUIMCP_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url));
const configPath = path.join(root, 'work', 'runtime.json');
const bridgePath = path.join(root, 'work', 'connection.json');
const bridge = new Bridge(JSON.parse(readFileSync(bridgePath, 'utf8')));
const token = randomBytes(24).toString('hex');
const scripts = new Scripts(root, configPath, bridge);
const agent = new AgentMailbox(root, scripts);
const server = http.createServer(async (request, response) => {
  response.setHeader('content-type', 'application/json; charset=utf-8');
  const send = (status: number, value: unknown) => { response.writeHead(status); response.end(JSON.stringify(value)); };
  if (request.url === '/health' && request.method === 'GET') { send(200, { ready: bridge.ready, pid: process.pid }); return; }
  if (request.headers.authorization !== 'Bearer ' + token) { send(401, { success: false, error: { code: 'UNAUTHORIZED', message: 'Missing runtime token.' } }); return; }
  if (request.url !== '/call' || request.method !== 'POST') { send(404, { success: false }); return; }
  let call: Request | undefined;
  try {
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of request) { length += chunk.length; if (length > 4 * 1024 * 1024) throw new Error('Request exceeds 4 MiB'); chunks.push(chunk); }
    call = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!call) throw new Error('Missing request');
    if (!bridge.ready) bridge.config = JSON.parse(readFileSync(bridgePath, 'utf8'));
    if (call.method.startsWith('agent.')) {
      send(200, { success: true, requestId: call.requestId, meta: null, data: agent.invoke(call) });
    } else if (call.method.startsWith('scripts.')) {
      const args = call.args ?? {};
      const data = call.method === 'scripts.run' ? scripts.run(args) : call.method === 'scripts.status' ? scripts.status(args.id) : call.method === 'scripts.cancel' ? await scripts.cancel(args.id) : (() => { throw new Error('Unknown script method'); })();
      send(200, { success: true, requestId: call.requestId, meta: null, data });
    } else {
      const result = await dispatch(bridge, call);
      if (call.method === 'session.status' && result.success) result.data.runtimeCapabilities = ['scripts.run', 'scripts.status', 'scripts.cancel', 'agent.request', 'agent.pending', 'agent.status', 'agent.respond'];
      send(200, result);
    }
  } catch (error: any) { send(502, { success: false, requestId: call?.requestId, error: { code: error.code ?? 'TRANSPORT_ERROR', message: error.message, outcomeMayHaveChanged: true } }); }
});
server.listen(Number(process.env.RIMUIMCP_PORT ?? 18741), '127.0.0.1', () => {
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Unexpected HTTP address');
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ url: `http://127.0.0.1:${address.port}`, token, pid: process.pid, started: new Date().toISOString() }, null, 2));
  console.log(`rimUIMCP runtime ready on 127.0.0.1:${address.port}`);
});
process.on('SIGTERM', () => { bridge.close(); server.close(); });
