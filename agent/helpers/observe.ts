import type {Game} from '../../packages/sdk/src/index.ts';

/** Read every page. Pause first when the result must describe one game tick. */
export async function queryAll(game:Game, query:Record<string,unknown>, options:{sameTick?:boolean;maxPages?:number}={}) {
 const items:any[]=[], pages:any[]=[], totals:number[]=[];
 let cursor=0, expectedTotal:number|undefined;
 for(let page=0;page<(options.maxPages??100);page++){
  const r=await game.state.query({limit:1000,budgetMs:500,maxNodes:100000,...query,cursor});
  if(!r||r.success!==true||!r.meta||!r.data||!Array.isArray(r.data.items))throw new Error('state.query returned an invalid collection result.');
  if(!Number.isInteger(r.data.total)||r.data.total<0)throw new Error('state.query returned an invalid collection total.');
  const nextCursor=r.data.nextCursor==null?null:Number(r.data.nextCursor);
  if(nextCursor!==null&&(!Number.isInteger(nextCursor)||nextCursor<=cursor))throw new Error('Pagination cursor did not advance.');
  const first=pages[0];
  if(first&&(r.meta.sessionId!==first.sessionId||r.meta.worldEpoch!==first.worldEpoch||r.meta.mapId!==first.mapId))throw new Error('World changed during pagination; discard these observations.');
  if(first&&options.sameTick!==false&&r.meta.gameTick!==first.gameTick)throw new Error('Game advanced during pagination. Pause before a consistent multi-page read.');
  expectedTotal??=r.data.total;
  if(options.sameTick!==false&&r.data.total!==expectedTotal)throw new Error('Collection changed during pagination.');
  totals.push(r.data.total);
  items.push(...r.data.items);
  const hasTruncated=Object.prototype.hasOwnProperty.call(r.data,'truncated');
  const pageTruncated=hasTruncated&&(r.data.truncated===true||r.data.truncated===false)?r.data.truncated:null;
  pages.push({ ...r.meta, returned: r.data.items.length, total: r.data.total, nextCursor, truncated: pageTruncated });
  if(nextCursor===null)return{
   items,
   pages,
   total:expectedTotal as number,
   returned:items.length,
   totals,
   nextCursor:null,
   completeByCursor:true,
   truncated:pageTruncated,
   truncatedFieldAvailable:pages.some(p=>p.truncated===true||p.truncated===false),
   consistency:pages.every(p=>p.gameTick===pages[0].gameTick)?'same-tick':'mixed-ticks'
  };
  cursor=nextCursor;
 }
 throw new Error('Page budget reached; narrow the query. No partial result is returned.');
}

export async function inventoryNear(game:Game,x:number,z:number,radius:number){
 const r=await queryAll(game,{root:'currentMap.items',derived:false,fields:['def.defName','thingIDNumber','stackCount','positionInt']});
 const items=r.items.filter(i=>Math.hypot(i.positionInt.x-x,i.positionInt.z-z)<=radius);
 const counts:Record<string,number>={};for(const i of items)counts[i['def.defName']]=(counts[i['def.defName']]??0)+i.stackCount;
 return{items,counts,pages:r.pages};
}

/** Counts permission flags only. Unforbidden does not imply reachable or unreserved. */
export async function inventoryPermissionsNear(game:Game,x:number,z:number,radius:number){
 const inventory=await inventoryNear(game,x,z,radius),observations=[...inventory.pages];
 const forbiddenIds=new Set<number>(),typeFields=new Map<string,boolean>();
 for(const def of new Set<string>(inventory.items.map(i=>i['def.defName']))){
  const example=inventory.items.find(i=>i['def.defName']===def);
  const reference=await game.state.read('game',{thingId:def+example.thingIDNumber,budgetMs:500});observations.push(reference.meta);
  if(!reference.data?.type||!reference.data?.id)throw new Error('Expected an item reference while checking inventory permissions.');
  const type=reference.data.type;
  if(!typeFields.has(type)){
   const description=await game.state.describe(reference.data);observations.push(description.meta);
   typeFields.set(type,description.data.fields.some((f:any)=>f.name==='compForbiddable'));
  }
  if(!typeFields.get(type))continue;
  const rows=await queryAll(game,{root:'currentMap.items',where:{'def.defName':def},derived:false,fields:['thingIDNumber','compForbiddable.forbiddenInt']});
  observations.push(...rows.pages);
  for(const row of rows.items)if(row['compForbiddable.forbiddenInt']===true)forbiddenIds.add(row.thingIDNumber);
 }
 const first=observations[0];
 if(observations.some(m=>m.gameTick!==first.gameTick||m.worldEpoch!==first.worldEpoch||m.sessionId!==first.sessionId))throw new Error('Inventory permissions changed observation boundary; pause before this multi-query read.');
 const counts:Record<string,{total:number;allowed:number;forbidden:number}>={};
 const items=inventory.items.map(item=>({...item,forbidden:forbiddenIds.has(item.thingIDNumber)}));
 for(const item of items){const c=counts[item['def.defName']]??={total:0,allowed:0,forbidden:0};c.total+=item.stackCount;c[item.forbidden?'forbidden':'allowed']+=item.stackCount;}
 return{items,counts,observations,consistency:'same-tick'};
}

export async function recordValues(game:Game,pawnId:string,names:string[]){
 const definitions=(await queryAll(game,{root:'defs',type:'RecordDef',derived:false,fields:['defName','index']})).items;
 const chosen=names.map(name=>{const d=definitions.find(d=>d.defName===name);if(!d)throw new Error('Unknown record: '+name);return d;});
 const fields=chosen.map(d=>'records.records.values.'+d.index),read=await game.state.read('game',{thingId:pawnId,fields,budgetMs:500});
 return{pawnId,meta:read.meta,values:Object.fromEntries(chosen.map((d,i)=>[d.defName,read.data.fields[fields[i]]]))};
}
