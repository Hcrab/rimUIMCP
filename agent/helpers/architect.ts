import type {Game} from '../../packages/sdk/src/index.ts';
import {queryAll} from './observe.ts';
export type Cell={x:number;z:number};
export type BuildingPlan=Cell&{category:string;def:string;stuff?:string;menuChoice?:string;rotation?:number};

export async function clearDesignator(game:Game){
 for(let attempt=0;attempt<4;attempt++){
  if(!(await game.state.read('designator',{fields:['selectedDesignator']})).data.fields.selectedDesignator)return;
  await game.ui.press('Escape');
 }
 if((await game.state.read('designator',{fields:['selectedDesignator']})).data.fields.selectedDesignator)throw new Error('The active designator did not close after Escape. Inspect the focused window.');
}

/** Caller holds a game.sequence when subsequent map input belongs to this tool. */
export async function selectTool(game:Game,category:string,actionId:string,menuChoice?:string){
 await game.ui.panel('architect').open();
 if(!(await game.ui.snapshot()).data.nodes.some((n:any)=>n.actionable&&n.actionId===actionId))await game.ui.action('architect.category.'+category).click();
 await game.ui.action(actionId).click();
 const menu=(await game.ui.snapshot()).data.nodes.filter((n:any)=>n.actionable&&n.surface.includes('FloatMenu'));
 if(menu.length){
  const choice=menuChoice==null&&menu.length===1?menu[0]:menu.find((n:any)=>n.name===menuChoice);
  if(!choice)throw new Error(`Choose one of the visible materials: ${menu.map((n:any)=>n.name).join(', ')}`);
  await game.ui.locator({surface:choice.surface,role:'button',name:choice.name}).click();
 }
}

export async function designateRectangle(game:Game,category:string,actionId:string,from:Cell,to:Cell){
 return game.sequence(async()=>{
  await game.call('ui.reveal',{x:Math.round((from.x+to.x)/2),z:Math.round((from.z+to.z)/2)});
  await selectTool(game,category,actionId);
  try{return await game.map.drag(from.x,from.z,to.x,to.z);}finally{await clearDesignator(game);}
 });
}

async function placed(game:Game){
 const fields=['def.defName','def.entityDefToBuild.defName','positionInt','rotationInt.rotInt','stuffInt.defName'];
 const built=await queryAll(game,{root:'currentMap.buildings',derived:false,fields});
 const refs=(await game.state.read('currentMap.blueprints')).data.items;
 const blueprints=[];
 const hasBuildMaterial=new Map<string,boolean>([['RimWorld.Blueprint_Build',true]]);
 for(const ref of refs){
  if(!hasBuildMaterial.has(ref.type)){
   const description=(await game.state.describe(ref)).data;
   hasBuildMaterial.set(ref.type,description.fields.some((f:any)=>f.name==='stuffToUse'&&f.readable));
  }
  const wanted=hasBuildMaterial.get(ref.type)?[...fields,'stuffToUse.defName']:fields;
  blueprints.push((await game.state.read(ref,{fields:wanted,budgetMs:500})).data.fields);
 }
 return [...built.items,...blueprints];
}
const matches=(v:any,p:BuildingPlan)=>v.positionInt.x===p.x&&v.positionInt.z===p.z&&(v['def.entityDefToBuild.defName']??v['def.defName'])===p.def;
function compatible(v:any,p:BuildingPlan){
 if(p.stuff&&(v['stuffToUse.defName']??v['stuffInt.defName'])!==p.stuff)throw new Error(`Existing ${p.def} at ${p.x},${p.z} has another material.`);
 if(p.rotation!=null&&v['rotationInt.rotInt']!==p.rotation)throw new Error(`Existing ${p.def} at ${p.x},${p.z} has another rotation.`);
}

