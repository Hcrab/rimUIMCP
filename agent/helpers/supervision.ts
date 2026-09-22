import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { connect, Game, type ObservationMeta, type Result } from '../../packages/sdk/src/index.ts';
import { readAllPawns, type CompletePawnRead } from './pawns.ts';

export type SupervisionRole = 'operator' | 'director';
export type SupervisionOwner = 'director' | 'operator' | 'handoff';

/** Reasons that a runAndWatch caller can persist when handing the GUI back. */
export type SupervisionHandoffReason =
  | 'hostile'
  | 'colonist-downed'
  | 'dead'
  | 'mental'
  | 'new-letter'
  | (string & {});

export type SupervisionControl = {
  runId: string;
  owner: SupervisionOwner;
  sessionId: string | null;
  ordersPath: string;
  revision: number;
  operatorAgentId: string;
  phaseStartedAt: string;
  researchDueAt: string | null;
  [key: string]: unknown;
};

export type SupervisionNotification = Record<string, unknown>;

export type SupervisionThreatEvidence = {
  kind: 'major-threat';
  hostiles: Record<string, unknown>[];
  majorThreatNotifications: SupervisionNotification[];
  pawnObservation: CompletePawnRead;
  notifications: SupervisionNotification[];
};

type CallOptions = { timeoutMs?: number; requestId?: string; sequenceToken?: string };
type GameCall = <T = unknown>(method: string, args?: Record<string, unknown>, options?: CallOptions) => Promise<Result<T>>;
type RawCall = GameCall;

const NOTIFICATION_FIELDS = ['ID', 'def.defName', 'def.pauseMode'];
const SAFE_READ_METHODS = new Set([
  'session.status',
  'ui.snapshot',
  'ui.read',
  'ui.resolve',
  'ui.screenshot',
  'events.poll',
  'agent.pending',
  'agent.status',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new SupervisionControlError(message);
}

function requireControlPath(controlPath: string): string {
  if (typeof controlPath !== 'string' || controlPath.trim().length === 0)
    throw new SupervisionControlError('A non-empty supervision control path is required.');
  return path.resolve(controlPath);
}

function textField(value: unknown, field: string, controlPath: string): string {
  if (typeof value !== 'string' || value.trim().length === 0)
    fail(`Invalid supervision control at ${controlPath}: ${field} must be non-empty text.`);
  return value;
}

function readControl(controlPath: string): SupervisionControl {
  const file = requireControlPath(controlPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SupervisionControlError(`Cannot read supervision control ${file}: ${detail}`, file);
  }
  if (!isRecord(parsed)) throw new SupervisionControlError(`Invalid supervision control at ${file}: expected a JSON object.`, file);

  const control = parsed as Record<string, unknown>;
  const runId = textField(control.runId, 'runId', file);
  const owner = control.owner;
  if (owner !== 'director' && owner !== 'operator' && owner !== 'handoff')
    fail(`Invalid supervision control at ${file}: owner must be director, operator, or handoff.`);
  const sessionId = control.sessionId;
  if (sessionId !== null && (typeof sessionId !== 'string' || sessionId.trim().length === 0))
    fail(`Invalid supervision control at ${file}: sessionId must be a string or null.`);
  if (!Number.isInteger(control.revision) || Number(control.revision) < 0)
    fail(`Invalid supervision control at ${file}: revision must be a non-negative integer.`);
  const ordersPath = textField(control.ordersPath, 'ordersPath', file);
  const operatorAgentId = textField(control.operatorAgentId, 'operatorAgentId', file);
  const phaseStartedAt = textField(control.phaseStartedAt, 'phaseStartedAt', file);
  const researchDueAt = control.researchDueAt;
  if (researchDueAt !== null && (typeof researchDueAt !== 'string' || researchDueAt.trim().length === 0))
    fail(`Invalid supervision control at ${file}: researchDueAt must be text or null.`);

  return {
    ...control,
    runId,
    owner,
    sessionId: sessionId as string | null,
    ordersPath,
    revision: Number(control.revision),
    operatorAgentId,
    phaseStartedAt,
    researchDueAt: researchDueAt as string | null,
  };
}

function atomicWriteControl(controlPath: string, control: SupervisionControl): void {
  const file = requireControlPath(controlPath);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(control, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, file);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* The rename may already have consumed it. */ }
    const detail = error instanceof Error ? error.message : String(error);
    throw new SupervisionControlError(`Cannot atomically update supervision control ${file}: ${detail}`, file);
  }
}

