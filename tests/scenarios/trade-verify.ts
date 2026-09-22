import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {connect} from '../../packages/sdk/src/index.ts';
const game=await connect();
const inventory=async()=>{
 const result=await game.call('state.query',{thingId:'Human139097',path:'inventory.innerContainer.innerList',fields:['def.defName','stackCount'],derived:false});
 return Object.fromEntries(result.data.items.map((i:any)=>[i['def.defName'],i.stackCount]));
};
const before=await inventory();
const layout=(await game.ui.snapshot()).data;
const surface=layout.nodes.find((n:any)=>n.surface.includes('Dialog_Trade')).surface;
for(const [rowKey,value] of [['Steel','10'],['Cloth','5']]) {
 const field=game.ui.locator({surface,role:'text_field',rowKey,source:'gui.text_field'});
 await field.fill(value); assert.equal((await field.read()).data.valueText,value);
}
// Capture the game-calculated currency transfer from the visible trade row's object.
const silver=(await game.ui.snapshot()).data.nodes.find((n:any)=>n.surface===surface&&n.rowKey==='Silver'&&n.ownerId);
const status=await game.status();
const ref={id:silver.ownerId,sessionId:status.meta.sessionId,worldEpoch:status.meta.worldEpoch,type:'RimWorld.Tradeable'};
const currency=(await game.state.read(ref,{fields:['countToTransfer']})).data.fields.countToTransfer;
assert.ok(currency<0,'Buying goods should reduce colony silver');
await game.ui.screenshot('rp-trade-quantities');
const requestId=randomUUID(), args={selector:{surface,role:'button',name:'Accept'},action:'click'};
await game.call('ui.input',args,{requestId});
const after=await inventory();
assert.equal(after.Steel,before.Steel-10); assert.equal(after.Cloth,before.Cloth-5);
assert.equal(after.Silver,before.Silver-currency);
await game.call('ui.input',args,{requestId});
assert.deepEqual(await inventory(),after,'Duplicate request must return retained result without a second trade');
const record={passed:true,before,after,currency,requestId,source:'actual GUI trade and inventory readback'};
await writeFile('work/trade-verification.json',JSON.stringify(record,null,2));
console.log('PASS multi-item trade, exact currency settlement, duplicate request id',record);
await game.runtime.save('rimUIMCP-Trade-Verified');
