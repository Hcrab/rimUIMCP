import type {Game, ObservationMeta} from '../../packages/sdk/src/index.ts';
import {queryAll} from './observe.ts';

export type Cell = {x: number; z: number};
export type Rect = {minX: number; minZ: number; maxX: number; maxZ: number};
export type BuildingGeometry = {
  id: string; def: string; position: Cell; size: Cell; rotation: number;
  surface: string; sittable: boolean; rect: Rect;
};

/** RimWorld 1.6 north-relative occupied rectangle, including even-size rotation offsets. */
export function occupiedRect(position: Cell, size: Cell, rotation: number): Rect {
  if (![0, 1, 2, 3].includes(rotation) || ![size.x, size.z].every(n => Number.isInteger(n) && n > 0)) {
    throw new Error('Expected a positive integer size and rotation 0..3.');
  }
  const width = rotation % 2 ? size.z : size.x;
  const height = rotation % 2 ? size.x : size.z;
  const offsets = [[0, 0], [0, -1], [-1, -1], [-1, 0]];
  const x = position.x + (width % 2 === 0 ? offsets[rotation][0] : 0);
  const z = position.z + (height % 2 === 0 ? offsets[rotation][1] : 0);
  const minX = x - Math.floor((width - 1) / 2);
  const minZ = z - Math.floor((height - 1) / 2);
  return {minX, minZ, maxX: minX + width - 1, maxZ: minZ + height - 1};
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minZ <= b.maxZ && b.minZ <= a.maxZ;
}

function contains(r: Rect, x: number, z: number): boolean {
  return x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ;
}

/** Geometric candidates only: reservations, faction, danger and reachability remain game checks. */
export function diningSeats(buildings: BuildingGeometry[]) {
  const tables = buildings.filter(b => b.surface === 'Eat');
  return buildings.filter(b => b.sittable).flatMap(seat => {
    const cells: {position: Cell; tableIds: string[]}[] = [];
    for (let x = seat.rect.minX; x <= seat.rect.maxX; x++) {
      for (let z = seat.rect.minZ; z <= seat.rect.maxZ; z++) {
        const tableIds = tables.filter(t => [[1, 0], [-1, 0], [0, 1], [0, -1]]
          .some(([dx, dz]) => contains(t.rect, x + dx, z + dz))).map(t => t.id);
        if (tableIds.length) cells.push({position: {x, z}, tableIds});
      }
    }
    return cells.length ? [{seatId: seat.id, cells}] : [];
  });
}

/** Read-only, includes all pages. Pause before calling for a consistent building layout. */
export async function readBuildingGeometry(game: Game): Promise<{buildings: BuildingGeometry[]; pages: ObservationMeta[]}> {
  const result = await queryAll(game, {root: 'currentMap.buildings', derived: false, fields: [
    'thingIDNumber', 'def.defName', 'positionInt', 'def.size.x', 'def.size.z',
    'rotationInt.rotInt', 'def.surfaceType', 'def.building.isSittable',
  ]});
  const buildings = result.items.map(row => {
    const position = {x: row.positionInt.x, z: row.positionInt.z};
    const size = {x: row['def.size.x'], z: row['def.size.z']};
    const rotation = row['rotationInt.rotInt'];
    return {id: row['def.defName'] + row.thingIDNumber, def: row['def.defName'], position, size,
      rotation, surface: row['def.surfaceType'], sittable: row['def.building.isSittable'] === true,
      rect: occupiedRect(position, size, rotation)};
  });
  return {buildings, pages: result.pages};
}
