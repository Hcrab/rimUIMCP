import test from 'node:test';
import assert from 'node:assert/strict';
import {worseningConditions, type HealthCondition} from '../agent/helpers/health.ts';

const bruise = (id: string, severity: number): HealthCondition => ({
  def: 'Bruise', part: 'Arm', severity, reference: {id, sessionId: 's', worldEpoch: 3},
});

test('a new arm injury is detected even when total arm damage falls as an old wound heals', () => {
  const fresh = bruise('new-right-arm', 0.1);
  assert.deepEqual(worseningConditions(
    {conditions: [bruise('old-left-arm', 5)]},
    {conditions: [bruise('old-left-arm', 4.8), fresh]},
  ), [fresh]);
});

test('healing, removal and reordered persistent injuries do not interrupt a battle', () => {
  assert.deepEqual(worseningConditions(
    {conditions: [bruise('a', 5), bruise('b', 2)]},
    {conditions: [bruise('b', 1.9), bruise('a', 4.8)]},
  ), []);
  assert.deepEqual(worseningConditions({conditions: [bruise('a', 5)]}, {conditions: []}), []);
});

test('a worsening existing injury, a new condition, and unreadable severity require attention', () => {
  const bloodLoss: HealthCondition = {def: 'BloodLoss', part: null, severity: 0.05};
  const after = [bruise('a', 5.2), bloodLoss];
  assert.deepEqual(worseningConditions({conditions: [bruise('a', 5)]}, {conditions: after}), after);
  assert.equal(worseningConditions({conditions: [bruise('a', 5)]}, {conditions: [bruise('a', NaN)]}).length, 1);
});
