import {connect} from '../../packages/sdk/src/index.ts';
const game=await connect();
await game.sequence(async()=>{
  console.log('READY: game sequence owned by '+game.scriptId);
  await game.runtime.nextFrame(10000);
});
