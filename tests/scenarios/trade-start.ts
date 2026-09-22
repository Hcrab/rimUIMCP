import assert from 'node:assert/strict';
import {connect} from '../../packages/sdk/src/index.ts';
const game=await connect();
await game.ui.press('Escape');
const pawns=(await game.state.pawns({colonistsOnly:false,budgetMs:500})).data.items;
const trader=pawns.find((p:any)=>p.id==='Human139097'); assert.ok(trader);
const pawn=pawns.find((p:any)=>p.colonist&&!p.skills.find((s:any)=>s.def==='Social')?.disabled); assert.ok(pawn);
await game.pawn(pawn.id).select();
await game.map.click(trader.position.x,trader.position.z,{button:'right'});
const layout=(await game.ui.snapshot()).data;
console.log(layout.nodes.filter((n:any)=>n.surface.includes('FloatMenu')&&n.actionable).map((n:any)=>({role:n.role,name:n.name})));
const trade=layout.nodes.find((n:any)=>n.role==='button'&&n.name?.startsWith('Trade with '));
assert.ok(trade,'Actual trader right-click menu');
await game.ui.locator({surface:trade.surface,role:'button',name:trade.name}).click();
for(let i=0;i<25;i++) {
  const windows=(await game.ui.snapshot()).data;
  if(windows.nodes.some((n:any)=>n.surface.includes('Dialog_Trade'))) {console.log('PASS trade interaction opened Dialog_Trade via pawn job');process.exit(0);}
  await game.runtime.advance(60);
}
throw new Error('Trader job did not open trade window');
