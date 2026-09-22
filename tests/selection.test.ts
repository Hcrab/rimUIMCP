import assert from 'node:assert/strict';
import test from 'node:test';
import {RimError} from '../packages/sdk/src/index.ts';
import {selectThing} from '../agent/helpers/selection.ts';

type Ref={id:string;sessionId:string;worldEpoch:number;type:string};
const target:Ref={id:'TableButcher42',sessionId:'session-a',worldEpoch:7,type:'Building'};
const meta={sessionId:target.sessionId,worldEpoch:target.worldEpoch,mapId:'Map_1',gameTick:1,uiFrame:1,snapshotId:'snapshot'};
const result=(data:any,overrides:Partial<typeof meta>={})=>({success:true as const,requestId:'request',meta:{...meta,...overrides},data});
const notObserved=(overrides:Partial<typeof meta>={})=>new RimError({success:false,error:{code:'RESULT_NOT_OBSERVED',message:'not selected'},meta:{...meta,...overrides}});

function mockGame(options:{select:()=>Promise<any>;targets?:()=>Promise<any>;selections:()=>Promise<any>}){
 const calls={select:0,reveal:0,nextFrame:0};
 const game:any={
  sequence:async(fn:any)=>fn(game),
  state:{
   read:async(root:string)=>{
    if(root==='game')return options.targets?await options.targets():result(target);
    if(root==='selection')return await options.selections();
    throw new Error('unexpected root '+root);
   },
  },
  thing:()=>({
   select:async()=>{calls.select++;return await options.select();},
   reveal:async()=>{calls.reveal++;return result({});},
  }),
  runtime:{nextFrame:async()=>{calls.nextFrame++;return result({});}},
 };
 return{game,calls};
}

test('already-selected target returns without another click',async()=>{
 const fixture=mockGame({select:async()=>{throw new Error('select should not run');},selections:async()=>result({items:[target]})});
 await selectThing(fixture.game,target.id);
 assert.equal(fixture.calls.select,0);
});

test('pawn selection rows use their nested object reference and remain idempotent',async()=>{
 let selected=false;
 const fixture=mockGame({
  select:async()=>{selected=true;return result({inputProcessed:true});},
  selections:async()=>result({items:selected?[{id:'Human42',ref:target,name:'Pawn'}]:[]}),
 });
 await selectThing(fixture.game,'Human42');
 await selectThing(fixture.game,'Human42');
 assert.equal(fixture.calls.select,1);
});

test('overlapping cell retries RESULT_NOT_OBSERVED and verifies the selected reference',async()=>{
 let selectionReads=0;
 const fixture=mockGame({
  select:async()=>fixture.calls.select===1?Promise.reject(notObserved()):result({inputProcessed:true}),
  selections:async()=>{
   selectionReads++;
   return result({items:selectionReads>=3?[target]:[]});
  },
 });
 await selectThing(fixture.game,target.id);
 assert.equal(fixture.calls.select,2);
 assert.equal(fixture.calls.reveal,1);
 assert.equal(fixture.calls.nextFrame,1);
});

test('retry exhaustion reports failure after the bounded number of real clicks',async()=>{
 const fixture=mockGame({select:async()=>Promise.reject(notObserved()),selections:async()=>result({items:[]})});
 await assert.rejects(selectThing(fixture.game,target.id),/after 8 real UI attempts/);
 assert.equal(fixture.calls.select,8);
 assert.equal(fixture.calls.reveal,7);
});

test('world changes and disappearing targets stop before another click',async t=>{
 await t.test('world change',async()=>{
  let targetReads=0;
  const fixture=mockGame({
   select:async()=>Promise.reject(notObserved()),
   targets:async()=>result({...target,worldEpoch:targetReads++===0?target.worldEpoch:target.worldEpoch+1},{worldEpoch:targetReads===1?target.worldEpoch:target.worldEpoch+1}),
   selections:async()=>result({items:[]}),
  });
  await assert.rejects(selectThing(fixture.game,target.id),/different session or world|changed or disappeared/);
  assert.equal(fixture.calls.select,1);
 });
 await t.test('target disappears',async()=>{
  let targetReads=0;
  const fixture=mockGame({
   select:async()=>Promise.reject(notObserved()),
   targets:async()=>{
    if(targetReads++===0)return result(target);
    throw new RimError({success:false,error:{code:'TARGET_NOT_FOUND',message:'target disappeared'},meta});
   },
   selections:async()=>result({items:[]}),
  });
  await assert.rejects(selectThing(fixture.game,target.id),/target disappeared/);
  assert.equal(fixture.calls.select,1);
 });
});

test('transport uncertainty does not cause another selection click',async()=>{
 const fixture=mockGame({select:async()=>{throw new RimError({error:{code:'TIMEOUT',message:'Outcome unknown'}});},selections:async()=>result({items:[]})});
 await assert.rejects(selectThing(fixture.game,target.id),/Outcome unknown/);
 assert.equal(fixture.calls.select,1);
});
