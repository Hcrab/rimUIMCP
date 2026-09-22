import { randomUUID } from 'node:crypto';
import type { Bridge } from './bridge.ts';
export type Request = { method: string; args?: Record<string, any>; requestId?: string; scriptId?: string; sequenceToken?: string; timeoutMs?: number };
export async function dispatch(bridge: Bridge, request: Request) {
  if (typeof request.method !== 'string') throw new Error('method must be a string');
  const parameters = { method: request.method, args: request.args ?? {}, requestId: request.requestId ?? randomUUID(),
    scriptId: request.scriptId, sequenceToken: request.sequenceToken, timeoutMs: Math.max(100, Math.min(1800000, request.timeoutMs ?? 30000)) };
  return bridge.tool('rimuimcp/call', parameters, parameters.timeoutMs + 5000);
}
