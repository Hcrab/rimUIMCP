import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Game, type Result } from '../packages/sdk/src/index.ts';
import {
  SupervisionControlError,
  SupervisionThreatError,
  guardSupervisedGame,
} from '../agent/helpers/supervision.ts';

const meta = (tick = 40, sessionId = 'session') => ({
  sessionId,
  worldEpoch: 1,
  mapId: 'Map_0',
  gameTick: tick,
  uiFrame: tick,
  snapshotId: `${sessionId}-${tick}`,
});
const response = (data: unknown, observation = meta()) => ({ success: true as const, requestId: 'request', meta: observation, data });

type FixtureOptions = {
  owner?: 'director' | 'operator' | 'handoff';
  sessionId?: string | null;
  pawns?: Record<string, unknown>[];
  notifications?: Record<string, unknown>[];
};

function controlFile(options: FixtureOptions = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'rimplay-supervision-'));
  const file = path.join(root, 'control.json');
  writeFileSync(file, JSON.stringify({
    runId: 'pro05',
    owner: options.owner ?? 'operator',
    sessionId: options.sessionId === undefined ? 'session' : options.sessionId,
    ordersPath: 'orders.json',
    revision: 7,
    operatorAgentId: 'operator',
    phaseStartedAt: '2026-09-13T00:00:00.000Z',
    researchDueAt: null,
    futureField: { retained: true },
  }));
  return { root, file };
}

function fakeGame(options: FixtureOptions = {}) {
  const calls: { method: string; args: Record<string, unknown> }[] = [];
  const pawns = options.pawns ?? [{ id: 'Colonist', spawned: true, hostile: false, dead: false }];
  const notifications = options.notifications ?? [];
  const game = new Game({ url: 'http://127.0.0.1:1', token: 'test', scriptId: 'operator' });
  const baseCall = async <T = unknown>(method: string, args: Record<string, unknown> = {}): Promise<Result<T>> => {
    calls.push({ method, args });
    if (method === 'session.status') return response({ sessionId: 'session' }) as Result<T>;
    if (method === 'state.pawns') {
      const cursor = Number(args.cursor ?? 0), limit = Number(args.limit ?? 100);
      const page = pawns.slice(cursor, cursor + limit);
      const nextCursor = cursor + page.length < pawns.length ? cursor + page.length : null;
      return response({ items: page, total: pawns.length, offset: cursor, limit, nextCursor, truncated: nextCursor !== null }) as Result<T>;
    }
    if (method === 'state.notifications') {
      const refs = notifications.map((_, index) => ({ id: `letter-${index}`, type: 'Verse.StandardLetter' }));
      return response({ reference: { id: 'letters', type: 'System.Collections.Generic.List`1' }, items: refs }) as Result<T>;
    }
    if (method === 'state.query') {
      const cursor = Number(args.cursor ?? 0), limit = Number(args.limit ?? 1000);
      const page = notifications.slice(cursor, cursor + limit);
      const nextCursor = cursor + page.length < notifications.length ? cursor + page.length : null;
      return response({ items: page, total: notifications.length, nextCursor }) as Result<T>;
    }
    return response({ accepted: true }) as Result<T>;
  };
  game.call = baseCall as Game['call'];
  return { game, calls };
}

function methods(calls: { method: string }[], method: string) {
  return calls.filter(call => call.method === method);
}

test('a revoked operator can inspect and pause but cannot mutate the UI', async () => {
  const control = controlFile({ owner: 'director' });
  try {
    const fixture = fakeGame();
    const guarded = guardSupervisedGame(fixture.game, control.file);
    await guarded.state.map();
    await guarded.runtime.pause();
    await assert.rejects(
      guarded.ui.input({ action: 'click', targetId: 'button' }),
      error => error instanceof SupervisionControlError && /owner is 'director'/.test(error.message),
    );
    assert.equal(methods(fixture.calls, 'ui.input').length, 0);
  } finally {
    rmSync(control.root, { recursive: true, force: true });
  }
});

