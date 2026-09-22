import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {connect,RimError} from '../packages/sdk/src/index.ts';
const game=await connect();
const directory='runs/ui-edges-'+new Date().toISOString().replaceAll(':','-');mkdirSync(directory,{recursive:true});const records:any[]=[];
async function check(name:string,fn:()=>Promise<any>){try{records.push({name,passed:true,evidence:await fn()});console.log('PASS '+name);}catch(e){records.push({name,passed:false,error:e instanceof RimError?e.result:String(e)});console.error('FAIL '+name+': '+(e as Error).message);}writeFileSync(directory+'/results.json',JSON.stringify(records,null,2));}
if(process.argv.includes('--load'))await game.runtime.load('rimUIMCP-Economy-Verified');
await check('actual research scroll view changes and reads its offset',async()=>{
 await game.ui.panel('research').open();const layout=(await game.ui.snapshot()).data;const scroll=layout.nodes.find((n:any)=>n.role==='scroll_view'&&n.scroll?.maxOffsetX>500);assert.ok(scroll);
 await game.ui.input({targetId:scroll.targetId,action:'scroll',targetX:500});
 const after=(await game.ui.snapshot()).data.nodes.find((n:any)=>n.role==='scroll_view'&&n.scroll?.maxOffsetX>500);assert.equal(after.scroll.offsetX,500);
 await game.ui.input({targetId:after.targetId,action:'scroll',targetX:0});return {before:scroll.scroll.offsetX,after:after.scroll.offsetX};
});
await check('disabled work cell rejects input and leaves state unchanged',async()=>{
 await game.ui.panel('work').open();const node=(await game.ui.snapshot()).data.nodes.find((n:any)=>n.role==='work-cell'&&n.disabled);assert.ok(node);
 await assert.rejects(game.ui.input({targetId:node.targetId,action:'click'}),e=>e instanceof RimError&&e.code==='CONTROL_DISABLED');return {pawn:node.ownerId,work:node.rowKey};
});
await check('pawn Health, Needs and Gear tabs open through real inspect buttons',async()=>{
 await game.ui.press('Escape');const pawn=(await game.state.pawns({budgetMs:500})).data.items[0];await game.pawn(pawn.id).select();
 const evidence=[];for(const name of ['Health','Needs','Gear']){await game.ui.locator({surface:'main.inspect',role:'button',name}).click();const layout=(await game.ui.snapshot()).data;assert.ok(layout.nodes.some((n:any)=>n.surface.includes('ImmediateWindow')&&n.source));evidence.push({name,screenshot:(await game.ui.screenshot('rp-pawn-'+name.toLowerCase())).data.path});}return evidence;
});
await check('background control blocked by modal cannot add a bill',async()=>{
 const stove=(await game.state.map()).data.buildings.find((b:any)=>b.def==='FueledStove');await game.thing(stove.id).select();
 if(!(await game.ui.snapshot()).data.nodes.some((n:any)=>n.name==='Add bill'))await game.ui.locator({surface:'main.inspect',role:'button',name:'Bills'}).click();
 await game.ui.locator({role:'button',name:'Details...'}).click();
 await assert.rejects(game.ui.locator({role:'button',name:'Add bill'}).click(),e=>e instanceof RimError&&e.code==='UI_BLOCKED');
 await game.ui.locator({role:'button',name:'Close'}).click();return {blocked:true};
});
await check('fixture letter emits an event and opens through its actual icon',async()=>{
 const cursor=(await game.events.poll()).data.cursor;await game.call('fixture.prepare',{kind:'letter'});
 // The game's arrival animation changes the icon rect for its first second.
 // Wait for that actual animation boundary, not an arbitrary display pause.
 let letter:any;for(let i=0;i<100;i++){const layout=(await game.ui.snapshot()).data;letter=layout.nodes.find((n:any)=>n.surface==='main.letters'&&n.actionable&&n.name==='rimUIMCP fixture notification');if(letter)break;await game.runtime.nextFrame();}assert.ok(letter);
 await game.ui.locator({surface:'main.letters',role:'button',actionId:letter.actionId}).click();
 const layout=(await game.ui.snapshot()).data;assert.ok(layout.nodes.some((n:any)=>n.surface.includes('Dialog_NodeTree')));
 const events=(await game.events.poll(cursor)).data.events;assert.ok(events.some((e:any)=>e.name==='notification.letter'));
 await game.ui.screenshot('rp-letter-verified');await game.ui.press('Escape');return {actionId:letter.actionId,eventObserved:true};
});
console.log(JSON.stringify({passed:records.filter(r=>r.passed).length,failed:records.filter(r=>!r.passed).length,directory}));if(records.some(r=>!r.passed))process.exitCode=1;
