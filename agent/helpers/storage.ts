import type{Game,ObjectRef}from'../../packages/sdk/src/index.ts';
import{designateRectangle,clearDesignator,type Cell}from'./architect.ts';
import{queryAll}from'./observe.ts';
import{findLocalizedNodes,requireLocalizedNode,selectorForUiNode,storagePriorityTextKey}from'./ui-text.ts';
export type StockpilePlan={from:Cell;to:Cell;allowed:{def:string;search:string}[];priority:'Low'|'Normal'|'Preferred'|'Important'|'Critical'};
const cellKey=(c:Cell)=>`${c.x},${c.z}`;

async function zoneAt(game:Game,cell:Cell){
 const refs=(await game.state.read('currentMap',{path:'zoneManager.allZones'})).data.items as ObjectRef[];
 for(const ref of refs.filter(r=>r.type.endsWith('Zone_Stockpile'))){
  const cells=(await game.state.read(ref,{fields:['cells'],depth:1})).data.fields.cells.items as Cell[];
  if(cells.some(c=>cellKey(c)===cellKey(cell)))return{ref,cells};
 }
 return null;
}
export async function stockpileSettings(game:Game,ref:ObjectRef){
 const defs=await queryAll(game,{ref,path:'settings.filter.allowedDefs',derived:false,fields:['defName']});
 const priority=(await game.state.read(ref,{fields:['settings.priorityInt']})).data.fields['settings.priorityInt'];
 return{allowed:defs.items.map(d=>d.defName).sort(),priority};
}

/** Owns only allowed item definitions and priority; preserves other filter constraints. */
export async function ensureStockpile(game:Game,plan:StockpilePlan){
 return game.sequence(async()=>{
  const cells:Cell[]=[];
  for(let x=Math.min(plan.from.x,plan.to.x);x<=Math.max(plan.from.x,plan.to.x);x++)for(let z=Math.min(plan.from.z,plan.to.z);z<=Math.max(plan.from.z,plan.to.z);z++)cells.push({x,z});
  let zone=await zoneAt(game,plan.from),created=false;
  if(!zone){await designateRectangle(game,'Zone','designator.Designator_ZoneAddStockpile_Resources',plan.from,plan.to);zone=await zoneAt(game,plan.from);created=true;}
  if(!zone||zone.cells.length!==cells.length||!cells.every(c=>zone!.cells.some(v=>cellKey(v)===cellKey(c))))throw new Error('Stockpile rectangle does not match the requested cells; inspect overlaps or blocked cells.');
  const expected=[...new Set(plan.allowed.map(a=>a.def))].sort(),before=await stockpileSettings(game,zone.ref);
  if(before.priority===plan.priority&&JSON.stringify(before.allowed)===JSON.stringify(expected))return{status:created?'created':'unchanged',zone:zone.ref,settings:before};
  await clearDesignator(game);
  await game.call('ui.reveal',plan.from);
  let selected=false;
  for(let click=0;click<8;click++){
   await game.map.click(plan.from.x,plan.from.z);
   const selection=(await game.state.read('selection',{path:'selected'})).data.items;
   if(selection?.some((r:ObjectRef)=>r.id===zone!.ref.id)){selected=true;break;}
  }
  if(!selected)throw new Error('Could not select the stockpile through its map cells.');
  let layout=(await game.ui.snapshot()).data;
  if(!findLocalizedNodes(layout.nodes,'clearAll',{predicate:(n:any)=>n.actionable&&n.role==='button'}).length){
   const storage=requireLocalizedNode(layout.nodes,'storage',{predicate:(n:any)=>n.actionable&&n.role==='button'});
   await game.ui.locator(selectorForUiNode(storage)).click();
  }
  layout=(await game.ui.snapshot()).data;
  const clearAll=requireLocalizedNode(layout.nodes,'clearAll',{predicate:(n:any)=>n.actionable&&n.role==='button'}),surface=clearAll.surface;
  if(typeof surface!=='string')throw new Error('Storage filter surface is missing from the current UI snapshot.');
  await game.ui.locator(selectorForUiNode(clearAll)).click();
  for(const item of plan.allowed){
   await game.ui.locator({surface,role:'text_field',source:'gui.text_field'}).fill(item.search);
   await game.ui.locator({surface,role:'checkbox',actionId:'filter.thing.'+item.def}).setChecked(true);
  }
  await game.ui.locator({surface,role:'text_field',source:'gui.text_field'}).fill('');
  const priorityButton=requireLocalizedNode((await game.ui.snapshot()).data.nodes,'priority',{match:'prefix',predicate:(n:any)=>n.actionable&&n.role==='button'&&n.surface===surface});
  await game.ui.locator(selectorForUiNode(priorityButton)).click();
  const priorityKey=storagePriorityTextKey(plan.priority);
  if(!priorityKey)throw new Error(`Unsupported storage priority: ${String(plan.priority)}.`);
  const priorityOption=requireLocalizedNode((await game.ui.snapshot()).data.nodes,priorityKey,{predicate:(n:any)=>n.actionable&&n.role==='button'&&typeof n.surface==='string'&&n.surface.includes('FloatMenu')});
  await game.ui.locator(selectorForUiNode(priorityOption)).click();
  const after=await stockpileSettings(game,zone.ref);
  if(after.priority!==plan.priority||JSON.stringify(after.allowed)!==JSON.stringify(expected))throw new Error('Storage controls processed input, but the expected filter state was not observed.');
  return{status:created?'created':'updated',zone:zone.ref,settings:after};
 });
}
