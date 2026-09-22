import type{Game}from'../../packages/sdk/src/index.ts';
import{runAndWatch}from'./flow.ts';
import{readAllPawns}from'./pawns.ts';
import{selectPawn}from'./pawn.ts';
import{findLocalizedNodes,requireUniqueUiNode,selectorForUiNode}from'./ui-text.ts';

/** No loadout policy: caller chooses the pawn and exact item. Waits for actual ownership. */
export async function wear(game:Game,pawnId:string,thingId:string){
 const number=Number(thingId.match(/\d+$/)?.[0]);if(!Number.isInteger(number))throw new Error('Use a concrete thing ID.');
 const current=async()=>{
  const observation=await readAllPawns(game,{colonistsOnly:false,pageSize:500,budgetMs:500});
  const pawn=observation.data.items.find((v:any)=>v.id===pawnId);
  if(!pawn)throw new Error('Pawn is not spawned: '+pawnId);
  if(Array.isArray(pawn.equipment)&&pawn.equipment.some((v:any)=>v?.id===thingId))return'equipment' as const;
  const worn=(await game.state.query({root:'game',thingId:pawnId,path:'apparel.wornApparel.innerList',derived:false,fields:['thingIDNumber','def.defName'],budgetMs:500})).data.items;
  if(!Array.isArray(worn))throw new Error('Worn apparel query did not return an items array.');
  if(worn.some((v:any)=>v.thingIDNumber===number))return'apparel' as const;
  return undefined;
 };
 const existing=await current();
 if(existing)return{status:existing==='equipment'?'already-equipped':'already-worn',pawnId,thingId};
 await game.sequence(async()=>{
  const pos=(await game.state.read('game',{thingId,fields:['positionInt']})).data.fields.positionInt;
  await selectPawn(game,pawnId);await game.map.click(pos.x,pos.z,{button:'right',drawnThingId:thingId});
  const options=(await game.ui.snapshot()).data.nodes.filter((n:any)=>n.actionable&&n.surface.includes('FloatMenu'));
  const matches=[
   ...findLocalizedNodes(options,'equip',{match:'prefix',predicate:(n:any)=>n.role==='button'}),
   ...findLocalizedNodes(options,'forceWear',{match:'prefix',predicate:(n:any)=>n.role==='button'}),
  ];
  const wearOption=requireUniqueUiNode(matches,()=>true,'Equipment menu option');
  await game.ui.locator(selectorForUiNode(wearOption)).click();
 });
 // Observe after bounded real simulation; never send another order while this item is still on the ground.
 for(let i=0;i<12;i++){
  const ownership=await current();
  if(ownership)return{status:ownership==='equipment'?'equipped':'worn',pawnId,thingId};
  const r=await runAndWatch(game,{ticks:120,timeoutMs:10000,pollMs:250});
  if(r.reason!=='tick-budget')throw new Error(`Equipment job interrupted: ${r.reason}`);
 }
 const ownership=await current();
 if(ownership)return{status:ownership==='equipment'?'equipped':'worn',pawnId,thingId};
 throw new Error('Wear input was processed but the item is still not worn. Inspect the pawn job.');
}
