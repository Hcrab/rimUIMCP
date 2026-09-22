import type {Game} from '../../packages/sdk/src/index.ts';
import {queryAll} from './observe.ts';

type ResourceStack={id:number;def:string;count:number;source:'ground'|'inventory'|'carried';pawnId?:string;position?:{x:number;z:number};nearHome:boolean};

/** Observe ground stock and the specified pawns' real containers without advancing time. */
export async function readResources(game:Game,options:{pawnIds:string[];home:{x:number;z:number};radius?:number}){
 const before=await game.status();
 const radius=options.radius??35;
 const stacks:ResourceStack[]=[];
 const ground=(await queryAll(game,{root:'currentMap.items',derived:false,fields:['thingIDNumber','def.defName','stackCount','positionInt']})).items;
 for(const row of ground)stacks.push({id:row.thingIDNumber,def:row['def.defName'],count:row.stackCount,source:'ground',position:{x:row.positionInt.x,z:row.positionInt.z},nearHome:Math.hypot(row.positionInt.x-options.home.x,row.positionInt.z-options.home.z)<=radius});
 for(const pawnId of [...new Set(options.pawnIds)]){
  for(const [source,path] of [['inventory','inventory.innerContainer.innerList'],['carried','carryTracker.innerContainer.innerList']] as const){
   const items=(await queryAll(game,{root:'game',thingId:pawnId,path,derived:false,fields:['thingIDNumber','def.defName','stackCount']})).items;
   for(const row of items)stacks.push({id:row.thingIDNumber,def:row['def.defName'],count:row.stackCount,source,pawnId,nearHome:false});
  }
 }
 const after=await game.status();
 const sameWorld=before.meta.sessionId===after.meta.sessionId&&before.meta.worldEpoch===after.meta.worldEpoch&&before.meta.mapId===after.meta.mapId;
 if(!sameWorld)throw Error('Resource observation crossed a world boundary');
 const sameTick=before.meta.gameTick===after.meta.gameTick;
 const summary:Record<string,{ground:number;nearHomeGround:number;inventory:number;carried:number;totalObserved:number}>={};
 const seen=new Set<number>(),duplicates:number[]=[];
 for(const stack of stacks){
  if(seen.has(stack.id)){duplicates.push(stack.id);continue;}
  seen.add(stack.id);
  const count=summary[stack.def]??={ground:0,nearHomeGround:0,inventory:0,carried:0,totalObserved:0};
  count[stack.source]+=stack.count;
  if(stack.source==='ground'&&stack.nearHome)count.nearHomeGround+=stack.count;
  count.totalObserved+=stack.count;
 }
 return{meta:after.meta,startMeta:before.meta,sameTick,sameWorld,duplicates,home:options.home,radius,summary,stacks,note:'Ground includes all spawned map stock, including distant or unreachable items. nearHomeGround is distance only. Pawn inventories and carried stacks are distinct physical stock, not necessarily available to bills. Blueprints, crops and contained fuel are not counted.'};
}
