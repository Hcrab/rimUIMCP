import type {Game} from '../../packages/sdk/src/index.ts';
import {selectThing} from './selection.ts';
import {readAllPawns} from './pawns.ts';

export async function selectPawn(game:Game,id:string){
 return selectThing(game,id);
}

export async function ensureDrafted(game:Game,pawnId:string,wanted:boolean){
 return game.sequence(async()=>{
  const find=async()=>{const observation=await readAllPawns(game,{colonistsOnly:false,pauseForConsistency:()=>game.runtime.pause()});const p=observation.data.items.find((p:any)=>p.id===pawnId);if(!p)throw new Error('Pawn is not spawned: '+pawnId);return p;};
  if((await find()).drafted===wanted)return{pawnId,drafted:wanted,changed:false};
  await selectPawn(game,pawnId);await game.ui.action('draft').click();
  if((await find()).drafted!==wanted)throw new Error('Draft input processed, but the requested state was not observed.');
  return{pawnId,drafted:wanted,changed:true};
 });
}

/** Confirm acceptance of the requested job; completion remains a separate observation. */
export async function prioritize(game:Game,plan:{pawnId:string;thingId:string;menuLabel:string;jobDef:string}){
 return game.sequence(async()=>{
  const target=(await game.state.read('game',{thingId:plan.thingId,fields:['thingIDNumber','positionInt']})).data.fields;
  const job=async()=>(await game.state.read('game',{thingId:plan.pawnId,fields:['jobs.curJob.def.defName','jobs.curJob.targetA.thingInt.thingIDNumber']})).data.fields;
  const accepted=(v:any)=>v['jobs.curJob.def.defName']===plan.jobDef&&v['jobs.curJob.targetA.thingInt.thingIDNumber']===target.thingIDNumber;
  if(accepted(await job()))return{status:'already-accepted',completion:'pending'};
  await selectPawn(game,plan.pawnId);
  await game.call('ui.reveal',{x:target.positionInt.x,z:target.positionInt.z});
  await game.map.click(target.positionInt.x,target.positionInt.z,{button:'right',drawnThingId:plan.thingId});
  // RimWorld executes a sole valid order without opening a menu.
  let result=await job();
  if(!accepted(result)){
   const choices=(await game.ui.snapshot()).data.nodes.filter((n:any)=>n.actionable&&n.surface.includes('FloatMenu'));
   const choice=choices.find((n:any)=>n.name===plan.menuLabel);
   if(!choice)throw new Error('Expected job not accepted; visible choices: '+choices.map((n:any)=>n.name).join(', '));
   await game.ui.locator({surface:choice.surface,role:'button',name:choice.name}).click();result=await job();
  }
  if(!accepted(result))throw new Error('Order input processed, but the requested job and target were not observed.');
  return{status:'accepted',completion:'pending',job:result};
 });
}
