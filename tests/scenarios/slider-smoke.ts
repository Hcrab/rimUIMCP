import assert from 'node:assert/strict';
import { connect } from '../../packages/sdk/src/index.ts';
const game=await connect();
await game.ui.panel('menu').open();
await game.ui.locator({role:'button',name:'Options'}).click();
await game.ui.locator({role:'button',name:'Audio'}).click();
const slider=game.ui.locator({role:'slider',source:'rp.slider',nth:2});
const before=Number((await slider.read()).data.valueText);
try { await slider.setValue(0.31); const after=Number((await slider.read()).data.valueText); assert.ok(Math.abs(after-0.31)<0.01,`actual=${after}`); console.log('PASS real audio slider: '+before+' -> '+after); }
finally { await slider.setValue(before); await game.ui.locator({role:'button',name:'OK'}).click(); await game.ui.press('Escape'); }
