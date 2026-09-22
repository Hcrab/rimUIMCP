import {RimError,type ActionResult,type Game,type ObjectRef,type Result} from '../../packages/sdk/src/index.ts';

const MAX_SELECTION_ATTEMPTS=8;
type SelectionObservation={items:(ObjectRef|{ref:ObjectRef;id:string})[]};

function sameReference(left:ObjectRef,right:ObjectRef){
 return left.id===right.id&&left.sessionId===right.sessionId&&left.worldEpoch===right.worldEpoch&&left.type===right.type;
}

function requireStableWorld(target:ObjectRef,result:{meta?:{sessionId?:string;worldEpoch?:number}},step:string){
 const meta=result.meta;
 if(meta&&(meta.sessionId!==target.sessionId||meta.worldEpoch!==target.worldEpoch)){
  throw new Error(`Selection stopped: ${step} observed a different session or world.`);
 }
}

function selectedReferences(result:Result<any>):ObjectRef[]{
 const items=result.data?.items;
 if(!Array.isArray(items))throw new Error('Selection observation did not return selected references.');
 // Pawns are returned as state rows containing ref; other objects are bare refs.
 return items.map(item=>item.ref??item);
}

/** Select a concrete map object through the real UI and verify its stable reference afterwards. */
export async function selectThing(game:Game,id:string):Promise<Result<ActionResult|SelectionObservation>>{
 return game.sequence(async()=>{
  const readTarget=async(expected?:ObjectRef)=>{
   const result=await game.state.read('game',{thingId:id,budgetMs:500});
   const target=result.data as ObjectRef;
   if(!target?.id||!target.sessionId||typeof target.worldEpoch!=='number'||!target.type)throw new Error(`Selection target ${id} was not returned as an object reference.`);
   requireStableWorld(target,result,'target observation');
   if(expected&&!sameReference(target,expected))throw new Error(`Selection stopped: target ${id} changed or disappeared.`);
   return target;
  };
  const target=await readTarget();
  const readSelection=async()=>{
   const result=await game.state.read('selection',{path:'selected',budgetMs:500});
   requireStableWorld(target,result,'selection observation');
   return result;
  };
  const selected=async()=>selectedReferences(await readSelection()).some(reference=>sameReference(reference,target));

  const already=await readSelection();
  if(selectedReferences(already).some(reference=>sameReference(reference,target)))return already as Result<SelectionObservation>;

  for(let attempt=0;attempt<MAX_SELECTION_ATTEMPTS;attempt++){
   try{
    const action=await game.thing(id).select();
    requireStableWorld(target,action,'selection input');
    if(await selected())return action;
    throw new Error(`Selection input completed, but target ${id} was not observed as selected.`);
   }catch(error){
    if(!(error instanceof RimError)||error.code!=='RESULT_NOT_OBSERVED')throw error;
    requireStableWorld(target,error.result,'failed selection input');
    if(await selected())return (await readSelection()) as Result<SelectionObservation>;
    if(attempt===MAX_SELECTION_ATTEMPTS-1)throw new Error(`Could not select ${id} after ${MAX_SELECTION_ATTEMPTS} real UI attempts.`,{cause:error});
    await readTarget(target);
    await game.thing(id).reveal();
    await game.runtime.nextFrame(2);
   }
  }
  throw new Error(`Could not select ${id}.`);
 });
}
