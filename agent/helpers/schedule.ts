import type {Game} from '../../packages/sdk/src/index.ts';

export type ScheduleAssignment = 'Anything' | 'Work' | 'Joy' | 'Sleep' | 'Meditate';
const assignments = new Set<ScheduleAssignment>(['Anything', 'Work', 'Joy', 'Sleep', 'Meditate']);

/**
 * Reads the complete 24-hour schedule for a given pawn ID, returning the hourly assignments and
 * observation metadata. It throws an error if any hourly assignment is missing. This is useful as
 * before-and-after evidence when verifying schedule changes.
 */
export async function readSchedule(game: Game, pawnId: string) {
  const fields = Array.from({length: 24}, (_, hour) => `timetable.times.${hour}.defName`);
  const observation = await game.state.read('game', {thingId: pawnId, fields, budgetMs: 500});
  const hours = fields.map(field => observation.data.fields[field]);
  if (hours.some(value => typeof value !== 'string')) throw new Error('A complete 24-hour timetable was not observed.');
  return {pawnId, hours: hours as ScheduleAssignment[], meta: observation.meta};
}

/** Paint only changed cells through the original Schedule panel, then read the whole row back. */
export async function ensureSchedule(game: Game, pawnId: string, hours: ScheduleAssignment[]) {
  if (!Array.isArray(hours) || hours.length !== 24 || hours.some(value => !assignments.has(value)))
    throw new Error('Provide exactly 24 supported timetable assignments, from hour 0 to 23.');
  const wanted = [...hours];
  return game.sequence(async () => {
    const before = await readSchedule(game, pawnId);
    const changedHours = wanted.map((value, hour) => value === before.hours[hour] ? -1 : hour).filter(hour => hour >= 0);
    if (!changedHours.length) return {status: 'unchanged', ...before, changedHours};
    await game.ui.panel('schedule').open();
    for (const assignment of new Set(changedHours.map(hour => wanted[hour]))) {
      await game.ui.action(`schedule.assignment.${assignment}`).click();
      for (const hour of changedHours.filter(hour => wanted[hour] === assignment)) {
        await game.ui.locator({actionId: 'schedule.hour', ownerId: pawnId, rowKey: String(hour), source: 'rp.schedule_cell'}).click();
      }
    }
    const after = await readSchedule(game, pawnId);
    if (after.meta.sessionId !== before.meta.sessionId || after.meta.worldEpoch !== before.meta.worldEpoch || after.meta.mapId !== before.meta.mapId)
      throw new Error('World or map changed while editing the timetable.');
    if (after.hours.some((value, hour) => value !== wanted[hour]))
      throw new Error('Schedule inputs were processed, but the requested 24-hour row was not observed.');
    return {status: 'updated', ...after, changedHours};
  });
}
