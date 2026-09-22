import type {Game} from '../../packages/sdk/src/index.ts';

type Row = Record<string, any>;
/** Remember captured pawns across a status change; ordinary visitors may leave freely. */
export function custodyExitAlert(rows: Row[], tracked: Set<number>) {
 for (const row of rows) {
  const id = row.thingIDNumber;
  const released = row['guest.releasedInt'] === true || row['guest.interactionMode.defName'] === 'Release';
  const joined = row['factionInt.def.defName'] === 'PlayerColony';
  if (released || joined) { tracked.delete(id); continue; }
  if (row['guest.guestStatusInt'] === 'Prisoner' && row['guest.hostFactionInt.def.defName'] === 'PlayerColony') tracked.add(id);
  if (tracked.has(id) && row['jobs.curJob.exitMapOnArrival'] === true) {
   return {id:`${row['def.defName']}${id}`,position:row.positionInt,job:row['jobs.curJob.def.defName'],exitMapOnArrival:true};
  }
 }
 return null;
}

/** Read-only evidence. This does not claim the current cell is safely enclosed. */
export async function readCustodyExitAlert(game: Game, tracked: Set<number>) {
 const result=await game.state.query({root:'currentMap.pawns',where:{'def.defName':'Human'},derived:false,
  fields:['thingIDNumber','def.defName','factionInt.def.defName','guest.guestStatusInt','guest.hostFactionInt.def.defName',
   'guest.releasedInt','guest.interactionMode.defName','jobs.curJob.exitMapOnArrival','jobs.curJob.def.defName','positionInt'],
  limit:500,budgetMs:500});
 if(result.data.nextCursor!=null)throw Error('Custody observation is incomplete');
 return {meta:result.meta,alert:custodyExitAlert(result.data.items,tracked)};
}