/** Move ownership to handoff while retaining every existing and unknown field. */
export function latchHandoff(controlPath: string, reason: SupervisionHandoffReason, evidence?: unknown): SupervisionControl {
  if (typeof reason !== 'string' || reason.trim().length === 0)
    throw new SupervisionControlError('A non-empty handoff reason is required.');
  const control = readControl(controlPath);
  const updated: SupervisionControl = {
    ...control,
    owner: 'handoff',
    revision: control.revision + 1,
    handoffReason: reason,
    handoffAt: new Date().toISOString(),
  };
  if (evidence !== undefined) updated.handoffEvidence = evidence;
  atomicWriteControl(controlPath, updated);
  return updated;
}

export class SupervisionControlError extends Error {
  readonly code = 'SUPERVISION_CONTROL';
  readonly controlPath?: string;

  constructor(message: string, controlPath?: string) {
    super(message);
    this.name = 'SupervisionControlError';
    this.controlPath = controlPath;
  }
}

export class SupervisionObservationError extends Error {
  readonly code = 'SUPERVISION_OBSERVATION';

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'SupervisionObservationError';
    if (cause !== undefined) this.cause = cause;
  }
}

export class SupervisionThreatError extends Error {
  readonly code = 'SUPERVISION_THREAT';
  readonly reason = 'hostile' as const;
  readonly evidence: SupervisionThreatEvidence;
  readonly pauseError?: unknown;
  readonly latchError?: unknown;

  constructor(evidence: SupervisionThreatEvidence, pauseError?: unknown, latchError?: unknown) {
    super(`Operator resume blocked: ${evidence.hostiles.length} live hostile pawn(s) require inspection.`);
    this.name = 'SupervisionThreatError';
    this.evidence = evidence;
    this.pauseError = pauseError;
    this.latchError = latchError;
  }
}

