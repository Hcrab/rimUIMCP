import { randomUUID } from 'node:crypto';
import type { Bridge } from './bridge.ts';
export type Request = { method: string; args?: Record<string, any>; requestId?: string; scriptId?: string; sequenceToken?: string; timeoutMs?: number };
/**
 * Normalizes request defaults and applies a bounded method timeout before forwarding the payload
 * to the GABP rimuimcp/call tool. An extra transport allowance is added to the timeout to allow
 * time for a game-side timeout result to arrive. Policy and gameplay logic are deferred to their
 * respective layers.
 */
export async function dispatch(bridge: Bridge, request: Request) {
  if (typeof request.method !== 'string') throw new Error('method must be a string');
  const parameters = { method: request.method, args: request.args ?? {}, requestId: request.requestId ?? randomUUID(),
    scriptId: request.scriptId, sequenceToken: request.sequenceToken, timeoutMs: Math.max(100, Math.min(1800000, request.timeoutMs ?? 30000)) };
  return bridge.tool('rimuimcp/call', parameters, parameters.timeoutMs + 5000);
}
