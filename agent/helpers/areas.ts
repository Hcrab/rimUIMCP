import type { Game, ObjectRef } from '../../packages/sdk/src/index.ts';

/** A pawn's areas are keyed by map; a caravan or another map must not masquerade as this assignment. */
export async function allowedArea(game: Game, pawnId: string) {
  const map = (await game.state.read('currentMap', { fields: ['uniqueID'] })).data.fields.uniqueID;
  const assignments = (await game.state.query({ root: 'game', thingId: pawnId,
    path: 'playerSettings.allowedAreas', derived: false,
    fields: ['key.uniqueID', 'value.ID', 'value'], limit: 1000 })).data;
  if (assignments.nextCursor != null) throw new Error('Allowed-area assignments were truncated.');
  const entries = assignments.items as Array<{ 'key.uniqueID': number; 'value.ID': number | null; value?: ObjectRef | null }>;
  const entry = entries.find(a => a['key.uniqueID'] === map);
  const areaId = entry?.['value.ID'] ?? null;
  let name = areaId === null ? 'Unrestricted' : `Area ${areaId}`;
  if (entry?.value?.type === 'RimWorld.Area_Home') name = 'Home';
  else if (entry?.value?.type === 'RimWorld.Area_Allowed')
    name = (await game.state.read(entry.value, { fields: ['labelInt'] })).data.fields.labelInt;
  return { mapId: map, areaId, name };
}

/** Select the real Schedule grid cell and verify the resulting per-map restriction. */
export async function assignAllowedArea(game: Game, pawnId: string, areaId: number | null) {
  if (areaId !== null && (!Number.isInteger(areaId) || areaId < 0)) throw new Error('Use an area ID or null for Unrestricted.');
  return game.sequence(async () => {
    const identity = (await game.status()).meta;
    const before = await allowedArea(game, pawnId);
    if (before.areaId === areaId) return { status: 'unchanged', ...before };
    await game.ui.panel('schedule').open();
    await game.ui.locator({ actionId: 'schedule.area', ownerId: pawnId,
      rowKey: areaId === null ? 'unrestricted' : String(areaId), source: 'rp.allowed_area' }).click();
    const after = await allowedArea(game, pawnId), end = (await game.status()).meta;
    if (end.sessionId !== identity.sessionId || end.worldEpoch !== identity.worldEpoch || end.mapId !== identity.mapId)
      throw new Error('World or map changed while assigning the allowed area.');
    if (after.mapId !== before.mapId || after.areaId !== areaId) throw new Error('Area selection input processed, but the requested assignment was not observed.');
    return { status: 'updated', ...after };
  });
}
