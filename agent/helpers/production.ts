import type {Game,ObjectRef} from '../../packages/sdk/src/index.ts';
import {queryAll} from './observe.ts';
import {selectThing} from './selection.ts';
import {billRepeatModeTextKey,findLocalizedNodes,requireLocalizedNode,requireUniqueUiNode,selectorForUiNode} from './ui-text.ts';
export type BillPlan={stationId:string;recipe:string;menuLabel:string;mode:'TargetCount'|'Forever';count?:number;radius?:number;suspended?:boolean;includeEquipped?:boolean;ingredients?:{def:string;search:string}[]};

async function settings(game:Game,reference:ObjectRef,ingredients:boolean){
 const fields=(await game.state.read(reference,{fields:['loadID','repeatMode.defName','targetCount','ingredientSearchRadius','suspended','includeEquipped']})).data.fields;
 const allowed=ingredients?(await queryAll(game,{ref:reference,path:'ingredientFilter.allowedDefs',derived:false,fields:['defName']})).items.map(d=>d.defName).sort():undefined;
 return{loadId:fields.loadID,mode:fields['repeatMode.defName'],count:fields.targetCount,radius:fields.ingredientSearchRadius,suspended:fields.suspended,includeEquipped:fields.includeEquipped,allowed};
}
function matches(s:any,p:BillPlan){return s.mode===p.mode&&(p.mode!=='TargetCount'||s.count===p.count)&&(p.radius==null||Math.abs(s.radius-p.radius)<.01)&&(p.suspended==null||s.suspended===p.suspended)&&(p.includeEquipped==null||s.includeEquipped===p.includeEquipped)&&(!p.ingredients||JSON.stringify(s.allowed)===JSON.stringify([...new Set(p.ingredients.map(i=>i.def))].sort()));}

