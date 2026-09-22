import {test} from 'node:test';
import assert from 'node:assert/strict';
import {custodyExitAlert} from './custody.ts';
const pawn=(more={})=>({thingIDNumber:94244,'def.defName':'Human','factionInt.def.defName':'Pirate',
 'guest.guestStatusInt':'Prisoner','guest.hostFactionInt.def.defName':'PlayerColony',
 'guest.releasedInt':false,'guest.interactionMode.defName':'AttemptRecruit',
 'jobs.curJob.exitMapOnArrival':false,'jobs.curJob.def.defName':'Goto',positionInt:{x:119,z:125},...more});
test('detect departing prisoner before reaching the map edge',()=>{
 const tracked=new Set<number>();assert.equal(custodyExitAlert([pawn()],tracked),null);
 const alert=custodyExitAlert([pawn({'jobs.curJob.exitMapOnArrival':true})],tracked);
 assert.equal(alert?.id,'Human94244');assert.equal(alert?.position.x,119);
});
test('remember custody if guest status clears before departure',()=>{
 const tracked=new Set<number>();custodyExitAlert([pawn()],tracked);
 assert.ok(custodyExitAlert([pawn({'guest.guestStatusInt':'Guest','guest.hostFactionInt.def.defName':null,'jobs.curJob.exitMapOnArrival':true})],tracked));
});
test('allow explicit release, successful recruitment and ordinary visitors',()=>{
 for(const change of [{'guest.releasedInt':true},{'guest.interactionMode.defName':'Release'},{'factionInt.def.defName':'PlayerColony'}]){
  const tracked=new Set([94244]);assert.equal(custodyExitAlert([pawn({...change,'jobs.curJob.exitMapOnArrival':true})],tracked),null);assert.equal(tracked.size,0);
 }
 assert.equal(custodyExitAlert([pawn({'guest.guestStatusInt':'Guest','guest.hostFactionInt.def.defName':null,'jobs.curJob.exitMapOnArrival':true})],new Set()),null);
});
test('temporary absence while carried is not an escape-intent alert',()=>{
 const tracked=new Set([94244]);assert.equal(custodyExitAlert([],tracked),null);assert.equal(tracked.has(94244),true);
});