function sessionIdFrom(result: Result<unknown>): string | undefined {
  const meta = isRecord(result.meta) ? result.meta : undefined;
  const data = isRecord(result.data) ? result.data : undefined;
  const candidate = meta?.sessionId ?? data?.sessionId;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

async function assertOperatorLease(rawCall: RawCall, controlPath: string): Promise<SupervisionControl> {
  const control = readControl(controlPath);
  if (control.owner !== 'operator')
    throw new SupervisionControlError(`Operator mutation denied: supervision owner is '${control.owner}'.`, requireControlPath(controlPath));
  if (control.sessionId === null)
    throw new SupervisionControlError('Operator mutation denied: supervision sessionId is null while the run is prelanding.', requireControlPath(controlPath));

  let status: Result<unknown>;
  try {
    status = await rawCall('session.status', {});
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SupervisionControlError(`Operator mutation denied: cannot verify the current game session (${detail}).`, requireControlPath(controlPath));
  }
  const currentSessionId = sessionIdFrom(status);
  if (!currentSessionId)
    throw new SupervisionControlError('Operator mutation denied: session.status returned no sessionId.', requireControlPath(controlPath));
  if (currentSessionId !== control.sessionId)
    throw new SupervisionControlError(`Operator mutation denied: control session '${control.sessionId}' does not match current session '${currentSessionId}'.`, requireControlPath(controlPath));
  return control;
}

function sameBoundary(left: ObservationMeta | undefined, right: ObservationMeta | undefined): boolean {
  if (!left || !right) return true;
  return left.sessionId === right.sessionId && left.worldEpoch === right.worldEpoch && left.gameTick === right.gameTick;
}

function nestedText(value: unknown, ...parts: string[]): string | undefined {
  let current: unknown = value;
  for (const part of parts) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return typeof current === 'string' ? current : undefined;
}

function fieldText(value: Record<string, unknown>, name: string, nested: string[]): string | undefined {
  const direct = value[name];
  if (typeof direct === 'string') return direct;
  return nestedText(value, ...nested);
}

function isReference(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.id === 'string' && typeof value.type === 'string';
}

function isMajorThreat(notification: SupervisionNotification): boolean {
  const pauseMode = fieldText(notification, 'def.pauseMode', ['def', 'pauseMode']);
  const defName = fieldText(notification, 'def.defName', ['def', 'defName']);
  return pauseMode === 'MajorThreat' || defName === 'ThreatBig';
}

async function queryNotificationPages(rawCall: RawCall, reference: Record<string, unknown>, firstMeta?: ObservationMeta): Promise<SupervisionNotification[]> {
  const records: SupervisionNotification[] = [];
  let cursor = 0;
  let expectedTotal: number | undefined;
  for (let page = 0; page < 100; page += 1) {
    let result: Result<unknown>;
    try {
      result = await rawCall('state.query', {
        ref: reference,
        derived: false,
        fields: NOTIFICATION_FIELDS,
        cursor,
        limit: 1000,
        budgetMs: 500,
      });
    } catch (error) {
      throw new SupervisionObservationError('Could not inspect the current notification list.', error);
    }
    if (!sameBoundary(firstMeta, result.meta)) throw new SupervisionObservationError('Notification observation changed session, world, or tick while paging.');
    if (!isRecord(result.data) || !Array.isArray(result.data.items)) throw new SupervisionObservationError('state.query returned no notification items array.');
    const data = result.data;
    const total = data.total;
    if (total !== undefined && (!Number.isInteger(total) || Number(total) < 0)) throw new SupervisionObservationError('state.query returned an invalid notification total.');
    if (total !== undefined) {
      if (expectedTotal !== undefined && Number(total) !== expectedTotal) throw new SupervisionObservationError('Notification total changed while paging.');
      expectedTotal = Number(total);
    }
    const items = data.items as unknown[];
    for (const item of items) {
      if (!isRecord(item)) throw new SupervisionObservationError('state.query returned a malformed notification record.');
      records.push(item);
    }
    const nextCursor = data.nextCursor;
    if (nextCursor === null || nextCursor === undefined) {
      if (expectedTotal !== undefined && records.length !== expectedTotal) throw new SupervisionObservationError(`Notification count mismatch: received ${records.length}, expected ${expectedTotal}.`);
      return records;
    }
    if (!Number.isInteger(nextCursor) || Number(nextCursor) <= cursor) throw new SupervisionObservationError('Notification cursor did not advance.');
    cursor = Number(nextCursor);
  }
  throw new SupervisionObservationError('Notification paging exceeded its safety budget.');
}

async function readNotifications(rawCall: RawCall): Promise<{ items: SupervisionNotification[]; meta?: ObservationMeta }> {
  let result: Result<unknown>;
  try {
    result = await rawCall('state.notifications', {});
  } catch (error) {
    throw new SupervisionObservationError('Could not inspect the current notification list.', error);
  }
  const data = result.data;
  if (Array.isArray(data)) {
    if (data.some(item => !isRecord(item))) throw new SupervisionObservationError('state.notifications returned malformed item records.');
    return { items: data as SupervisionNotification[], meta: result.meta };
  }
  if (!isRecord(data)) throw new SupervisionObservationError('state.notifications returned malformed data.');
  if (!Array.isArray(data.items)) throw new SupervisionObservationError('state.notifications returned no items array.');
  const inlineItems = data.items.filter(isRecord);
  if (inlineItems.length !== data.items.length) throw new SupervisionObservationError('state.notifications returned malformed item records.');

  const reference = data.reference;
  const hasNotificationDetails = (item: Record<string, unknown>) =>
    Object.hasOwn(item, 'def.pauseMode') || Object.hasOwn(item, 'def.defName') || isRecord(item.def);
  if (isReference(reference) && (inlineItems.length === 0 || inlineItems.every(item => isReference(item) && !hasNotificationDetails(item)))) {
    return { items: await queryNotificationPages(rawCall, reference, result.meta), meta: result.meta };
  }
  if (inlineItems.every(item => !isReference(item) || hasNotificationDetails(item)))
    return { items: inlineItems, meta: result.meta };

  const detailed: SupervisionNotification[] = [];
  for (const referenceItem of inlineItems) {
    if (!isReference(referenceItem)) throw new SupervisionObservationError('state.notifications returned an unresolved notification record.');
    let read: Result<unknown>;
    try {
      read = await rawCall('state.read', { ref: referenceItem, fields: NOTIFICATION_FIELDS });
    } catch (error) {
      throw new SupervisionObservationError('Could not read a notification reference.', error);
    }
    const readData = isRecord(read.data) ? read.data : undefined;
    const fields = readData && isRecord(readData.fields) ? readData.fields : undefined;
    if (!fields) throw new SupervisionObservationError('state.read returned no notification fields.');
    detailed.push(fields);
  }
  return { items: detailed, meta: result.meta };
}

function liveHostilePawns(observation: CompletePawnRead): Record<string, unknown>[] {
  return observation.data.items
    .filter(pawn => isRecord(pawn) && pawn.spawned === true && pawn.hostile === true && pawn.dead !== true)
    .map(pawn => pawn as unknown as Record<string, unknown>);
}

async function inspectBeforeResume(rawCall: RawCall): Promise<SupervisionThreatEvidence> {
  let pawnObservation: CompletePawnRead;
  try {
    const readGame = { state: { pawns: (args: Record<string, unknown> = {}) => rawCall('state.pawns', args) } } as Pick<Game, 'state'>;
    pawnObservation = await readAllPawns(readGame, {
      colonistsOnly: false,
      pauseForConsistency: () => rawCall('runtime.pause', { paused: true }),
    });
  } catch (error) {
    if (error instanceof SupervisionObservationError) throw error;
    throw new SupervisionObservationError('Could not inspect all pawns before resuming.', error);
  }
  const notificationObservation = await readNotifications(rawCall);
  const notifications = notificationObservation.items;
  return {
    kind: 'major-threat',
    hostiles: liveHostilePawns(pawnObservation),
    majorThreatNotifications: notifications.filter(isMajorThreat),
    pawnObservation,
    notifications,
  };
}

async function rawPause(rawCall: RawCall): Promise<unknown> {
  return rawCall('runtime.pause', { paused: true });
}

async function blockThreat(rawCall: RawCall, controlPath: string, evidence: SupervisionThreatEvidence): Promise<never> {
  let pauseError: unknown;
  try {
    await rawPause(rawCall);
  } catch (error) {
    pauseError = error;
  }
  let latchError: unknown;
  try {
    latchHandoff(controlPath, 'hostile', evidence);
  } catch (error) {
    latchError = error;
  }
  throw new SupervisionThreatError(evidence, pauseError, latchError);
}

function isPauseTrue(args: Record<string, unknown>): boolean {
  return !Object.hasOwn(args, 'paused') || args.paused === true;
}

function isSafeRead(method: string): boolean {
  return method.startsWith('state.') || SAFE_READ_METHODS.has(method);
}

function needsThreatScan(method: string, args: Record<string, unknown>): boolean {
  if (method === 'runtime.pause') return args.paused === false;
  if (method === 'runtime.speed') return typeof args.speed === 'number' && Number.isFinite(args.speed) && args.speed > 0;
  return method === 'runtime.advance' || method === 'runtime.runUntil' || method === 'runtime.nextFrame';
}

function isCleanup(method: string, args: Record<string, unknown>): boolean {
  if (method === 'session.cancel' || method === 'session.sequence.end') return true;
  if (method === 'runtime.pause' && isPauseTrue(args)) return true;
  if (method === 'runtime.speed' && args.speed === 0) return true;
  return false;
}

/**
 * Install the operator guard on an already connected SDK Game. Kept separate
 * from connectSupervised so offline tests can exercise the exact call path.
 */
export function guardSupervisedGame<T extends Game>(game: T, controlPath: string, role: SupervisionRole = 'operator'): T {
  const file = requireControlPath(controlPath);
  if (role !== 'operator' && role !== 'director') throw new SupervisionControlError(`Unknown supervision role '${String(role)}'.`, file);
  if (role === 'director') return game;

  const rawCall = game.call.bind(game) as RawCall;
  const guardedCall = async <TResult = unknown>(method: string, suppliedArgs: Record<string, unknown> = {}, options: CallOptions = {}): Promise<Result<TResult>> => {
    const args = suppliedArgs ?? {};
    if (isSafeRead(method) || isCleanup(method, args)) return rawCall<TResult>(method, args, options);

    await assertOperatorLease(rawCall, file);
    if (needsThreatScan(method, args)) {
      let evidence: SupervisionThreatEvidence;
      try {
        evidence = await inspectBeforeResume(rawCall);
      } catch (error) {
        try { await rawPause(rawCall); } catch { /* Preserve the observation error for the caller. */ }
        throw error;
      }
      if (evidence.hostiles.length > 0) await blockThreat(rawCall, file, evidence);
    }
    // Re-read ownership immediately before handing the request to the SDK.
    await assertOperatorLease(rawCall, file);
    return rawCall<TResult>(method, args, options);
  };
  game.call = guardedCall as Game['call'];
  return game;
}

/** Connect through the normal SDK, then guard only the supervised operator. */
export async function connectSupervised(controlPath: string, role: SupervisionRole = 'operator'): Promise<Game> {
  const file = requireControlPath(controlPath);
  if (role !== 'operator' && role !== 'director') throw new SupervisionControlError(`Unknown supervision role '${String(role)}'.`, file);
  const game = await connect();
  return role === 'operator' ? guardSupervisedGame(game, file, role) : game;
}