/** Drag one straight run of 1x1 buildings, then verify every resulting cell. */
export async function ensureBuildingLine(game:Game,plan:Omit<BuildingPlan,'x'|'z'>,from:Cell,to:Cell){
 if(![from.x,from.z,to.x,to.z].every(Number.isInteger)||(from.x!==to.x&&from.z!==to.z))throw new Error('A building line must have integer cells on one row or column.');
 if(plan.rotation!=null&&plan.rotation!==0)throw new Error('Nonzero rotations require individual building placement.');
 return game.sequence(async()=>{
  const defs=await queryAll(game,{root:'defs',type:'ThingDef',where:{defName:plan.def},fields:['defName','size.x','size.z']});
  if(defs.items.length!==1||defs.items[0]['size.x']!==1||defs.items[0]['size.z']!==1)throw new Error('Building lines require a verified 1x1 definition.');
  const cells:BuildingPlan[]=[];
  const length=Math.max(Math.abs(to.x-from.x),Math.abs(to.z-from.z));
  for(let i=0;i<=length;i++)cells.push({...plan,x:from.x+i*Math.sign(to.x-from.x),z:from.z+i*Math.sign(to.z-from.z)});
  const before=await placed(game);
  for(const cell of cells){const old=before.find(v=>matches(v,cell));if(old)compatible(old,cell);}
  if(cells.every(cell=>before.some(v=>matches(v,cell))))return{status:'existing',cells};
  await game.call('ui.reveal',{x:Math.round((from.x+to.x)/2),z:Math.round((from.z+to.z)/2)});
  await selectTool(game,plan.category,'build.'+plan.def,plan.menuChoice);
  try{
   const selected=(await game.state.read('designator',{fields:['selectedDesignator.entDef.defName','selectedDesignator.stuffDef.defName'],budgetMs:500})).data.fields;
   if(selected['selectedDesignator.entDef.defName']!==plan.def||(plan.stuff&&selected['selectedDesignator.stuffDef.defName']!==plan.stuff))throw new Error('The selected build tool or material differs from the line plan.');
   await game.map.drag(from.x,from.z,to.x,to.z);
  }finally{await clearDesignator(game);}
  const after=await placed(game),missing:Cell[]=[];
  for(const cell of cells){const found=after.find(v=>matches(v,cell));if(found)compatible(found,cell);else missing.push({x:cell.x,z:cell.z});}
  if(missing.length)throw new Error(`Building line partially accepted; missing ${JSON.stringify(missing)}. Existing blueprints remain for inspection.`);
  return{status:'designated',cells};
 });
}

/** Repeated calls reuse an existing matching building, frame or blueprint. */
export async function ensureBuildings(game:Game,plans:BuildingPlan[]){
 return game.sequence(async()=>{
  const known=await placed(game),result:{plan:BuildingPlan;status:'existing'|'designated'}[]=[];
  for(const plan of plans){
   if(plan.rotation!=null&&(!Number.isInteger(plan.rotation)||plan.rotation<0||plan.rotation>3))throw new Error('Rotation must be 0..3.');
   const old=known.find(v=>matches(v,plan));if(old){compatible(old,plan);result.push({plan,status:'existing'});continue;}
   await game.call('ui.reveal',{x:plan.x,z:plan.z});
   await selectTool(game,plan.category,'build.'+plan.def,plan.menuChoice);
   try{
    const selected=async()=> (await game.state.read('designator',{fields:['selectedDesignator.entDef.defName','selectedDesignator.stuffDef.defName','selectedDesignator.placingRot.rotInt']})).data.fields;
    let fields=await selected();
    if(fields['selectedDesignator.entDef.defName']!==plan.def)throw new Error('The requested build tool is not selected.');
    if(plan.stuff&&fields['selectedDesignator.stuffDef.defName']!==plan.stuff)throw new Error('The visible build tool has another material. Select its material menu explicitly.');
    if(plan.rotation!=null){
     for(let turn=0;turn<4&&fields['selectedDesignator.placingRot.rotInt']!==plan.rotation;turn++){await game.ui.press('E');fields=await selected();}
     if(fields['selectedDesignator.placingRot.rotInt']!==plan.rotation)throw new Error('The original rotation input did not reach the requested direction.');
    }
    await game.map.click(plan.x,plan.z);
   }finally{await clearDesignator(game);}
   const current=await placed(game),found=current.find(v=>matches(v,plan));
   if(!found)throw new Error(`Input processed, but no ${plan.def} appeared at ${plan.x},${plan.z}. Inspect the game rejection.`);
   compatible(found,plan);known.push(found);result.push({plan,status:'designated'});
  }
  return result;
 });
}
