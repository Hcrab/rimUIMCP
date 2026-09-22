import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {connect} from '../../packages/sdk/src/index.ts';
const game=await connect();
await game.ui.press('Escape');
await game.runtime.save('rimUIMCP-Before-Combat-Test');
const pawns=(await game.state.pawns({colonistsOnly:false,budgetMs:500})).data.items;
const pawn=pawns.find((p:any)=>p.id==='Human661'),target=pawns.find((p:any)=>p.defName==='Bear_Polar');assert.ok(pawn&&target);
await game.pawn(pawn.id).select();if(!pawn.drafted)await game.ui.action('draft').click();
await game.call('ui.reveal',{x:target.position.x,z:target.position.z});
await game.map.click(target.position.x,target.position.z,{button:'right',drawnThingId:target.id});
const layout=(await game.ui.snapshot()).data;
console.log(layout.nodes.filter((n:any)=>n.surface.includes('FloatMenu')&&n.actionable).map((n:any)=>({name:n.name,role:n.role})));
const attack=layout.nodes.find((n:any)=>n.role==='button'&&n.name?.startsWith('Melee attack '));assert.ok(attack);
await game.ui.locator({surface:attack.surface,role:'button',name:attack.name}).click();
let evidence:any;
for(let i=0;i<25;i++) {
 await game.runtime.advance(120);
 const current=(await game.state.pawns({colonistsOnly:false,budgetMs:500})).data.items;
 const a=current.find((p:any)=>p.id===pawn.id),b=current.find((p:any)=>p.id===target.id);
 if(a.health.summary<1||b.health.summary<1||a.health.conditions.length>pawn.health.conditions.length||b.health.conditions.length>target.health.conditions.length){evidence={attacker:a,target:b,tick:(await game.status()).meta.gameTick};break;}
}
assert.ok(evidence,'Real combat should produce a health change');
await game.ui.screenshot('rp-combat-verified');
await writeFile('work/combat-verification.json',JSON.stringify({passed:true,source:'UI melee attack and game-computed damage',evidence},null,2));
console.log('PASS actual melee command and game-computed injury',evidence.attacker.currentJob,evidence.attacker.health.summary,evidence.target.health.summary);
await game.runtime.load('rimUIMCP-Before-Combat-Test');
