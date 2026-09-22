import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { connect, RimError } from '../../../packages/sdk/src/index.ts';
const server = new McpServer({ name: 'rimUIMCP', version: '1.0.0' });
let connectedGame: Awaited<ReturnType<typeof connect>> | undefined;
server.registerTool('rimuimcp_call', { description: 'Shared rimUIMCP interface. Start with session.status or state.roots. UI actions target actual visible controls; scripts.run executes a local TS/JS/Python program.',
  inputSchema: { method: z.string(), args: z.record(z.unknown()).optional(), timeoutMs: z.number().optional(), sequenceToken: z.string().optional(), requestId: z.string().optional() } },
  async ({ method, args, timeoutMs, sequenceToken, requestId }) => {
    try { const game = connectedGame ??= await connect(); const result = await game.call(method, args ?? {}, { timeoutMs, sequenceToken, requestId }); return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(error instanceof RimError ? error.result : { error: String(error) }) }] }; }
  });
await server.connect(new StdioServerTransport());