test('an active operator can perform ordinary UI work after the lease check', async () => {
  const control = controlFile();
  try {
    const fixture = fakeGame();
    const guarded = guardSupervisedGame(fixture.game, control.file);
    await guarded.ui.panel('work').open();
    await guarded.ui.input({ action: 'click', targetId: 'button' });
    assert.equal(methods(fixture.calls, 'ui.panel').length, 1);
    assert.equal(methods(fixture.calls, 'ui.input').length, 1);
    assert.equal(JSON.parse(readFileSync(control.file, 'utf8')).owner, 'operator');
  } finally {
    rmSync(control.root, { recursive: true, force: true });
  }
});

test('a hostile at the start is paused raw, latched, persisted, and never resumed', async () => {
  const threatPawns = [
    ...Array.from({ length: 100 }, (_, index) => ({ id: `Pawn${index}`, spawned: true, hostile: false, dead: false })),
    { id: 'Raider', spawned: true, hostile: true, dead: false },
  ];
  const threatNotifications = [{ ID: 12, 'def.defName': 'ThreatBig', 'def.pauseMode': 'MajorThreat' }];
  const control = controlFile({ pawns: threatPawns, notifications: threatNotifications });
  try {
    const fixture = fakeGame({ pawns: threatPawns, notifications: threatNotifications });
    const guarded = guardSupervisedGame(fixture.game, control.file);
    await assert.rejects(
      guarded.runtime.speed(3),
      error => error instanceof SupervisionThreatError && error.reason === 'hostile',
    );
    const saved = JSON.parse(readFileSync(control.file, 'utf8'));
    assert.equal(saved.owner, 'handoff');
    assert.equal(saved.handoffReason, 'hostile');
    assert.equal(saved.handoffEvidence.hostiles[0].id, 'Raider');
    assert.deepEqual(saved.futureField, { retained: true });
    assert.equal(saved.revision, 8);
    assert.equal(methods(fixture.calls, 'runtime.speed').length, 0);
    assert.ok(methods(fixture.calls, 'runtime.pause').length >= 2, 'paging and the threat latch both pause through rawCall');
  } finally {
    rmSync(control.root, { recursive: true, force: true });
  }
});

test('an old non-threat notification does not permanently block a safe resume', async () => {
  const control = controlFile({ notifications: [{ ID: 2, 'def.defName': 'QuestActive', 'def.pauseMode': 'LetterOnly' }] });
  try {
    const fixture = fakeGame({ notifications: [{ ID: 2, 'def.defName': 'QuestActive', 'def.pauseMode': 'LetterOnly' }] });
    const guarded = guardSupervisedGame(fixture.game, control.file);
    await guarded.runtime.speed(3);
    assert.equal(methods(fixture.calls, 'runtime.speed').length, 1);
    assert.equal(JSON.parse(readFileSync(control.file, 'utf8')).owner, 'operator');
  } finally {
    rmSync(control.root, { recursive: true, force: true });
  }
});

test('missing and malformed control state fail closed only for operator mutation', async () => {
  const missingRoot = mkdtempSync(path.join(tmpdir(), 'rimplay-supervision-missing-'));
  const malformedRoot = mkdtempSync(path.join(tmpdir(), 'rimplay-supervision-malformed-'));
  const malformed = path.join(malformedRoot, 'control.json');
  writeFileSync(malformed, JSON.stringify({ owner: 'operator' }));
  try {
    for (const file of [path.join(missingRoot, 'missing.json'), malformed]) {
      const fixture = fakeGame();
      await fixture.game.state.map();
      await fixture.game.runtime.pause();
      const guarded = guardSupervisedGame(fixture.game, file);
      await assert.rejects(
        guarded.ui.input({ action: 'click', targetId: 'button' }),
        error => error instanceof SupervisionControlError && /supervision control/i.test(error.message),
      );
      assert.equal(methods(fixture.calls, 'ui.input').length, 0);
    }
  } finally {
    rmSync(missingRoot, { recursive: true, force: true });
    rmSync(malformedRoot, { recursive: true, force: true });
  }
});
