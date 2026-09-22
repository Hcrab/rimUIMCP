import test from 'node:test';
import assert from 'node:assert/strict';
import {occupiedRect, overlaps, diningSeats, type BuildingGeometry} from '../agent/helpers/layout.ts';

const building = (id: string, x: number, z: number, width: number, height: number, surface: string, sittable = false): BuildingGeometry => ({
  id, def: id, position: {x, z}, size: {x: width, z: height}, rotation: 0, surface, sittable,
  rect: occupiedRect({x, z}, {x: width, z: height}, 0),
});

test('a diagonal stool is not a meal seat beside a north-facing 1x2 table', () => {
  const table = building('table', 134, 141, 1, 2, 'Eat');
  const seats = [building('diagonal-left', 133, 140, 1, 1, 'None', true),
    building('front', 134, 140, 1, 1, 'None', true), building('diagonal-right', 135, 140, 1, 1, 'None', true),
    building('side', 135, 142, 1, 1, 'None', true)];
  assert.deepEqual(diningSeats([table, ...seats]).map(s => s.seatId), ['front', 'side']);
});

test('three-bench campus needs analyzer shifted away from the third bench footprint', () => {
  const bench = occupiedRect({x: 133, z: 145}, {x: 5, z: 2}, 0);
  assert.equal(overlaps(bench, occupiedRect({x: 130, z: 144}, {x: 2, z: 2}, 0)), true);
  assert.equal(overlaps(bench, occupiedRect({x: 130, z: 143}, {x: 2, z: 2}, 0)), false);
});

test('even-sized rectangles rotate around the game anchor, not a naive bounding-box center', () => {
  const p = {x: 10, z: 20}, s = {x: 2, z: 4};
  assert.deepEqual(occupiedRect(p, s, 1), {minX: 9, minZ: 19, maxX: 12, maxZ: 20});
  assert.deepEqual(occupiedRect(p, s, 2), {minX: 9, minZ: 18, maxX: 10, maxZ: 21});
  assert.deepEqual(occupiedRect(p, s, 3), {minX: 8, minZ: 20, maxX: 11, maxZ: 21});
});