/** Owns only the requested bill fields. Ambiguous duplicate recipes need an explicit UI decision. */
export async function ensureBill(game:Game,plan:BillPlan){
 if(!['TargetCount','Forever'].includes(plan.mode))throw new Error('Use TargetCount or Forever.');
 if(plan.includeEquipped!=null&&plan.mode!=='TargetCount')throw new Error('includeEquipped requires TargetCount mode.');
 const count=plan.count;
 if(plan.mode==='TargetCount'&&(count==null||!Number.isInteger(count)||count<0||count>99999))throw new Error('TargetCount requires count 0..99999.');
 if(plan.radius!=null&&(!Number.isFinite(plan.radius)||plan.radius<3||(plan.radius>=100&&plan.radius!==999)))throw new Error('Ingredient radius must be 3..<100 cells, or 999 for unlimited; other distances cannot be represented by the game UI.');
 return game.sequence(async()=>{
  const station=(await game.state.read('game',{thingId:plan.stationId})).data as ObjectRef;
  const find=async()=>{
   const stack=(await game.state.bills()).data.items.find((s:any)=>s.owner.id===station.id);
   const matches=stack?.bills.filter((b:any)=>b.recipe===plan.recipe)??[];
   if(matches.length>1)throw new Error('Multiple bills use '+plan.recipe+'; choose the intended row explicitly.');
   return matches[0];
  };
  let bill=await find(),before=bill?await settings(game,bill.reference,!!plan.ingredients):null;
  if(before&&matches(before,plan))return{status:'unchanged',reference:bill.reference,settings:before};
  await selectThing(game,plan.stationId);
  // Selection can remain active behind another main tab after an idempotent select.
  const otherPanel=(await game.ui.snapshot()).data.nodes.find((n:any)=>n.surface.startsWith('main-tab:')&&n.surface!=='main-tab:Inspect');
  if(otherPanel)await game.ui.action('panel.'+otherPanel.surface.slice('main-tab:'.length).toLowerCase()).click();
  let layout=(await game.ui.snapshot()).data;
  if(!findLocalizedNodes(layout.nodes,'addBill',{predicate:(n:any)=>n.actionable&&n.role==='button'}).length){
   const bills=requireLocalizedNode(layout.nodes,'bills',{predicate:(n:any)=>n.actionable&&n.role==='button'});
   await game.ui.locator(selectorForUiNode(bills)).click();
  }
  if(!bill){
   const addBill=requireLocalizedNode((await game.ui.snapshot()).data.nodes,'addBill',{predicate:(n:any)=>n.actionable&&n.role==='button'});
   await game.ui.locator(selectorForUiNode(addBill)).click();
   const recipe=requireUniqueUiNode((await game.ui.snapshot()).data.nodes,(n:any)=>n.actionable&&n.role==='button'&&typeof n.surface==='string'&&n.surface.includes('FloatMenu')&&n.name===plan.menuLabel,`Recipe menu choice "${plan.menuLabel}"`);
   await game.ui.locator(selectorForUiNode(recipe)).click();bill=await find();
   if(!bill)throw new Error('Add-bill input processed, but recipe was not added.');
  }
  const current=await settings(game,bill.reference,false),rowKey=`Bill_${plan.recipe}_${current.loadId}`;
  if(current.mode!==plan.mode){
   const currentModeKey=billRepeatModeTextKey(String(current.mode));
   const targetModeKey=billRepeatModeTextKey(plan.mode);
   if(!currentModeKey||!targetModeKey)throw new Error(`Unsupported bill repeat mode: ${String(current.mode)}.`);
   const row=requireLocalizedNode((await game.ui.snapshot()).data.nodes,currentModeKey,{predicate:(n:any)=>n.actionable&&n.role==='button'&&n.ownerId===plan.stationId&&n.rowKey===rowKey});
   await game.ui.locator(selectorForUiNode(row)).click();
   const option=requireLocalizedNode((await game.ui.snapshot()).data.nodes,targetModeKey,{predicate:(n:any)=>n.actionable&&n.role==='button'&&typeof n.surface==='string'&&n.surface.includes('FloatMenu')});
   await game.ui.locator(selectorForUiNode(option)).click();
  }
  layout=(await game.ui.snapshot()).data;
  const details=requireLocalizedNode(layout.nodes,'details',{predicate:(n:any)=>n.actionable&&n.role==='button'&&n.ownerId===plan.stationId&&n.rowKey===rowKey});
  await game.ui.locator(selectorForUiNode(details)).click();
  const surfaces=[...new Set<string>((await game.ui.snapshot()).data.nodes.map((n:{surface?:string})=>n.surface).filter((s:unknown):s is string=>typeof s==='string'&&s.includes('Dialog_BillConfig')))];
  if(surfaces.length!==1)throw new Error(`Expected one bill configuration window; found ${surfaces.length}.`);
  const surface=surfaces[0];
  if(plan.mode==='TargetCount')await game.ui.locator({surface,role:'text_field',nth:0}).fill(String(plan.count));
  if(plan.includeEquipped!=null&&current.includeEquipped!==plan.includeEquipped){
   const equipped=requireLocalizedNode((await game.ui.snapshot()).data.nodes,'includeEquipped',{predicate:(n:any)=>n.actionable&&n.role==='checkbox'&&n.surface===surface});
   await game.ui.locator(selectorForUiNode(equipped)).setChecked(plan.includeEquipped);
  }
  if(plan.radius!=null)await game.ui.locator({surface,role:'slider',source:'rp.slider'}).setValue(plan.radius===999?100:plan.radius);
  if(plan.ingredients){
   const search=async(text:string)=>{
    // The filter search is a root input. Numeric bill counters are nested in
    // their listing, so they must not be mistaken for this unlabeled field.
    const inputs=(await game.ui.snapshot()).data.nodes.filter((n:any)=>n.surface===surface&&n.actionable&&n.role==='text_field'&&n.source==='gui.text_field'&&n.depth===0&&n.parentTargetId==null);
    if(inputs.length!==1)throw new Error('The ingredient search field is not uniquely identified.');
    await game.ui.input({targetId:inputs[0].targetId,action:'fill',text});
   };
   const clearAll=requireLocalizedNode((await game.ui.snapshot()).data.nodes,'clearAll',{predicate:(n:any)=>n.actionable&&n.role==='button'&&n.surface===surface});
   await game.ui.locator(selectorForUiNode(clearAll)).click();
   for(const ingredient of plan.ingredients){
    await search(ingredient.search);
    await game.ui.locator({surface,role:'checkbox',actionId:'filter.thing.'+ingredient.def}).setChecked(true);
   }
   await search('');
  }
  if(plan.suspended!=null&&current.suspended!==plan.suspended){
   const suspended=requireLocalizedNode((await game.ui.snapshot()).data.nodes,current.suspended?'suspended':'notSuspended',{predicate:(n:any)=>n.actionable&&n.role==='button'&&n.surface===surface});
   await game.ui.locator(selectorForUiNode(suspended)).click();
  }
  const close=requireLocalizedNode((await game.ui.snapshot()).data.nodes,'close',{predicate:(n:any)=>n.actionable&&n.role==='button'&&n.surface===surface});
  await game.ui.locator(selectorForUiNode(close)).click();
  const after=await settings(game,bill.reference,!!plan.ingredients);
  if(!matches(after,plan))throw new Error('Bill controls processed input, but requested fields were not observed.');
  return{status:before?'updated':'created',reference:bill.reference,settings:after};
 });
}
