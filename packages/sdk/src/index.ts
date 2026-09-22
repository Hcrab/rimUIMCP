import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Locator } from './locators.ts';
import type { Selector } from './locators.ts';
export { Locator }; export type { Selector };

export type ObjectRef = { id: string; sessionId: string; worldEpoch: number; type: string };
export type ObservationMeta = { sessionId: string; worldEpoch: number; mapId: string | null; gameTick: number; uiFrame: number; snapshotId: string };
export type Result<T = any> = { success: true; requestId: string; meta: ObservationMeta; data: T; started?: ObservationMeta; ended?: ObservationMeta };
export type ActionResult = { path: 'ui-control' | 'ui-input' | 'runtime' | 'fixture'; inputProcessed: boolean | null; commandAccepted: boolean | null; completion: 'not-checked' | 'pending' | 'succeeded' | 'failed'; evidence?: unknown; [key: string]: unknown };
export type Config = { url: string; token: string; scriptId?: string; timeoutMs?: number };
export class RimError extends Error {
  code: string; result: any;
  constructor(result: any) { super(result.error?.message ?? 'rimUIMCP request failed'); this.name = 'RimError'; this.code = result.error?.code ?? 'TRANSPORT_ERROR'; this.result = result; }
}
export class Game {
  config: Config; scriptId: string;
  private sequenceContext = new AsyncLocalStorage<string>();
  constructor(config: Config) { this.config = config; this.scriptId = config.scriptId ?? process.env.RIMUIMCP_SCRIPT_ID ?? randomUUID(); }
  async call<T = any>(method: string, args: Record<string, unknown> = {}, options: { timeoutMs?: number; requestId?: string; sequenceToken?: string } = {}): Promise<Result<T>> {
    const timeoutMs = options.timeoutMs ?? this.config.timeoutMs ?? 30000;
    const response = await fetch(this.config.url + '/call', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + this.config.token },
      body: JSON.stringify({ method, args, scriptId: this.scriptId, sequenceToken: options.sequenceToken ?? this.sequenceContext.getStore(), requestId: options.requestId ?? randomUUID(), timeoutMs }),
      signal: AbortSignal.timeout(timeoutMs + 10000) });
    const result = await response.json();
    if (!response.ok || !result.success) throw new RimError(result);
    return result;
  }
  state = {
    roots: () => this.call('state.roots'), describe: (ref: ObjectRef) => this.call('state.describe', { ref }),
    read: (ref: ObjectRef | string, options: Record<string, unknown> = {}) => this.call('state.read', { ...(typeof ref === 'string' ? { root: ref } : { ref }), ...options }),
    query: (options: Record<string, unknown>) => this.call('state.query', options),
    pawns: (options: Record<string, unknown> = {}) => this.call('state.pawns', options),
    map: () => this.call('state.map'), research: () => this.call('state.research'), bills: () => this.call('state.bills'), notifications: () => this.call('state.notifications'),
    world: (options: { cursor?: number; limit?: number; originTileId?: number; layerId?: number } = {}) => this.call('state.world', options),
    worldTile: (tileId: number, layerId = 0) => this.call('state.worldTile', { tileId, layerId }),
  };
  ui = {
    snapshot: (options: { surface?: string } = {}) => this.call('ui.snapshot', options),
    locator: (selector: Selector) => new Locator(this, selector),
    action: (actionId: string) => new Locator(this, { actionId }),
    panel: (name: string) => ({ open: () => this.call('ui.panel', { name }) }),
    input: (args: Record<string, unknown>) => this.call<ActionResult>('ui.input', args),
    press: (key: string, modifiers?: string) => this.call<ActionResult>('ui.input', { action: 'press', key, modifiers }),
    screenshot: (name?: string) => this.call('ui.screenshot', { name }),
  };
  pawn(id: string) { return { id, select: () => this.call('ui.select', { pawnId: id }), reveal: () => this.call('ui.reveal', { pawnId: id }) }; }
  thing(id: string) { return { id, select: () => this.call('ui.select', { thingId: id }), reveal: () => this.call('ui.reveal', { thingId: id }) }; }
  map = { click: (x: number, z: number, options = {}) => this.call<ActionResult>('map.click', { x, z, ...options }), drag: (x: number, z: number, endX: number, endZ: number, options = {}) => this.call<ActionResult>('map.drag', { x, z, endX, endZ, ...options }) };
  world = {
    reveal: (tileId: number, layerId = 0) => this.call<ActionResult>('world.reveal', { tileId, layerId }),
    click: (tileId: number, options: { layerId?: number; button?: 'left' | 'right'; modifiers?: string } = {}) => this.call<ActionResult>('world.click', { tileId, ...options }),
  };
  runtime = {
    pause: (paused = true) => this.call('runtime.pause', { paused }), speed: (speed: number) => this.call('runtime.speed', { speed }),
    nextFrame: (frames = 1) => this.call('runtime.nextFrame', { frames }),
    advance: (options: number | { ticks: number; timeoutMs?: number }) => this.call('runtime.advance', typeof options === 'number' ? { ticks: options } : options, typeof options === 'number' ? {} : options),
    runUntil: (options: Record<string, unknown>) => this.call('runtime.runUntil', options, { timeoutMs: Number(options.timeoutMs ?? 30000) }),
    save: (name: string) => this.call('runtime.save', { name }), load: (name: string) => this.call('runtime.load', { name }, { timeoutMs: 120000 }),
  };
  events = { poll: (cursor = 0) => this.call('events.poll', { cursor }) };
  scripts = { run: (path: string, options: Record<string, unknown> = {}) => this.call('scripts.run', { path, ...options }), status: (id: string) => this.call('scripts.status', { id }), cancel: (id: string) => this.call('scripts.cancel', { id }) };
  agent = {
    request: (question: string, context: unknown = null) => this.call('agent.request', { question, context }),
    pending: () => this.call('agent.pending'), status: (id: string) => this.call('agent.status', { id }),
    respond: (id: string, answer: unknown) => this.call('agent.respond', { id, answer }),
    ask: async (question: string, context: unknown = null, options: { timeoutMs?: number } = {}) => {
      const request = await this.call('agent.request', { question, context });
      const deadline = Date.now() + (options.timeoutMs ?? 30 * 60000);
      while (Date.now() < deadline) {
        const record = (await this.call('agent.status', { id: request.data.id })).data;
        if (record.status === 'answered') return record.answer;
        if (record.status === 'cancelled') throw new RimError({ error: { code: 'CANCELLED', message: 'Agent request cancelled.' } });
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      throw new RimError({ error: { code: 'TIMEOUT', message: 'AI response deadline exceeded; the request remains in agent.pending.' } });
    },
  };
  status() { return this.call('session.status'); }
  cancel(scriptId = this.scriptId) { return this.call('session.cancel', { scriptId }); }
  async sequence<T>(fn: (game: Game) => Promise<T>): Promise<T> {
    if (this.sequenceContext.getStore()) return fn(this);
    const result = await this.call<{ token: string }>('session.sequence.begin');
    return this.sequenceContext.run(result.data.token, async () => {
      try { return await fn(this); }
      finally { await this.call('session.sequence.end', { token: result.data.token }); }
    });
  }
}
export async function connect(config?: Config | string) {
  const resolved = typeof config === 'object' ? config : JSON.parse(readFileSync(config ?? process.env.RIMUIMCP_CONFIG ?? new URL('../../../work/runtime.json', import.meta.url), 'utf8'));
  const game = new Game(resolved); await game.status(); return game;
}
