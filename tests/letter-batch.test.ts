import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyLetters } from '../agent/helpers/letters.ts';

test('a simultaneous positive letter cannot hide a raid or an unreadable letter', () => {
  const result = classifyLetters([1, 1, 2, 3], [
    { id: 1, label: 'Inspired creativity', def: 'PositiveEvent' },
    { id: 2, label: 'Raid', def: 'ThreatBig' },
  ]);
  assert.deepEqual(result.deferred.map(x => x.id), [1]);
  assert.deepEqual(result.urgent.map(x => x.id), [2, 3]);
});

test('unknown mod letters and negative incidents retain immediate review', () => {
  const result = classifyLetters([4, 5], [
    { id: 4, label: 'Blight', def: 'NegativeEvent' },
    { id: 5, label: 'Custom incident', def: 'ModLetter' },
  ]);
  assert.equal(result.deferred.length, 0);
  assert.equal(result.urgent.length, 2);
});
