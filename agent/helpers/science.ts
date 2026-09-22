import type { Game, ObjectRef } from '../../packages/sdk/src/index.ts';
import { readAllPawns } from './pawns.ts';
import { prioritize } from './pawn.ts';
import { runAndWatch } from './flow.ts';

type Worker = {
  id: string; spawned?: boolean; factionIsPlayer?: boolean; humanlike?: boolean;
  dead?: boolean; downed?: boolean; drafted?: boolean; mentalState?: unknown;
  hostile?: boolean; job?: string; needs?: { food: number; rest: number; mood: number };
};

/** Only interrupt research or idle time; eating, sleeping, hauling and medical work keep their turn. */
export function scannerCandidate(pawn: Worker): boolean {
  const needs = pawn.needs;
  return !!(pawn.spawned && pawn.factionIsPlayer && pawn.humanlike &&
    !pawn.dead && !pawn.downed && !pawn.drafted && !pawn.mentalState && needs &&
    needs.food >= .4 && needs.rest >= .4 && needs.mood >= .25 &&
    ['Research', 'Wait', 'Wait_MaintainPosture', 'GotoWander'].includes(pawn.job ?? ''));
}

export type ScannerShiftOptions = {
  scannerId: string; scannerRef: ObjectRef; workerIds: string[]; menuLabel: string;
  ticks: number; deadline: number; sliceTicks?: number; pollMs?: number; signal?: AbortSignal;
  onReport?: (report: Record<string, unknown>) => void | Promise<void>;
};

/** Bounded real-GUI scanner orders. Observe progress separately from job acceptance. */
export async function runScannerShift(game: Game, options: ScannerShiftOptions) {
  if (!Number.isInteger(options.ticks) || options.ticks < 1 || !Number.isFinite(options.deadline))
    throw new Error('Scanner shift requires a positive tick budget and an absolute deadline.');
  const sliceTicks = options.sliceTicks ?? 1500;
  if (!Number.isInteger(sliceTicks) || sliceTicks < 1) throw new Error('Invalid scanner slice.');
  let reason = 'tick-budget', orders = 0, cursor = 0, lastScanTick: number | undefined;
  let lastProgressTick = 0, startTick = 0, endTick = 0;
  try {
    await game.runtime.pause();
    const start = await game.status();
    startTick = endTick = lastProgressTick = start.meta.gameTick;
    if (start.meta.sessionId !== options.scannerRef.sessionId || start.meta.worldEpoch !== options.scannerRef.worldEpoch)
      return { reason: 'world-changed', orders, startTick, endTick };
    cursor = (await game.events.poll()).data.cursor;
    while (endTick - startTick < options.ticks) {
      if (options.signal?.aborted) { reason = 'cancelled'; break; }
      if (Date.now() >= options.deadline) { reason = 'deadline'; break; }
      const observation = await readAllPawns(game, { pauseForConsistency: () => game.runtime.pause() });
      if (observation.meta.sessionId !== start.meta.sessionId || observation.meta.worldEpoch !== start.meta.worldEpoch) {
        reason = 'world-changed'; break;
      }
      endTick = observation.meta.gameTick;
      const pawns = observation.data.items as Worker[];
      if (pawns.some(p => p.spawned && p.hostile && !p.dead && !p.downed)) { reason = 'hostile'; break; }
      const residents = pawns.filter(p => p.factionIsPlayer && p.humanlike);
      if (residents.some(p => p.dead || p.downed || p.mentalState)) { reason = 'colonist-needs-attention'; break; }
      if (options.workerIds.some(id => !residents.some(p => p.id === id))) { reason = 'worker-missing'; break; }
      if (residents.some(p => p.needs && (p.needs.mood < .18 || (p.needs.food < .08 && p.job !== 'Ingest')))) {
        reason = 'needs-attention'; break;
      }
      const events = (await game.events.poll(cursor)).data;
      if (events.gap) { reason = 'event-gap'; break; }
      cursor = events.cursor;
      if (events.events.some((event: { name: string }) => event.name === 'notification.letter')) { reason = 'new-letter'; break; }
      const scan = (await game.state.read(options.scannerRef, {
        fields: ['daysWorkingSinceLastFinding', 'lastScanTick', 'lastUserSpeed', 'targetMineable.defName'],
      })).data.fields;
      if (lastScanTick === undefined || scan.lastScanTick !== lastScanTick) lastProgressTick = endTick;
      lastScanTick = scan.lastScanTick;
      await options.onReport?.({ tick: endTick, orders, scanner: scan, workers: residents.filter(p => options.workerIds.includes(p.id)) });
      // A long pause in progress is useful evidence: return control for diagnosis, rather than spam orders forever.
      if (endTick - lastProgressTick > 60000) { reason = 'scanner-not-progressing'; break; }
      if (!residents.some(p => p.job === 'OperateScanner')) {
        const worker = options.workerIds.map(id => residents.find(p => p.id === id)).find(p => p && scannerCandidate(p));
        if (worker) {
          if (options.signal?.aborted || Date.now() >= options.deadline) { reason = options.signal?.aborted ? 'cancelled' : 'deadline'; break; }
          await prioritize(game, { pawnId: worker.id, thingId: options.scannerId, menuLabel: options.menuLabel, jobDef: 'OperateScanner' });
          orders++;
        }
      }
      const watched = await runAndWatch(game, {
        ticks: Math.min(sliceTicks, options.ticks - (endTick - startTick)),
        timeoutMs: Math.max(1, Math.min(60000, options.deadline - Date.now())),
        pollMs: options.pollMs ?? 1000, signal: options.signal,
        stopWhen: async current => {
          if (Date.now() >= options.deadline) return 'deadline';
          const people = current.data.items.filter((p: Worker) => p.factionIsPlayer && p.humanlike);
          if (people.some((p: Worker) => p.needs && (p.needs.mood < .18 || (p.needs.food < .08 && p.job !== 'Ingest')))) return 'needs-attention';
        },
      });
      endTick = watched.end.gameTick;
      if (watched.reason !== 'tick-budget') { reason = watched.reason; break; }
    }
    return { reason, orders, startTick, endTick, lastScanTick };
  } finally { await game.runtime.pause(); }
}
