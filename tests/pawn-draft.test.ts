import assert from 'node:assert/strict';
import test from 'node:test';
import {ensureDrafted} from '../agent/helpers/pawn.ts';

test('draft idempotency finds a pawn after the first hundred animals',async()=>{
 const items=[...Array.from({length:100},(_,i)=>({id:`Animal${i}`,drafted:false})),{id:'Colonist101',drafted:false}];
 let paused=0,clicked=0;
 const game={
  sequence:async(fn:()=>Promise<unknown>)=>fn(),
  runtime:{pause:async()=>{paused++;}},
  state:{pawns:async({cursor,limit}:any)=>{const page=items.slice(cursor,cursor+limit),next=cursor+page.length<items.length?cursor+page.length:null;return{success:true,requestId:'r',meta:{sessionId:'s',worldEpoch:1,mapId:'m',gameTick:1,uiFrame:1,snapshotId:'snap'},data:{items:page,total:items.length,offset:cursor,limit,nextCursor:next,truncated:next!==null}};}},
  ui:{action:()=>({click:async()=>{clicked++;}})},
 };
 const result=await ensureDrafted(game as any,'Colonist101',false);
 assert.equal(result.changed,false);
 assert.equal(paused,1);
 assert.equal(clicked,0,'an already-undrafted pawn must not toggle draft');
});
