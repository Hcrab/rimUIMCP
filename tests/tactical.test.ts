import test from 'node:test';
import assert from 'node:assert/strict';
import {moveOrderAccepted, setDoorHoldOpen} from '../agent/helpers/tactical.ts';

test('an attack or a Goto toward a different cell is not accepted as the requested ground order', () => {
  const base = {positionInt:{x:1,z:2}, 'jobs.curJob.targetA.cellInt':{x:4,z:5}};
  assert.equal(moveOrderAccepted({...base, 'jobs.curJob.def.defName':'AttackMelee'}, {x:4,z:5}), null);
  assert.equal(moveOrderAccepted({...base, 'jobs.curJob.def.defName':'Goto'}, {x:4,z:6}), null);
  assert.equal(moveOrderAccepted({...base, 'jobs.curJob.def.defName':'Goto'}, {x:4,z:5}), 'accepted');
  assert.equal(moveOrderAccepted({positionInt:{x:4,z:5}}, {x:4,z:5}), 'arrived');
});

test('holding a still-closed door is reported separately and needs no duplicate toggle', async () => {
  let reads = 0;
  const meta = {sessionId:'s',worldEpoch:1,mapId:'m',gameTick:12};
  const game:any = {sequence: (fn: () => Promise<unknown>) => fn(), state:{read: async () => {reads++; return {meta, data:{fields:{'def.defName':'Door',holdOpenInt:true,openInt:false}}};}}};
  const result = await setDoorHoldOpen(game, 'Door1', true);
  assert.equal(reads, 1);
  assert.equal(result.changed, false);
  assert.equal(result.holdOpen, true);
  assert.equal(result.open, false);
});
