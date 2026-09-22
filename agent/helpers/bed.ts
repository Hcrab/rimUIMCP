import type {Game} from '../../packages/sdk/src/index.ts';
import {selectThing} from './selection.ts';
type BedUiNode = { surface:string; source?:string; name?:string; actionable?:boolean; targetId:string; screenRect:{y:number} };

/** Assign through the bed's real owner dialog and verify the pawn's owned bed. */
export async function ensureBedOwner(game:Game,plan:{bedId:string;pawnId:string;pawnLabel:string}){
 return game.sequence(async()=>{
  const bed=(await game.state.read('game',{thingId:plan.bedId,fields:['thingIDNumber']})).data.fields.thingIDNumber;
  const read=()=>game.state.read('game',{thingId:plan.pawnId,fields:['ownership.intOwnedBed.thingIDNumber']});
  const before=await read();
  if(before.data.fields['ownership.intOwnedBed.thingIDNumber']===bed)return{status:'unchanged',...plan,meta:before.meta};
  await selectThing(game,plan.bedId);
  let nodes:BedUiNode[]=(await game.ui.snapshot()).data.nodes;
  if(!nodes.some(n=>n.surface.includes('Dialog_AssignBuildingOwner'))){
   await game.ui.locator({surface:'selection-gizmos',ownerId:plan.bedId,actionId:'command.Misc4'}).click();
   nodes=(await game.ui.snapshot()).data.nodes;
  }
  const dialog=nodes.filter(n=>n.surface.includes('Dialog_AssignBuildingOwner'));
  const labels=dialog.filter(n=>n.source==='widgets.label'&&(n.name===plan.pawnLabel||n.name?.startsWith(plan.pawnLabel+'<')));
  if(labels.length!==1)throw Error('Expected a unique bed-owner row for '+plan.pawnLabel);
  const choices=dialog.filter(n=>n.actionable&&['指定','重新分配','Assign','Reassign'].includes(n.name??'')&&Math.abs(n.screenRect.y-labels[0].screenRect.y)<5);
  if(choices.length!==1)throw Error('Expected a unique assignment button for '+plan.pawnLabel);
  await game.ui.input({action:'click',targetId:choices[0].targetId});
  const after=await read();
  if(after.data.fields['ownership.intOwnedBed.thingIDNumber']!==bed)throw Error('Bed ownership was not observed after UI assignment');
  const close=((await game.ui.snapshot()).data.nodes as BedUiNode[]).find(n=>n.surface.includes('Dialog_AssignBuildingOwner')&&n.actionable&&['关闭','Close'].includes(n.name??''));
  if(close)await game.ui.input({action:'click',targetId:close.targetId});
  return{status:'assigned',...plan,before:before.data.fields,after:after.data.fields,meta:after.meta};
 });
}
