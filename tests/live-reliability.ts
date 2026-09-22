import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {connect,RimError} from '../packages/sdk/src/index.ts';
const game=await connect(), other=await connect();
const directory='runs/reliability-'+new Date().toISOString().replaceAll(':','-');mkdirSync(directory,{recursive:true});
const records:any[]=[];
async function check(name:string,fn:()=>Promise<any>){const started=performance.now();try{const evidence=await fn();records.push({name,passed:true,ms:performance.now()-started,evidence});console.log('PASS '+name);}catch(e){records.push({name,passed:false,error:e instanceof RimError?e.result:String(e)});console.error('FAIL '+name+': '+(e as Error).message);}writeFileSync(directory+'/results.json',JSON.stringify(records,null,2));}
await game.runtime.pause();
await check('100 sequential visible inputs, exact final state and measured latency',async()=>{
 await game.ui.panel('work').open();await game.ui.locator({role:'checkbox',name:'Manual priorities'}).setChecked(true);
 const node=(await game.ui.snapshot()).data.nodes.find((n:any)=>n.role==='work-cell'&&!n.disabled&&n.rowKey==='Doctor');assert.ok(node);
 const samples:number[]=[],before=await game.status();
 await game.sequence(async()=>{for(let i=0;i<100;i++){const t=performance.now();await game.ui.input({targetId:node.targetId,action:'click',button:'right'});samples.push(performance.now()-t);}});
 const state=(await game.state.pawns({budgetMs:500})).data.items.find((p:any)=>p.id===node.ownerId);assert.equal(state.work.Doctor.priority,Number(node.valueText));
 const after=await game.status();assert.equal(after.meta.gameTick,before.meta.gameTick);
 const sorted=[...samples].sort((a,b)=>a-b);const ms=samples.reduce((a,b)=>a+b,0);
 return {count:100,successRate:1,p50:sorted[49],p95:sorted[94],inputsPerSecond:100000/ms,ms,frames:after.meta.uiFrame-before.meta.uiFrame,ticks:0,samples};
});
await check('GUI sequences serialize two clients while observations remain available',async()=>{
 let unlock!:()=>void,entered!:()=>void;const barrier=new Promise<void>(r=>unlock=r),ready=new Promise<void>(r=>entered=r);let secondFinished=false;
 const first=game.sequence(async()=>{await game.ui.panel('work').open();entered();await barrier;});await ready;
 const second=other.ui.panel('schedule').open().then(r=>{secondFinished=true;return r;});
 try {await other.state.pawns({budgetMs:500});assert.equal(secondFinished,false);}finally{unlock();}
 await first;await second;assert.ok((await game.ui.snapshot()).data.nodes.some((n:any)=>n.role==='schedule-cell'));return {serialized:true,observationsAvailable:true};
});
await check('event wait returns on an observed UI event without advancing ticks',async()=>{
 const cursor=(await game.events.poll()).data.cursor;await game.ui.panel('research').open();
 const before=(await game.status()).meta.gameTick;const result=await game.runtime.runUntil({event:'ui.windowsChanged',cursor,maxTicks:10});
 assert.equal(result.data.satisfied,true);assert.equal(result.meta.gameTick,before);return result.data;
});
await check('cancel a local program holding the UI sequence and continue with another client',async()=>{
 const run=(await game.scripts.run('tests/fixtures/long-script.ts',{budgetMs:30000})).data;let owned=false;
 for(let i=0;i<50;i++){if((await game.status()).data.ui.owner===run.id){owned=true;break;}await new Promise(r=>setTimeout(r,50));}assert.ok(owned);
 const start=performance.now();await game.scripts.cancel(run.id);
 await other.ui.panel('work').open();let status:any;
 for(let i=0;i<50;i++){status=(await game.scripts.status(run.id)).data;if(status.ended)break;await new Promise(r=>setTimeout(r,50));}
 assert.equal(status.status,'cancelled');assert.ok(status.ended);assert.equal((await game.status()).data.ui.occupied,false);
 return {run:status,cancelMs:performance.now()-start};
});
await check('save/load invalidates object and UI references and permits fresh queries',async()=>{
 await game.runtime.save('rimUIMCP-Reliability');const roots=await game.state.roots();const target=(await game.ui.snapshot()).data.nodes.find((n:any)=>n.role==='work-cell');assert.ok(target);
 await game.runtime.load('rimUIMCP-Reliability');
 await assert.rejects(game.state.read(roots.data.game,{fields:['playSettings']}),e=>e instanceof RimError&&e.code==='STALE_REFERENCE');
 await assert.rejects(game.ui.input({targetId:target.targetId,action:'click'}),e=>e instanceof RimError&&e.code==='STALE_UI_REFERENCE');
 const fresh=await game.state.roots();assert.ok(fresh.meta.worldEpoch>roots.meta.worldEpoch);await game.ui.panel('work').open();return {before:roots.meta.worldEpoch,after:fresh.meta.worldEpoch};
});
await check('actual game UI through CLI, Python, MCP and TypeScript uses the same operation',async()=>{
 async function child(exe:string,args:string[],env:Record<string,string>={}){const p=spawn(exe,args,{cwd:process.cwd(),env:{...process.env,...env},windowsHide:true});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);const [code]=await once(p,'close');assert.equal(code,0,err);return JSON.parse(out);}
 const cli=await child(process.execPath,['apps/cli/src/main.ts','ui.panel','{"name":"schedule"}']);assert.equal(cli.data.path,'ui-control');
 const python=process.env.RIMUIMCP_PYTHON??'python';
 const py=await child(python,['-c','import asyncio,json\nfrom rimuimcp import connect\nasync def main():\n g=await connect()\n print(json.dumps(await g.call("ui.panel",{"name":"work"})))\nasyncio.run(main())'],{PYTHONPATH:path.resolve('packages/python'),RIMUIMCP_CONFIG:path.resolve('work/runtime.json')});assert.equal(py.data.path,'ui-control');
 const mcp=new Client({name:'live-test',version:'1'});try{await mcp.connect(new StdioClientTransport({command:process.execPath,args:['apps/mcp/src/main.ts']}));const r:any=await mcp.callTool({name:'rimuimcp_call',arguments:{method:'ui.panel',args:{name:'schedule'}}});assert.ok(!r.isError);assert.equal(JSON.parse(r.content[0].text).data.path,'ui-control');}finally{await mcp.close();}
 const ts=await game.ui.panel('work').open();assert.equal(ts.data.path,'ui-control');return {cli:true,python:true,mcp:true,typescript:true};
});
console.log(JSON.stringify({passed:records.filter(r=>r.passed).length,failed:records.filter(r=>!r.passed).length,directory}));if(records.some(r=>!r.passed))process.exitCode=1;
