import type { Game, ObjectRef } from '../../packages/sdk/src/index.ts';
import { queryAll } from './observe.ts';

const PAGE_LIMIT = 1000;
const BUDGET_MS = 1000;
const MAX_NODES = 100000;
const MAX_PAGES = 100;
const LOW_DURABILITY_RATIO = 0.25;
// Confirmed ThingDef fields in the local 1.6.4871 bridge.  In particular,
// baseHitPoints is not a ThingDef field there; the base MaxHitPoints value is
// a StatModifier in statBases.
const DEF_CONDITION_FIELDS = ['defName', 'useHitPoints', 'statBases'];

export const EXPECTED_COLONISTS = [
  { id: 'Human1252', name: 'Escobar' },
  { id: 'Human1345', name: 'Talia' },
  { id: 'Human42368', name: 'Cobra' },
  { id: 'Human1389', name: 'Samantha' },
  { id: 'Human77921', name: 'Flynn' },
  { id: 'Human58127', name: 'Arias' },
];

export type Finding = {
  key: string;
  severity: 'important' | 'watch';
  kind: string;
  title: string;
  evidence: unknown;
  suggestion: string;
};

type InspectionContext = {
  game: Game;
  lease: Record<string, unknown>;
  observations: Array<Record<string, unknown>>;
  gaps: Array<Record<string, unknown>>;
  mapId: string | null | undefined;
  mapWidth: number | null;
  mapHeight: number | null;
  invalidReason: Record<string, unknown> | null;
};

type Collection = {
  status: 'complete' | 'partial' | 'unknown';
  items: any[];
  total: number | null;
  returned: number;
  unique: number;
  duplicatesRemoved: number;
  dedupeMode: string;
  anonymousRowsPreserved: number;
  completeByCursor: boolean;
  complete: boolean;
  truncated: boolean | null;
  truncatedFieldAvailable: boolean;
  pages: Array<Record<string, unknown>>;
  consistency: 'same-tick' | 'mixed-ticks' | 'unknown';
  collectionChanged: boolean;
  integrity?: Record<string, unknown>;
  request: { limit: number; budgetMs: number; maxNodes: number; sameTick: false };
  truncationBasis?: string;
  error?: { code: string; message: string };
};

class BoundaryError extends Error {
  code = 'OBSERVATION_BOUNDARY_CHANGED';
}

class CollectionError extends Error {
  code = 'COLLECTION_INCOMPLETE';
}

function errorInfo(error: any) {
  return { code: String(error?.code ?? 'INSPECTION_ERROR'), message: String(error?.message ?? error) };
}

function roundNumber(value: unknown, digits = 3): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function defName(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return null;
  const object = value as Record<string, unknown>;
  for (const key of ['defName', 'def', 'name', 'label']) if (typeof object[key] === 'string') return object[key] as string;
  if (object.fields && typeof object.fields === 'object') return defName(object.fields);
  return null;
}

function fieldValue(value: any, ...names: string[]): unknown {
  if (!value || typeof value !== 'object') return undefined;
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(value, name)) return value[name];
    if (value.fields && typeof value.fields === 'object' && Object.prototype.hasOwnProperty.call(value.fields, name)) return value.fields[name];
  }
  return undefined;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  if (value === 'true' || value === 'True') return true;
  if (value === 'false' || value === 'False') return false;
  return null;
}

function asRef(value: any): ObjectRef | null {
  if (!value || typeof value !== 'object') return null;
  if (value.reference && typeof value.reference.id === 'string') return value.reference as ObjectRef;
  if (typeof value.id === 'string' && typeof value.type === 'string') return value as ObjectRef;
  return null;
}

function position(value: any): { x: number; y: number; z: number } | null {
  if (!value || typeof value !== 'object') return null;
  if (!Number.isFinite(value.x) || !Number.isFinite(value.z)) return null;
  return { x: Number(value.x), y: Number.isFinite(value.y) ? Number(value.y) : 0, z: Number(value.z) };
}

function positionKey(value: any): string | null {
  const p = position(value);
  return p ? `${p.x},${p.z}` : null;
}

function itemKey(row: any): string {
  const def = String(row?.['def.defName'] ?? row?.def ?? 'unknown-def');
  const id = row?.thingIDNumber ?? row?.id ?? row?.ID ?? row?.age;
  if (id !== undefined && id !== null) return `${def}:${String(id)}`;
  try { return `row:${JSON.stringify(row)}`; } catch { return `row:${String(row)}`; }
}

type RowKey = (row: any) => string | null;

/**
 * The memory projection is intentionally small and does not contain a row
 * reference. Never use age or serialized values as an object identity. If a
 * bridge variant does expose a stable reference/ID, use it; otherwise retain
 * the row and let pagination totals provide the coverage evidence.
 */
function memoryIdentityKey(row: any): string | null {
  const reference = asRef(fieldValue(row, 'reference', 'ref')) ?? asRef(row);
  if (reference) return `reference:${reference.sessionId}:${reference.worldEpoch}:${reference.type}:${reference.id}`;
  const identity = fieldValue(row, 'thingIDNumber', 'memoryID', 'memoryId', 'uniqueID', 'uniqueId', 'id', 'ID');
  if (typeof identity === 'string' && identity.length) return `id:${identity}`;
  if (typeof identity === 'number' && Number.isFinite(identity)) return `id:${identity}`;
  return null;
}

function collectionItems(value: any): any[] | null {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.items)) return value.items;
  return null;
}

function readableFields(description: any): Set<string> {
  const value = description?.data?.fields ? description.data : description;
  return new Set((value?.fields ?? []).filter((field: any) => field?.readable === true).map((field: any) => String(field.name)));
}

function sameMeta(a: any, b: any): boolean {
  return Boolean(a && b && a.sessionId === b.sessionId && Number(a.worldEpoch) === Number(b.worldEpoch) && a.mapId === b.mapId);
}

function noteMeta(context: InspectionContext, meta: any, source: string) {
  if (!meta || typeof meta !== 'object') throw new CollectionError(`${source} returned no observation metadata.`);
  const expectedSession = context.lease.sessionId;
  const expectedEpoch = Number(context.lease.worldEpoch);
  if (meta.sessionId !== expectedSession || Number(meta.worldEpoch) !== expectedEpoch) {
    const failure = { source, meta, expected: { sessionId: expectedSession, worldEpoch: expectedEpoch } };
    context.invalidReason ??= failure;
    throw new BoundaryError(`Session/world changed during inspection at ${source}.`);
  }
  if (context.mapId !== undefined && context.mapId !== null && meta.mapId !== context.mapId) {
    const failure = { source, meta, expected: { mapId: context.mapId } };
    context.invalidReason ??= failure;
    throw new BoundaryError(`Map changed during inspection at ${source}.`);
  }
  if (context.mapId === undefined) context.mapId = meta.mapId;
  context.observations.push({ source, sessionId: meta.sessionId, worldEpoch: meta.worldEpoch, mapId: meta.mapId, gameTick: meta.gameTick, snapshotId: meta.snapshotId });
}

function checkResult(context: InspectionContext, result: any, source: string): any {
  if (!result || result.success !== true) throw new CollectionError(`${source} returned success=${String(result?.success)}.`);
  noteMeta(context, result.meta, source);
  if (result.data == null) throw new CollectionError(`${source} returned no data.`);
  return result.data;
}

function ensureValid(context: InspectionContext) {
  if (context.invalidReason) throw new BoundaryError('This inspection was invalidated by a session/world/map change.');
}

function dedupeRows(rows: any[], keyForRow: RowKey = itemKey): { items: any[]; duplicatesRemoved: number; anonymousRowsPreserved: number } {
  const seen = new Set<string>();
  const items: any[] = [];
  let anonymousRowsPreserved = 0;
  for (const row of rows) {
    const key = keyForRow(row);
    if (key === null) {
      items.push(row);
      anonymousRowsPreserved += 1;
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(row);
  }
  return { items, duplicatesRemoved: rows.length - items.length, anonymousRowsPreserved };
}

function pageConsistency(pages: Array<Record<string, any>>): 'same-tick' | 'mixed-ticks' | 'unknown' {
  const ticks = pages.map(page => page.gameTick).filter(value => Number.isFinite(value));
  if (!ticks.length) return 'unknown';
  return ticks.every(tick => tick === ticks[0]) ? 'same-tick' : 'mixed-ticks';
}

/**
 * state.query exposes total and nextCursor, but this bridge does not expose a
 * truncated field.  A closed cursor plus matching totals and no duplicate or
 * drifting pages is the evidence used to derive a complete collection.
 */
export function deriveCollectionIntegrity(input: {
  total: number | null;
  returned: number;
  duplicatesRemoved?: number;
  totals?: number[];
  finalCursorClosed: boolean;
  finalTruncated?: unknown;
  truncatedFieldAvailable?: boolean;
  intermediateTruncated?: boolean;
}) {
  const totals = input.totals ?? [];
  const collectionChanged = totals.length > 1 && totals.some(total => total !== totals[0]);
  const total = input.total;
  const totalMatches = typeof total === 'number' && Number.isInteger(total) && total >= 0 && input.returned === total;
  const duplicatesRemoved = input.duplicatesRemoved ?? 0;
  const finalTruncated = input.finalTruncated === true || input.finalTruncated === false ? input.finalTruncated : null;
  const complete = input.finalCursorClosed && totalMatches && duplicatesRemoved === 0 && !collectionChanged && finalTruncated !== true;
  const truncationBasis = finalTruncated === true
    ? 'observed-true-at-final-page'
    : finalTruncated === false
      ? 'observed-false-at-final-page'
      : complete
        ? input.truncatedFieldAvailable === true ? 'observed-pagination-closure' : 'derived-final-cursor+total+no-duplicates+stable-total'
        : 'unknown-incomplete-collection';
  return {
    status: complete ? 'complete' as const : 'partial' as const,
    complete,
    truncated: finalTruncated === true ? true : complete || finalTruncated === false ? false : null,
    truncatedFieldAvailable: input.truncatedFieldAvailable === true,
    truncationBasis,
    collectionChanged,
    integrity: {
      finalCursorClosed: input.finalCursorClosed,
      totalMatches,
      duplicatesRemoved,
      collectionChanged,
      intermediateTruncated: input.intermediateTruncated === true,
    },
  };
}

function collectionRequest(): Collection['request'] {
  return { limit: PAGE_LIMIT, budgetMs: BUDGET_MS, maxNodes: MAX_NODES, sameTick: false };
}

async function scanPages(context: InspectionContext, query: Record<string, unknown>, source: string): Promise<Collection> {
  ensureValid(context);
  let cursor = 0;
  const rows: any[] = [];
  const pages: Array<Record<string, unknown>> = [];
  const totals: number[] = [];
  let truncatedFieldAvailable = false;
  let intermediateTruncated = false;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    ensureValid(context);
    const result = await context.game.state.query({ ...query, limit: PAGE_LIMIT, budgetMs: BUDGET_MS, maxNodes: MAX_NODES, cursor });
    const data = checkResult(context, result, `${source}[page ${page + 1}]`);
    if (!Array.isArray(data.items)) throw new CollectionError(`${source}[page ${page + 1}] returned no items array.`);
    if (!Number.isInteger(data.total) || data.total < 0) throw new CollectionError(`${source}[page ${page + 1}] returned invalid total=${String(data.total)}.`);
    const nextCursor = data.nextCursor == null ? null : Number(data.nextCursor);
    if (nextCursor !== null && (!Number.isInteger(nextCursor) || nextCursor <= cursor)) throw new CollectionError(`${source}[page ${page + 1}] returned a non-advancing cursor.`);
    const hasTruncated = Object.prototype.hasOwnProperty.call(data, 'truncated');
    if (hasTruncated) truncatedFieldAvailable = true;
    if (data.truncated === true && nextCursor !== null) intermediateTruncated = true;
    totals.push(data.total);
    rows.push(...data.items);
    pages.push({ page: page + 1, sessionId: result.meta.sessionId, worldEpoch: result.meta.worldEpoch, mapId: result.meta.mapId, gameTick: result.meta.gameTick, returned: data.items.length, total: data.total, nextCursor, truncated: Object.prototype.hasOwnProperty.call(data, 'truncated') ? data.truncated : null, budgetMs: BUDGET_MS, maxNodes: MAX_NODES });
    if (nextCursor === null) {
      const finalTotal = data.total;
      const deduped = dedupeRows(rows);
      const integrity = deriveCollectionIntegrity({ total: finalTotal, returned: rows.length, duplicatesRemoved: deduped.duplicatesRemoved, totals, finalCursorClosed: true, finalTruncated: hasTruncated ? data.truncated : null, truncatedFieldAvailable, intermediateTruncated });
      return {
        ...integrity,
        items: deduped.items,
        total: finalTotal,
        returned: rows.length,
        unique: deduped.items.length,
        duplicatesRemoved: deduped.duplicatesRemoved,
        dedupeMode: 'item-id-or-row-value',
        anonymousRowsPreserved: deduped.anonymousRowsPreserved,
        completeByCursor: true,
        pages,
        consistency: pageConsistency(pages),
        request: collectionRequest(),
        error: integrity.complete ? undefined : { code: 'COLLECTION_PARTIAL', message: `${source} pagination closed with incomplete evidence: ${integrity.truncationBasis}.` },
      };
    }
    cursor = nextCursor;
  }
  throw new CollectionError(`${source} exceeded the ${MAX_PAGES}-page budget; no partial result is used.`);
}

async function queryAllChecked(context: InspectionContext, query: Record<string, unknown>, source: string, options: { key?: RowKey; mode?: string } = {}): Promise<Collection> {
  ensureValid(context);
  const result = await queryAll(context.game, { ...query, limit: PAGE_LIMIT, budgetMs: BUDGET_MS, maxNodes: MAX_NODES }, { sameTick: false, maxPages: MAX_PAGES });
  if (!result || !Array.isArray(result.items) || !Array.isArray(result.pages)) throw new CollectionError(`${source} queryAll returned no complete result.`);
  for (const [index, meta] of result.pages.entries()) noteMeta(context, meta, `${source}[page ${index + 1}]`);
  if (!Number.isInteger(result.total) || result.total < 0) throw new CollectionError(`${source} queryAll returned an invalid total.`);
  const deduped = dedupeRows(result.items, options.key ?? itemKey);
  const pageTotals = Array.isArray(result.totals) && result.totals.every((total: any) => Number.isInteger(total) && total >= 0)
    ? result.totals
    : result.pages.map((page: any) => page.total).filter((total: any) => Number.isInteger(total) && total >= 0);
  const finalCursorClosed = result.completeByCursor === true && result.nextCursor == null;
  const intermediateTruncated = result.pages.slice(0, -1).some((page: any) => page.truncated === true && page.nextCursor != null);
  const integrity = deriveCollectionIntegrity({
    total: result.total,
    returned: result.items.length,
    duplicatesRemoved: deduped.duplicatesRemoved,
    totals: pageTotals.length ? pageTotals : [result.total],
    finalCursorClosed,
    finalTruncated: result.truncated,
    truncatedFieldAvailable: result.truncatedFieldAvailable === true,
    intermediateTruncated,
  });
  return {
    ...integrity,
    items: deduped.items,
    total: result.total,
    returned: result.items.length,
    unique: deduped.items.length,
    duplicatesRemoved: deduped.duplicatesRemoved,
    dedupeMode: options.mode ?? 'item-id-or-row-value',
    anonymousRowsPreserved: deduped.anonymousRowsPreserved,
    completeByCursor: finalCursorClosed,
    pages: result.pages.map((meta: any, index: number) => ({ page: index + 1, ...meta, truncated: meta.truncated === true || meta.truncated === false ? meta.truncated : null, budgetMs: BUDGET_MS, maxNodes: MAX_NODES })),
    consistency: result.consistency === 'same-tick' ? 'same-tick' : 'mixed-ticks',
    request: collectionRequest(),
    error: integrity.complete ? undefined : { code: 'COLLECTION_PARTIAL', message: `${source} queryAll closed with incomplete evidence: ${integrity.truncationBasis}.` },
  };
}

function unknownSection(error: any): Record<string, unknown> {
  return { status: 'unknown', error: errorInfo(error) };
}

async function section<T>(context: InspectionContext, name: string, fn: () => Promise<T>): Promise<T | Record<string, unknown>> {
  if (context.invalidReason) return unknownSection(new BoundaryError('Inspection invalidated; later sections were not read.'));
  try {
    return await fn();
  } catch (error) {
    const info = errorInfo(error);
    if (error instanceof BoundaryError) context.invalidReason ??= { source: name, error: info };
    context.gaps.push({ key: `section:${name}`, section: name, error: info });
    return unknownSection(error);
  }
}

function readable(value: any, name: string): boolean {
  return readableFields(value).has(name);
}

function compactCondition(condition: any) {
  return { def: defName(condition?.def), part: defName(condition?.part) ?? condition?.part ?? null, severity: roundNumber(condition?.severity, 3) };
}

function compactPawn(pawn: any) {
  const workEntries = Object.entries(pawn?.work ?? {}) as Array<[string, any]>;
  const hasWork = pawn && pawn.work && typeof pawn.work === 'object';
  return {
    id: pawn?.id ?? null,
    name: pawn?.name ?? null,
    position: position(pawn?.position),
    job: defName(pawn?.currentJob?.def ?? pawn?.job) ?? pawn?.job ?? null,
    mentalState: defName(pawn?.mentalState),
    flags: { factionIsPlayer: pawn?.factionIsPlayer === true, humanlike: pawn?.humanlike === true, drafted: pawn?.drafted === true, downed: pawn?.downed === true, dead: pawn?.dead === true },
    needs: {
      food: roundNumber(pawn?.needs?.food),
      rest: roundNumber(pawn?.needs?.rest),
      mood: roundNumber(pawn?.needs?.mood),
      readable: { food: typeof pawn?.needs?.food === 'number', rest: typeof pawn?.needs?.rest === 'number', mood: typeof pawn?.needs?.mood === 'number' },
    },
    health: {
      summary: roundNumber(pawn?.health?.summary),
      conditions: Array.isArray(pawn?.health?.conditions) ? pawn.health.conditions.map(compactCondition) : null,
      readable: Boolean(pawn?.health && Object.prototype.hasOwnProperty.call(pawn.health, 'conditions')),
    },
    work: {
      disabled: hasWork ? workEntries.filter(([, value]) => value?.disabled === true).map(([name]) => name) : null,
      priorities: hasWork ? Object.fromEntries(workEntries.filter(([, value]) => Number(value?.priority) > 0).map(([name, value]) => [name, value.priority])) : null,
      readable: hasWork,
    },
    equipment: Array.isArray(pawn?.equipment) ? pawn.equipment.map((item: any) => ({ id: item?.id ?? item?.thingIDNumber ?? null, def: defName(item?.def) ?? item?.def ?? null })) : null,
  };
}

function asThingCandidate(row: any, category: string, roof: any, storage: any) {
  const def = String(row?.['def.defName'] ?? row?.def ?? 'unknown-def');
  const id = row?.thingIDNumber ?? row?.id ?? null;
  return {
    id: `${def}${id ?? 'unknown'}`,
    def,
    thingIDNumber: id,
    category,
    quantity: Number.isFinite(row?.stackCount) ? row.stackCount : null,
    position: position(row?.positionInt ?? row?.position),
    hitPointsInt: Number.isFinite(row?.hitPointsInt) ? row.hitPointsInt : null,
    roof,
    storage,
    facts: {
      defName: def,
      thingIDNumber: id,
      stackCount: Number.isFinite(row?.stackCount) ? row.stackCount : null,
      positionInt: position(row?.positionInt ?? row?.position),
      hitPointsInt: Number.isFinite(row?.hitPointsInt) ? row.hitPointsInt : null,
    },
  };
}

function foodOrHerbCategory(def: string): string | null {
  if (/^(MedicineHerbal|Medicine_)/i.test(def)) return 'herb-or-medicine-candidate';
  if (/^(Raw|Meat_|Meal|Pemmican|PackagedSurvivalMeal|NutrientPasteMeal|Kibble|Hay|Berries|AgaveFruit|Chocolate|InsectJelly|Ambrosia|Milk|Egg)/i.test(def)) return 'food-candidate';
  return null;
}

function plantCategory(def: string): string | null {
  if (/^Plant_/i.test(def)) return 'living-plant';
  return null;
}

function allItemCategory(def: string): string {
  return foodOrHerbCategory(def)
    ?? (/^(Wool|Leather|Cloth|Devilstrand|Synthread|Hyperweave|Textile|Fabric)/i.test(def) ? 'textile-or-leather'
      : likelyEquipment(def) ? 'equipment'
        : /^(Raw|Wood|Steel|Plasteel|Uranium|Jade|Silver|Gold|Component|Chunk|Stone|Chemfuel|Shell|MortarShell|PlantMatter)/i.test(def) ? 'raw-or-construction-material'
          : 'ground-item');
}

/** Return the row-major grid index used by roofGrid and regionGrid. */
export function mapGridIndex(positionValue: any, width: unknown, height: unknown): number | null {
  const p = position(positionValue);
  const mapWidth = finiteNumber(width);
  const mapHeight = finiteNumber(height);
  if (!p || !mapWidth || !mapHeight || !Number.isInteger(mapWidth) || !Number.isInteger(mapHeight) || mapWidth <= 0 || mapHeight <= 0) return null;
  if (p.x < 0 || p.z < 0 || p.x >= mapWidth || p.z >= mapHeight) return null;
  return p.z * mapWidth + p.x;
}

/** Harvested transport candidates come only from currentMap.items. */
export function splitTransportRows(itemRows: any[], thingRows: any[]) {
  const itemCandidates = itemRows
    .map(row => ({ row, category: foodOrHerbCategory(String(row?.['def.defName'] ?? '')) }))
    .filter(entry => entry.category);
  const excludedLivingItems = itemRows.filter(row => plantCategory(String(row?.['def.defName'] ?? '')));
  const allItemCandidates = itemRows
    .filter(row => !plantCategory(String(row?.['def.defName'] ?? '')))
    .map(row => ({ row, category: allItemCategory(String(row?.['def.defName'] ?? '')) }));
  const livingByDef = new Map<string, number>();
  let livingCount = 0;
  for (const row of thingRows) {
    const category = plantCategory(String(row?.['def.defName'] ?? ''));
    if (!category) continue;
    livingCount += 1;
    const def = String(row?.['def.defName'] ?? 'unknown-def');
    livingByDef.set(def, (livingByDef.get(def) ?? 0) + 1);
  }
  return {
    itemCandidates,
    allItemCandidates,
    excludedLivingItems: excludedLivingItems.map(row => ({ def: row?.['def.defName'] ?? null, thingIDNumber: row?.thingIDNumber ?? null })),
    livingPlants: {
      count: livingCount,
      byDef: Object.fromEntries([...livingByDef.entries()].sort(([a], [b]) => a.localeCompare(b))),
      excludedFromTransport: true,
      note: '所有Plant_*活植物来自currentMap.things，仅作数量背景；未列入任何地面物资搬运清单，也未查询其屋顶。',
    },
  };
}

/** Return every cell occupied by a building, including even-size rotation offsets. */
export function storageFootprintCells(positionValue: any, sizeValue: any, rotationValue: unknown): string[] {
  const p = position(positionValue);
  const sizeX = Number(sizeValue?.x);
  const sizeZ = Number(sizeValue?.z);
  const rotation = Number(rotationValue);
  if (!p || ![sizeX, sizeZ].every(value => Number.isInteger(value) && value > 0) || ![0, 1, 2, 3].includes(rotation)) return [];
  const width = rotation % 2 ? sizeZ : sizeX;
  const height = rotation % 2 ? sizeX : sizeZ;
  const offsets = [[0, 0], [0, -1], [-1, -1], [-1, 0]];
  const x = p.x + (width % 2 === 0 ? offsets[rotation][0] : 0);
  const z = p.z + (height % 2 === 0 ? offsets[rotation][1] : 0);
  const minX = x - Math.floor((width - 1) / 2);
  const minZ = z - Math.floor((height - 1) / 2);
  const cells: string[] = [];
  for (let dx = 0; dx < width; dx += 1) for (let dz = 0; dz < height; dz += 1) cells.push(`${minX + dx},${minZ + dz}`);
  return cells;
}

function likelyEquipment(def: string): boolean {
  return /Apparel|Helmet|Armor|Vest|Pants|Shirt|Duster|Jacket|Boot|Sandals|SMG|Gun|Rifle|Pistol|Bow|Melee|Weapon|Sword|Club|Spear|Knife|Grenade|Shield/i.test(def);
}

function roofState(value: unknown): boolean | null {
  if (value === undefined) return null;
  if (value === null) return false;
  if (typeof value !== 'string') return null;
  if (/^(None|NoRoof|RoofNone)$/i.test(value)) return false;
  if (/Roof/i.test(value)) return true;
  return null;
}

async function readPawns(context: InspectionContext) {
  ensureValid(context);
  const result = await context.game.state.pawns({ colonistsOnly: false, limit: 5000, budgetMs: 1000 });
  const data = checkResult(context, result, 'state.pawns');
  validateCompleteCollection(data);
  const residents = data.items.filter((pawn: any) => pawn?.factionIsPlayer === true && pawn?.humanlike === true);
  const expectedColonists = expectedColonistsForLease(context.lease);
  const expected = new Set(expectedColonists.map(pawn => pawn.id));
  const observed = new Set(residents.map((pawn: any) => pawn.id));
  const missing = [...expected].filter(id => !observed.has(id));
  const unexpected = residents.filter((pawn: any) => !expected.has(pawn.id)).map((pawn: any) => ({ id: pawn.id, name: pawn.name }));
  const truncatedFieldAvailable = Object.prototype.hasOwnProperty.call(data, 'truncated');
  const truncated = truncatedFieldAvailable ? data.truncated : false;
  return {
    status: 'complete',
    request: { colonistsOnly: false, limit: 5000, budgetMs: 1000 },
    total: data.total,
    returned: data.items.length,
    truncated,
    truncatedFieldAvailable,
    truncationBasis: truncatedFieldAvailable ? 'observed-false-after-pawns-total-check' : 'derived-pawns-total+closed-cursor',
    nextCursor: data.nextCursor ?? null,
    complete: true,
    residents,
    roster: { expected: expectedColonists, source: context.lease.expectedColonists === undefined ? 'default' : 'lease.expectedColonists', observed: residents.map((pawn: any) => ({ id: pawn.id, name: pawn.name })), missing, unexpected },
  };
}

function expectedColonistsForLease(lease: Record<string, unknown>): Array<{ id: string; name: string }> {
  if (lease.expectedColonists === undefined) return EXPECTED_COLONISTS.map(colonist => ({ ...colonist }));
  if (!Array.isArray(lease.expectedColonists)) throw new CollectionError('lease.expectedColonists must be an array of {id:string,name:string}.');
  return lease.expectedColonists.map((value: any, index: number) => {
    if (!value || typeof value.id !== 'string' || typeof value.name !== 'string') throw new CollectionError(`lease.expectedColonists[${index}] must contain string id and name.`);
    return { id: value.id, name: value.name };
  });
}

export function validateCompleteCollection(data: any) {
  if (!data || !Array.isArray(data.items)) throw new CollectionError('Collection returned no items array.');
  if (data.truncated === true) throw new CollectionError('Collection reported truncated=true.');
  if (data.nextCursor != null) throw new CollectionError(`Collection returned nextCursor=${String(data.nextCursor)}.`);
  if (!Number.isInteger(data.total) || data.total < 0) throw new CollectionError(`Collection returned invalid total=${String(data.total)}.`);
  if (data.items.length !== data.total) throw new CollectionError(`Collection returned ${data.items.length} items for total=${data.total}.`);
  return { total: data.total, returned: data.items.length, truncated: Object.prototype.hasOwnProperty.call(data, 'truncated') ? data.truncated : null };
}

async function readMapRoot(context: InspectionContext) {
  const mapResult = await context.game.state.map();
  const mapData = checkResult(context, mapResult, 'state.map');
  const width = finiteNumber(mapData.width);
  const height = finiteNumber(mapData.height);
  if (!width || !height || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new CollectionError('state.map returned no reliable positive integer width/height.');
  const mapId = typeof mapData.id === 'string' ? mapData.id : mapResult.meta.mapId;
  if (typeof mapData.id === 'string' && typeof mapResult.meta.mapId === 'string' && mapData.id !== mapResult.meta.mapId) throw new BoundaryError('state.map data.id did not match its observation metadata mapId.');
  if (context.mapId == null && typeof mapId === 'string') context.mapId = mapId;

  const result = await context.game.state.roots();
  const data = checkResult(context, result, 'state.roots');
  const mapRefFromMap = asRef(mapData.reference ?? mapData.ref);
  const mapRefFromRoots = asRef(data.currentMap);
  if (mapRefFromMap && mapRefFromRoots && mapRefFromMap.id !== mapRefFromRoots.id) throw new BoundaryError('state.map and state.roots returned different current map references.');
  const mapRef = mapRefFromMap ?? mapRefFromRoots;
  if (!mapRef) throw new CollectionError('state.roots did not return a currentMap reference.');
  const descriptionResult = await context.game.state.describe(mapRef);
  const description = checkResult(context, descriptionResult, 'state.describe(currentMap)');
  context.mapWidth = width;
  context.mapHeight = height;
  const readable = [...readableFields(description)];
  return {
    status: 'complete',
    id: mapId,
    reference: mapRef,
    type: description.type ?? mapRef.type,
    readableFields: readable.filter(field => ['regionGrid', 'roofGrid', 'zoneManager'].includes(field)),
    grid: { width, height, source: 'state.map width/height', indexFormula: 'z * width + x' },
  };
}

async function readRooms(context: InspectionContext) {
  return scanPages(context, { root: 'currentMap', path: 'regionGrid.allRooms', derived: false, fields: ['ID', 'role.defName', 'tempTracker.temperatureInt', 'cachedOpenRoofCount', 'cachedCellCount'] }, 'currentMap.regionGrid.allRooms');
}

async function readPawnRooms(context: InspectionContext, residents: any[], mapRef: ObjectRef) {
  const width = context.mapWidth;
  const height = context.mapHeight;
  if (!width || !height) throw new CollectionError('Map dimensions are unknown; resident room indices were not read.');
  const fields: string[] = [];
  const fieldByPawn = new Map<string, string>();
  for (const pawn of residents) {
    const p = position(pawn.position);
    const index = mapGridIndex(p, width, height);
    if (index === null) continue;
    const field = `regionGrid.regionGrid.${index}.districtInt.roomInt`;
    fieldByPawn.set(pawn.id, field);
    if (!fields.includes(field)) fields.push(field);
  }
  if (!fields.length) return { status: 'unknown', error: { code: 'ROOM_POSITION_UNKNOWN', message: 'No resident positions were readable.' } };
  const result = await context.game.state.read(mapRef, { fields, budgetMs: BUDGET_MS, maxNodes: MAX_NODES });
  const data = checkResult(context, result, 'currentMap.regionGrid pawn room lookup');
  const refs = new Map<string, ObjectRef>();
  const roomByPawn: any[] = [];
  for (const pawn of residents) {
    const field = fieldByPawn.get(pawn.id);
    const ref = field ? asRef(data.fields?.[field]) : null;
    if (ref) refs.set(ref.id, ref);
    roomByPawn.push({ pawnId: pawn.id, roomRef: ref ? { id: ref.id, type: ref.type } : null });
  }
  const roomDetails = new Map<string, any>();
  for (const ref of refs.values()) {
    const roomResult = await context.game.state.read(ref, { fields: ['ID', 'role.defName', 'tempTracker.temperatureInt', 'cachedOpenRoofCount', 'cachedCellCount'], depth: 0, budgetMs: BUDGET_MS, maxNodes: MAX_NODES });
    const roomData = checkResult(context, roomResult, `room ${ref.id}`);
    roomDetails.set(ref.id, { id: roomData.fields?.ID ?? null, role: defName(roomData.fields?.['role.defName']) ?? roomData.fields?.['role.defName'] ?? null, temperature: roundNumber(roomData.fields?.['tempTracker.temperatureInt'], 2), cachedOpenRoofCount: roomData.fields?.cachedOpenRoofCount ?? null, cachedCellCount: roomData.fields?.cachedCellCount ?? null });
  }
  return { status: 'complete', mapRef: mapRef.id, residents: roomByPawn.map(row => ({ ...row, room: row.roomRef ? roomDetails.get(row.roomRef.id) ?? null : null })) };
}

function isStorageBuildingDef(def: string): boolean {
  return /^(Shelf|Hopper|DeepStorageUnit|Storage)/i.test(def);
}

function positionFromKey(key: string): { x: number; y: number; z: number } | null {
  const [x, z] = key.split(',').map(Number);
  return Number.isInteger(x) && Number.isInteger(z) ? { x, y: 0, z } : null;
}

function storageScanSummary(scan: any) {
  if (!scan || typeof scan !== 'object') return { status: 'unknown' };
  return {
    status: scan.status ?? 'unknown',
    total: scan.total ?? null,
    returned: scan.returned ?? 0,
    unique: scan.unique ?? 0,
    duplicatesRemoved: scan.duplicatesRemoved ?? 0,
    pages: Array.isArray(scan.pages) ? scan.pages.length : 0,
    completeByCursor: scan.completeByCursor ?? false,
    complete: scan.complete ?? false,
    truncated: scan.truncated ?? null,
    truncatedFieldAvailable: scan.truncatedFieldAvailable ?? false,
    truncationBasis: scan.truncationBasis ?? null,
    consistency: scan.consistency ?? 'unknown',
    collectionChanged: scan.collectionChanged ?? false,
    request: scan.request ?? collectionRequest(),
    error: scan.error,
  };
}

async function readZones(context: InspectionContext) {
  const result = await context.game.state.read('currentMap', { path: 'zoneManager.allZones', depth: 0, budgetMs: BUDGET_MS, maxNodes: MAX_NODES });
  const data = checkResult(context, result, 'currentMap.zoneManager.allZones');
  if (!Array.isArray(data.items)) throw new CollectionError('zoneManager.allZones returned no items array.');
  const zones = data.items.filter((zone: any) => asRef(zone));
  const stockpiles = zones.filter((zone: any) => String(zone.type).endsWith('Zone_Stockpile'));
  const cells = new Set<string>();
  const stockpileCells = new Set<string>();
  const storageBuildingCells = new Set<string>();
  const records: any[] = [];
  const errors: any[] = [];
  let descriptorChecked = false;
  for (const zone of stockpiles) {
    try {
      if (!descriptorChecked) {
        const descriptionResult = await context.game.state.describe(zone);
        const description = checkResult(context, descriptionResult, `state.describe(${zone.type})`);
        if (!readable(description, 'cells')) throw new CollectionError(`${zone.type} has no readable cells field.`);
        descriptorChecked = true;
      }
      const zoneResult = await context.game.state.read(zone, { fields: ['ID', 'cells'], depth: 1, budgetMs: BUDGET_MS, maxNodes: MAX_NODES });
      const zoneData = checkResult(context, zoneResult, `stockpile ${zone.id}`);
      const zoneCells = collectionItems(zoneData.fields?.cells);
      if (!zoneCells) throw new CollectionError(`stockpile ${zone.id} returned no cells items.`);
      let invalidCellCount = 0;
      for (const cell of zoneCells) {
        if (Number.isFinite(cell?.x) && Number.isFinite(cell?.z)) {
          const key = `${cell.x},${cell.z}`;
          stockpileCells.add(key);
          cells.add(key);
        } else invalidCellCount += 1;
      }
      if (invalidCellCount) {
        const error = { code: 'STOCKPILE_CELL_UNKNOWN', message: `stockpile ${zone.id} returned ${invalidCellCount} cells without numeric x/z.` };
        errors.push({ id: zone.id, type: zone.type, error });
        context.gaps.push({ key: `stockpile-cells:${zone.id}`, section: 'stockpile-cells', error });
      }
      records.push({ id: zoneData.fields?.ID ?? null, reference: zone.id, type: zone.type, cellCount: zoneCells.length });
    } catch (error) {
      errors.push({ id: zone.id, type: zone.type, error: errorInfo(error) });
      context.gaps.push({ key: `stockpile:${zone.id}`, section: 'stockpile-cells', error: errorInfo(error) });
    }
  }
  const buildingScan = await scanPages(context, {
    root: 'currentMap.buildings',
    derived: false,
    fields: ['def.defName', 'thingIDNumber', 'positionInt', 'def.size.x', 'def.size.z', 'rotationInt.rotInt'],
  }, 'currentMap.buildings for storage coverage');
  const storageByCell = new Map<string, any[]>();
  const storageRecords: any[] = [];
  const storageRows = (buildingScan.items ?? []).filter((row: any) => isStorageBuildingDef(String(row?.['def.defName'] ?? '')));
  for (const row of storageRows) {
    const def = String(row?.['def.defName'] ?? 'unknown-def');
    const id = row?.thingIDNumber ?? null;
    const buildingPosition = position(row?.positionInt);
    const size = { x: row?.['def.size.x'] ?? null, z: row?.['def.size.z'] ?? null };
    const rotation = row?.['rotationInt.rotInt'] ?? null;
    const footprintKeys = storageFootprintCells(buildingPosition, size, rotation);
    if (!footprintKeys.length) {
      const error = { code: 'STORAGE_FOOTPRINT_UNKNOWN', message: `${def}${String(id)} lacks a valid position, size or rotation.` };
      errors.push({ id, type: def, error });
      context.gaps.push({ key: `storage-footprint:${def}${String(id)}`, section: 'storage-building-footprints', error });
      continue;
    }
    const record = {
      id: `${def}${String(id)}`,
      def,
      thingIDNumber: id,
      position: buildingPosition,
      size,
      rotation,
      footprint: footprintKeys.map(positionFromKey).filter(Boolean),
      footprintSource: 'currentMap.buildings positionInt + def.size + rotationInt.rotInt; full occupied rectangle including rotation offsets',
    };
    storageRecords.push(record);
    for (const key of footprintKeys) {
      cells.add(key);
      storageBuildingCells.add(key);
      const owners = storageByCell.get(key) ?? [];
      owners.push({ id: record.id, def: record.def, thingIDNumber: record.thingIDNumber });
      storageByCell.set(key, owners);
    }
  }
  if (buildingScan.status !== 'complete') {
    errors.push({ type: 'currentMap.buildings', error: buildingScan.error ?? { code: 'STORAGE_BUILDINGS_PARTIAL', message: 'Storage building pagination did not close with complete evidence.' } });
    context.gaps.push({ key: 'storage-buildings', section: 'storage-building-footprints', error: buildingScan.error ?? { code: 'STORAGE_BUILDINGS_PARTIAL', message: 'Storage building pagination did not close with complete evidence.' } });
  }
  const status = errors.length ? 'partial' : 'complete';
  return {
    status,
    zoneCount: zones.length,
    stockpileCount: stockpiles.length,
    records,
    knownStockpileCellCount: stockpileCells.size,
    knownStorageBuildingCount: storageRecords.length,
    knownStorageBuildingCellCount: storageRecords.reduce((sum, record) => sum + (record.footprint?.length ?? 0), 0),
    stockpileCells: [...stockpileCells],
    storageBuildingCells: [...storageBuildingCells],
    cells: [...cells],
    storage: { status: buildingScan.status === 'complete' && !errors.length ? 'complete' : 'partial', buildingCount: storageRows.length, records: storageRecords, cellCount: new Set(storageRecords.flatMap(record => (record.footprint ?? []).map((cell: any) => `${cell.x},${cell.z}`))).size, scan: storageScanSummary(buildingScan) },
    storageByCell: Object.fromEntries([...storageByCell.entries()]),
    truncated: false,
    truncatedFieldAvailable: false,
    truncationBasis: 'direct-zone-read+closed-building-query',
    errors,
  };
}

async function readRoof(context: InspectionContext, mapRef: ObjectRef, positions: any[], width: number | null, height: number | null) {
  if (!width || !height) throw new CollectionError('Map dimensions are unknown; roofGrid indices were not generated.');
  const unique = new Map<string, { x: number; z: number }>();
  let invalidPositionCount = 0;
  for (const value of positions) {
    const p = position(value);
    if (!p || mapGridIndex(p, width, height) === null) {
      invalidPositionCount += 1;
      continue;
    }
    unique.set(`${p.x},${p.z}`, { x: p.x, z: p.z });
  }
  const records = new Map<string, any>();
  const values = [...unique.values()];
  const errors: any[] = [];
  if (invalidPositionCount) errors.push({ code: 'ROOF_POSITION_UNKNOWN', message: `${invalidPositionCount} requested positions were missing or outside the state.map dimensions.` });
  for (let start = 0; start < values.length; start += 500) {
    const chunk = values.slice(start, start + 500);
    const fields = chunk.map(p => `roofGrid.roofGrid.${mapGridIndex(p, width, height)}.defName`);
    const result = await context.game.state.read(mapRef, { fields, budgetMs: BUDGET_MS, maxNodes: MAX_NODES });
    const data = checkResult(context, result, `currentMap.roofGrid chunk ${Math.floor(start / 500) + 1}`);
    for (const p of chunk) {
      const field = `roofGrid.roofGrid.${mapGridIndex(p, width, height)}.defName`;
      const raw = Object.prototype.hasOwnProperty.call(data.fields ?? {}, field) ? data.fields[field] : undefined;
      const roofed = roofState(raw === undefined ? undefined : raw);
      records.set(`${p.x},${p.z}`, { defName: raw === undefined ? null : raw, roofed });
      if (raw === undefined) errors.push({ code: 'ROOF_FIELD_UNKNOWN', message: `${field} was not returned by state.read.` });
      else if (roofed === null) errors.push({ code: 'ROOF_VALUE_UNKNOWN', message: `${field} returned an unrecognised roof value.` });
    }
  }
  return { status: errors.length ? 'partial' : 'complete', complete: errors.length === 0, positionCount: values.length, requestedPositionCount: positions.length, invalidPositionCount, byPosition: Object.fromEntries(records), field: 'roofGrid.roofGrid.<z * state.map.width + x>.defName', unknownCount: [...records.values()].filter(record => record.roofed === null).length, errors };
}

export function storageEvidence(category: string, key: string | null, storageCoverage: any) {
  if (category === 'living-plant') return {
    status: 'not-applicable',
    inKnownStorageFootprint: null,
    inKnownStockpileCell: null,
    inStorageBuildingFootprint: null,
    storageBuildings: [],
    interpretation: '活植物不是currentMap.items搬运候选，不应用储存覆盖判断',
  };
  if (!(storageCoverage?.cells instanceof Set)) return {
    status: 'unknown',
    inKnownStorageFootprint: null,
    inKnownStockpileCell: null,
    inStorageBuildingFootprint: null,
    storageBuildings: [],
    interpretation: '储存覆盖读取失败；没有把缺口当作露天或已保护',
  };
  const stockpileCells = storageCoverage.stockpileCells instanceof Set ? storageCoverage.stockpileCells : null;
  const storageBuildingCells = storageCoverage.storageBuildingCells instanceof Set ? storageCoverage.storageBuildingCells : null;
  const inKnownStorageFootprint = key ? storageCoverage.cells.has(key) : null;
  const inKnownStockpileCell = key && stockpileCells ? stockpileCells.has(key) : null;
  const inStorageBuildingFootprint = key && storageBuildingCells ? storageBuildingCells.has(key) : null;
  return {
    status: storageCoverage.status === 'complete' ? 'known-storage-footprint-check' : 'partial-storage-footprint-check',
    inKnownStorageFootprint,
    inKnownStockpileCell,
    inStorageBuildingFootprint,
    storageBuildings: key ? (storageCoverage.byCell?.[key] ?? []) : [],
    interpretation: inStorageBuildingFootprint === true
      ? '货架/储物建筑真实占地证据；仍单独保留roofed天气证据'
      : inKnownStockpileCell === true
        ? 'stockpile覆盖证据；stockpile本身不等于防雨'
        : '不在已知stockpile或储物建筑占地；筛选、预留和可达性未读取',
  };
}

export function deriveItemExposure(roof: any, storage: any) {
  const roofed = roof?.roofed === true ? true : roof?.roofed === false ? false : null;
  return {
    roofed,
    roofDefName: roof?.defName ?? null,
    weatherProtected: roofed,
    exposure: roofed === true ? 'sheltered' : roofed === false ? 'exposed' : 'unknown',
    inKnownStockpileCell: storage?.inKnownStockpileCell ?? null,
    inStorageBuildingFootprint: storage?.inStorageBuildingFootprint ?? null,
    interpretation: roofed === false
      ? storage?.inKnownStockpileCell === true
        ? 'roofed=false仍是天气暴露；stockpile覆盖不防雨'
        : storage?.inStorageBuildingFootprint === true
          ? 'roofed=false；储物建筑占地另有证据，天气保护仍unknown/false需按屋顶字段判断'
          : 'roofed=false提供无屋顶证据'
      : roofed === true
        ? 'roofed=true提供有屋顶证据；不推断储物筛选、预留或可达性'
        : '屋顶字段unknown；不把储存覆盖当作天气保护',
  };
}

function nestedItems(value: any): any[] | null {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.items)) return value.items;
  if (value?.fields && Array.isArray(value.fields.items)) return value.fields.items;
  return null;
}

function namedValue(row: any, ...names: string[]): unknown {
  return fieldValue(row, ...names);
}

function statDefName(value: any): string | null {
  if (typeof value === 'string') return value;
  const name = fieldValue(value, 'defName', 'stat.defName', 'def.defName');
  return typeof name === 'string' ? name : null;
}

function statName(row: any): string | null {
  const stat = namedValue(row, 'stat', 'def');
  return statDefName(stat) ?? statDefName(namedValue(row, 'stat.defName', 'def.defName'));
}

function statValue(row: any): number | null {
  return finiteNumber(namedValue(row, 'value', 'baseValue', 'valueFloat'));
}

function statNumber(rows: any[], pattern: RegExp): { value: number; name: string } | null {
  for (const row of rows) {
    const name = statName(row);
    const value = statValue(row);
    if (name && value !== null && pattern.test(name)) return { value, name };
  }
  return null;
}

type DefConditionRecord = {
  def: string;
  status: 'complete' | 'partial' | 'unknown';
  useHitPoints: boolean | null;
  baseMaxHitPoints: number | null;
  baseMaxHitPointsSource: string | null;
  actualMaxHitPoints: number | null;
  actualMaxHitPointsSource: string | null;
  actualMaxHitPointsStatus: 'known' | 'not-read-material-quality' | 'unknown';
  // Compatibility aliases: these mean the base Def statistic, never an
  // effective material/quality-adjusted item value.
  maxHitPoints: number | null;
  maxHitPointsSource: string | null;
  deteriorationRate: number | null;
  deteriorationRateSource: string | null;
  fields: string[];
  errors: Array<{ code: string; message: string }>;
};

async function readNestedDefRows(context: InspectionContext, value: any, source: string): Promise<any[] | null> {
  const direct = nestedItems(value);
  if (direct) return direct;
  const ref = asRef(value);
  if (!ref) return null;
  const result = await context.game.state.read(ref, { depth: 3, budgetMs: BUDGET_MS, maxNodes: MAX_NODES });
  const data = checkResult(context, result, source);
  const rows = nestedItems(data);
  if (!rows) throw new CollectionError(`${source} returned no readable item list.`);
  return rows;
}

async function readStatDefName(context: InspectionContext, value: any, source: string): Promise<string> {
  const direct = statDefName(value);
  if (direct) return direct;
  const ref = asRef(value);
  if (!ref) throw new CollectionError(`${source} returned a StatDef without defName.`);
  const result = await context.game.state.read(ref, { fields: ['defName'], depth: 0, budgetMs: BUDGET_MS, maxNodes: MAX_NODES });
  const data = checkResult(context, result, source);
  const name = statDefName(data);
  if (!name) throw new CollectionError(`${source} returned a StatDef without defName.`);
  return name;
}

async function resolveStatModifier(context: InspectionContext, value: any, source: string): Promise<any> {
  let row = value;
  const modifierRef = asRef(value);
  if (modifierRef) {
    const result = await context.game.state.read(modifierRef, { fields: ['stat', 'value'], depth: 1, budgetMs: BUDGET_MS, maxNodes: MAX_NODES });
    row = checkResult(context, result, source);
  }
  const statValueField = namedValue(row, 'stat', 'def', 'stat.defName', 'def.defName');
  const name = statDefName(statValueField) ?? await readStatDefName(context, statValueField, `${source}.stat`);
  const numericValue = statValue(row);
  if (numericValue === null) throw new CollectionError(`${source} returned a StatModifier without numeric value.`);
  return { stat: name, value: numericValue };
}

async function readStatRows(context: InspectionContext, value: any, source: string): Promise<{ rows: any[]; errors: Array<{ code: string; message: string }> }> {
  const rawRows = await readNestedDefRows(context, value, source);
  if (!rawRows) throw new CollectionError(`${source} returned no readable StatModifier list.`);
  const rows: any[] = [];
  const errors: Array<{ code: string; message: string }> = [];
  for (let index = 0; index < rawRows.length; index += 1) {
    try {
      rows.push(await resolveStatModifier(context, rawRows[index], `${source}[${index}]`));
    } catch (error) {
      const info = errorInfo(error);
      errors.push({ code: info.code, message: `${source}[${index}]: ${info.message}` });
    }
  }
  return { rows, errors };
}

async function parseDefCondition(context: InspectionContext, row: any, def: string): Promise<DefConditionRecord> {
  const errors: Array<{ code: string; message: string }> = [];
  const useHitPoints = booleanValue(namedValue(row, 'useHitPoints'));
  const statBasesValue = namedValue(row, 'statBases');
  let stats: any[] = [];
  if (statBasesValue !== undefined && statBasesValue !== null) {
    try {
      const read = await readStatRows(context, statBasesValue, `ThingDef.statBases ${def}`);
      stats = read.rows;
      errors.push(...read.errors);
    } catch (error) {
      errors.push(errorInfo(error));
    }
  }
  const max = statNumber(stats, /^MaxHitPoints$/i);
  const deterioration = statNumber(stats, /DeteriorationRate/i);
  if (useHitPoints === true && max === null) errors.push({ code: 'DEF_MAX_HITPOINTS_UNKNOWN', message: `${def} uses hit points but its statBases did not expose a MaxHitPoints StatModifier.` });
  else if (useHitPoints === null && max === null) errors.push({ code: 'DEF_DURABILITY_UNKNOWN', message: `${def} did not expose useHitPoints or a MaxHitPoints StatModifier.` });
  return {
    def,
    status: errors.length ? 'partial' : 'complete',
    useHitPoints,
    baseMaxHitPoints: max?.value ?? null,
    baseMaxHitPointsSource: max ? `ThingDef.statBases.${max.name}` : null,
    actualMaxHitPoints: null,
    actualMaxHitPointsSource: null,
    actualMaxHitPointsStatus: 'not-read-material-quality',
    maxHitPoints: max?.value ?? null,
    maxHitPointsSource: max ? `ThingDef.statBases.${max.name}` : null,
    deteriorationRate: deterioration?.value ?? null,
    deteriorationRateSource: deterioration ? `ThingDef.statBases.${deterioration.name}` : null,
    fields: DEF_CONDITION_FIELDS.filter(field => namedValue(row, field) !== undefined),
    errors,
  };
}

async function readDefConditionCache(context: InspectionContext, itemRows: any[]) {
  const defs = [...new Set(itemRows.map(row => String(row?.['def.defName'] ?? '')).filter(Boolean))].sort();
  if (!defs.length) return { status: 'complete', requestedDefs: [], records: {}, cacheSize: 0, errors: [], note: 'currentMap.items returned no definition names' };
  const results = await mapLimit(defs, 6, async (def: string) => {
    try {
      ensureValid(context);
      const result = await context.game.state.query({ root: 'defs', type: 'Verse.ThingDef', where: { defName: def }, derived: false, fields: DEF_CONDITION_FIELDS, limit: 2, budgetMs: BUDGET_MS, maxNodes: MAX_NODES });
      const data = checkResult(context, result, `ThingDef condition ${def}`);
      if (!Array.isArray(data.items) || data.items.length !== 1 || data.total !== 1 || data.nextCursor != null) throw new CollectionError(`ThingDef condition ${def} did not return exactly one complete definition row.`);
      return { def, record: await parseDefCondition(context, data.items[0], def) };
    } catch (error) {
      return { def, error: errorInfo(error) };
    }
  });
  const records: Record<string, DefConditionRecord> = {};
  const errors: any[] = [];
  for (const result of results) {
    if (result.error) errors.push({ def: result.def, error: result.error });
    else {
      records[result.def] = result.record;
      for (const error of result.record.errors) errors.push({ def: result.def, error });
    }
  }
  return { status: errors.length ? 'partial' : 'complete', requestedDefs: defs, records, cacheSize: Object.keys(records).length, errors, note: '每个def只读一次ThingDef字段；statBases按内联或ObjectRef列表逐项读取StatModifier.stat/value和StatDef.defName，未调用getter' };
}

export function deriveItemCondition(row: any, defInfo: any = null) {
  const hitPointsInt = finiteNumber(row?.hitPointsInt);
  const useHitPoints = booleanValue(defInfo?.useHitPoints);
  const directBaseMax = finiteNumber(row?.baseMaxHitPoints);
  const configuredBaseMax = finiteNumber(defInfo?.baseMaxHitPoints ?? defInfo?.maxHitPoints);
  const baseMaxHitPoints = configuredBaseMax ?? directBaseMax;
  const baseMaxHitPointsSource = configuredBaseMax !== null
    ? (defInfo?.baseMaxHitPointsSource ?? defInfo?.maxHitPointsSource ?? 'ThingDef.statBases.MaxHitPoints')
    : directBaseMax !== null ? 'row.baseMaxHitPoints' : null;
  const actualCandidates: Array<{ value: unknown; source: string }> = [
    { value: row?.actualMaxHitPoints, source: 'row.actualMaxHitPoints' },
    { value: row?.effectiveMaxHitPoints, source: 'row.effectiveMaxHitPoints' },
    { value: row?.maxHitPoints, source: 'row.maxHitPoints' },
    { value: row?.maxHP, source: 'row.maxHP' },
    { value: defInfo?.actualMaxHitPoints, source: defInfo?.actualMaxHitPointsSource ?? 'item-effective-maxHitPoints' },
  ];
  const actualCandidate = actualCandidates.find(candidate => finiteNumber(candidate.value) !== null && (finiteNumber(candidate.value) as number) > 0);
  const actualMaxHitPoints = actualCandidate ? finiteNumber(actualCandidate.value) : null;
  const actualMaxHitPointsSource = actualCandidate?.source ?? null;
  const actualMaxHitPointsStatus: 'known' | 'not-read-material-quality' | 'unknown' = actualMaxHitPoints !== null
    ? 'known'
    : defInfo?.actualMaxHitPointsStatus === 'not-read-material-quality' || defInfo?.actualMaxHitPointsStatus === 'unknown'
      ? defInfo.actualMaxHitPointsStatus
      : baseMaxHitPoints !== null ? 'not-read-material-quality' : 'unknown';
  const def = String(defInfo?.def ?? row?.['def.defName'] ?? row?.def ?? '');
  const equipment = likelyEquipment(def);
  const baseMaxIsUsableForRatio = baseMaxHitPoints !== null && baseMaxHitPoints > 0 && !equipment;
  const comparisonMax = actualMaxHitPoints ?? (baseMaxIsUsableForRatio ? baseMaxHitPoints : null);
  const maxHitPointsBasis = hitPointsInt !== null && hitPointsInt < 0
    ? 'not-applicable'
    : useHitPoints === false
      ? 'not-applicable'
      : actualMaxHitPoints !== null
        ? 'item-effective'
        : baseMaxIsUsableForRatio
          ? 'base-def-resource-like'
          : baseMaxHitPoints !== null
            ? 'base-def-only'
            : 'unknown';
  const maxHitPoints = comparisonMax;
  const maxHitPointsSource = actualMaxHitPoints !== null
    ? actualMaxHitPointsSource
    : baseMaxIsUsableForRatio ? baseMaxHitPointsSource : null;
  const deteriorationRate = finiteNumber(defInfo?.deteriorationRate);
  const maxHitPointsStatus = hitPointsInt !== null && hitPointsInt < 0
    ? 'not-applicable'
    : useHitPoints === false && maxHitPoints === null
      ? 'not-applicable'
      : maxHitPoints !== null && maxHitPoints > 0
        ? 'known'
        : 'unknown';
  const validCurrentHP = hitPointsInt !== null && hitPointsInt >= 0;
  const ratio = validCurrentHP && maxHitPointsStatus === 'known' ? hitPointsInt / (maxHitPoints as number) : null;
  const baseRatio = validCurrentHP && baseMaxHitPoints !== null && baseMaxHitPoints > 0 ? hitPointsInt / baseMaxHitPoints : null;
  const ratioIsAccurate = actualMaxHitPoints !== null && ratio !== null;
  const lowRatio = ratio !== null && ratio <= LOW_DURABILITY_RATIO;
  const baseLowDurability = baseRatio !== null && baseRatio <= LOW_DURABILITY_RATIO;
  const isDamaged = validCurrentHP && actualMaxHitPoints !== null && hitPointsInt < actualMaxHitPoints;
  const baseDamagedCandidate = validCurrentHP && actualMaxHitPoints === null && baseRatio !== null && baseRatio < 1;
  const baseIntactCandidate = validCurrentHP && actualMaxHitPoints === null && baseRatio !== null && baseRatio >= 1;
  const lowDurability = lowRatio && (actualMaxHitPoints !== null || baseMaxIsUsableForRatio);
  const damageStatus = !validCurrentHP
    ? hitPointsInt === null ? 'unknown' : 'not-applicable'
    : useHitPoints === false
      ? 'not-applicable'
      : actualMaxHitPoints !== null && maxHitPointsStatus === 'known'
        ? lowDurability ? 'low' : isDamaged ? 'damaged' : 'intact'
        : baseMaxIsUsableForRatio
          ? lowDurability ? 'low' : baseDamagedCandidate ? 'base-damaged-candidate' : baseIntactCandidate ? 'base-intact-candidate' : 'unknown'
          : baseMaxHitPoints !== null && baseLowDurability ? 'base-low-candidate'
            : baseDamagedCandidate ? 'base-damaged-candidate'
              : hitPointsInt <= 50 ? 'absolute-low-candidate' : 'unknown';
  const conditionStatus = damageStatus === 'unknown' || maxHitPointsStatus === 'unknown'
    ? 'unknown'
    : actualMaxHitPoints !== null || maxHitPointsBasis === 'not-applicable'
      ? 'complete'
      : 'partial';
  return {
    status: conditionStatus,
    hitPointsInt,
    currentHitPoints: hitPointsInt,
    maxHitPoints: maxHitPoints ?? 'unknown',
    maxHitPointsStatus,
    maxHitPointsSource,
    baseMaxHitPoints: baseMaxHitPoints ?? 'unknown',
    baseMaxHitPointsSource,
    actualMaxHitPoints: actualMaxHitPoints ?? 'unknown',
    actualMaxHitPointsSource,
    actualMaxHitPointsStatus,
    maxHitPointsBasis,
    ratioIsAccurate,
    baseHealthRatio: baseRatio === null ? null : roundNumber(baseRatio, 4),
    healthRatio: ratio === null ? null : roundNumber(ratio, 4),
    thresholdRatio: LOW_DURABILITY_RATIO,
    lowDurability,
    baseLowDurability,
    isDamaged,
    baseDamagedCandidate,
    damageStatus,
    deterioration: {
      status: deteriorationRate !== null ? 'known' : 'unknown',
      rate: deteriorationRate,
      source: defInfo?.deteriorationRateSource ?? null,
    },
    evidence: hitPointsInt !== null && hitPointsInt < 0
      ? 'hitPointsInt<0 sentinel; no damage alert'
      : actualMaxHitPoints !== null
        ? 'current hitPointsInt compared with item material/quality-adjusted effective maxHitPoints'
        : baseMaxIsUsableForRatio
          ? 'current hitPointsInt compared with base ThingDef.statBases.MaxHitPoints; effective material/quality maxHP was not read'
        : hitPointsInt !== null
          ? 'absolute hitPointsInt only; reliable comparable maxHP unavailable'
          : 'hitPointsInt unreadable',
  };
}

export function formatGroundItemChecklist(item: any): string {
  const condition = item?.condition ?? {};
  const exposure = item?.exposure ?? {};
  const storage = item?.storage ?? {};
  const itemPosition = position(item?.position);
  const location = itemPosition ? `(${itemPosition.x},${itemPosition.z})` : '位置未知';
  const ratio = typeof condition.healthRatio === 'number' ? `${(condition.healthRatio * 100).toFixed(1)}%` : 'unknown';
  return `${item?.id ?? `${item?.def ?? 'unknown'}${item?.thingIDNumber ?? 'unknown'}`} ${item?.def ?? 'unknown'}×${item?.quantity ?? 'unknown'} ${location} HP=${condition.hitPointsInt ?? 'unknown'}/${condition.maxHitPoints ?? 'unknown'} roofed=${exposure.roofed ?? item?.roof?.roofed ?? 'unknown'} shelf=${storage.inStorageBuildingFootprint ?? 'unknown'} stockpile=${storage.inKnownStockpileCell ?? 'unknown'} level=${item?.riskLevel ?? condition.damageStatus ?? 'unknown'} baseMax=${condition.baseMaxHitPoints ?? 'unknown'} actualMax=${condition.actualMaxHitPoints ?? 'unknown'} basis=${condition.maxHitPointsBasis ?? 'unknown'} ratio=${ratio} ratioAccurate=${condition.ratioIsAccurate ?? false}`;
}

export function classifyItemRisk(item: any): { severity: 'important' | 'watch'; reason: string } | null {
  const condition = item?.condition ?? {};
  const roofed = item?.exposure?.roofed ?? item?.roof?.roofed ?? null;
  const damageStatus = condition.damageStatus;
  const deteriorationRate = finiteNumber(condition.deterioration?.rate);
  if (damageStatus === 'low') return roofed === false
    ? { severity: 'important', reason: 'low-durability+unroofed' }
    : { severity: 'watch', reason: roofed === true ? 'low-durability-under-roof' : 'low-durability+roof-unknown' };
  if (damageStatus === 'base-low-candidate') return { severity: 'watch', reason: roofed === false ? 'base-low-candidate+unroofed' : 'base-low-candidate' };
  if (damageStatus === 'damaged' || damageStatus === 'absolute-low-candidate' || damageStatus === 'base-damaged-candidate') return { severity: 'watch', reason: roofed === false ? 'damaged+unroofed' : 'damaged-or-absolute-low' };
  if (roofed === false && deteriorationRate !== null && deteriorationRate > 0) return { severity: 'watch', reason: 'deteriorable+unroofed' };
  return null;
}

function enrichAllItem(row: any, category: string, roofByPosition: Record<string, any>, storageCoverage: any, defInfo: any) {
  const key = positionKey(row?.positionInt ?? row?.position);
  const roof = key && roofByPosition[key] ? roofByPosition[key] : { defName: null, roofed: null };
  const storage = storageEvidence(category, key, storageCoverage);
  const base = asThingCandidate(row, category, roof, storage);
  const condition = deriveItemCondition(row, defInfo);
  const exposure = deriveItemExposure(roof, storage);
  const item = { ...base, kind: 'ground-item', exposure, condition };
  const risk = classifyItemRisk(item);
  return { ...item, riskLevel: risk?.severity ?? null, riskReason: risk?.reason ?? null };
}

function allItemExposureSection(itemScan: any, itemRows: any[], transport: any, roof: any, storageCoverage: any, defConditions: any) {
  if (!itemScan || itemScan.status === 'unknown') return { status: 'unknown', complete: false, total: null, returned: 0, unique: 0, items: [], alerts: [], errors: [{ code: 'ITEM_SCAN_UNKNOWN', message: 'currentMap.items was not read completely.' }] };
  const defRecords = defConditions?.records ?? {};
  const items = (transport.allItemCandidates ?? []).map((entry: any) => enrichAllItem(entry.row, entry.category, roof?.byPosition ?? {}, storageCoverage, defRecords[String(entry.row?.['def.defName'] ?? '')]));
  const errors: any[] = [...(defConditions?.errors ?? []), ...(roof?.errors ?? [])];
  if (storageCoverage?.status !== 'complete') errors.push({ code: 'STORAGE_COVERAGE_UNKNOWN', message: 'Stockpile or storage-building coverage did not complete; per-item storage fields remain explicit partial/unknown.' });
  const unknownIdentity = items.filter((item: any) => !item.def || item.def === 'unknown-def' || item.thingIDNumber === null).length;
  if (unknownIdentity) errors.push({ code: 'ITEM_ID_OR_DEF_UNKNOWN', message: `${unknownIdentity} currentMap.items rows lack a reliable defName or thingIDNumber.` });
  const unknownPositions = items.filter((item: any) => !item.position || item.exposure.roofed === null).length;
  const conditionUnknown = items.filter((item: any) => item.condition.status === 'unknown').length;
  const conditionEstimated = items.filter((item: any) => item.condition.status === 'partial').length;
  if (unknownPositions) errors.push({ code: 'ITEM_EXPOSURE_UNKNOWN', message: `${unknownPositions} ground items have no reliable roof/position evidence.` });
  if (conditionUnknown) errors.push({ code: 'ITEM_CONDITION_UNKNOWN', message: `${conditionUnknown} ground items have no reliable maxHP or current condition comparison.` });
  if (conditionEstimated) errors.push({ code: 'ITEM_EFFECTIVE_MAX_UNKNOWN', message: `${conditionEstimated} ground items use a base ThingDef MaxHitPoints candidate because material/quality-adjusted effective maxHP was not read.` });
  const status = itemScan.status === 'complete' && roof?.status === 'complete' && defConditions?.status === 'complete' && !errors.length ? 'complete' : 'partial';
  return {
    status,
    complete: status === 'complete',
    total: items.length,
    sourceTotal: itemScan.total ?? null,
    returned: itemScan.returned ?? itemRows.length,
    unique: itemScan.unique ?? itemRows.length,
    pages: itemScan.pages?.length ?? 0,
    items,
    alerts: items.filter((item: any) => item.riskLevel),
    unroofed: items.filter((item: any) => item.exposure.roofed === false),
    damaged: items.filter((item: any) => item.condition.isDamaged === true),
    lowDurability: items.filter((item: any) => item.condition.lowDurability === true),
    baseLowDurability: items.filter((item: any) => item.condition.baseLowDurability === true),
    storageBuildingItems: items.filter((item: any) => item.storage?.inStorageBuildingFootprint === true),
    categories: Object.fromEntries([...items.reduce((counts: Map<string, number>, item: any) => counts.set(item.category, (counts.get(item.category) ?? 0) + 1), new Map<string, number>())].sort(([a], [b]) => a.localeCompare(b))),
    conditionDefinitions: { status: defConditions?.status ?? 'unknown', requestedDefs: defConditions?.requestedDefs ?? [], cachedDefs: defConditions?.cacheSize ?? 0, errors: defConditions?.errors ?? [] },
    exposureCoverage: { status: roof?.status ?? 'unknown', positions: roof?.positionCount ?? 0, unknown: unknownPositions, errors: roof?.errors ?? [] },
    excludedLivingItems: transport.excludedLivingItems?.length ?? 0,
    errors,
    note: '完整地面物资来自currentMap.items；活植物排除；stockpile覆盖与货架真实占地和roofed天气证据分开记录。',
  };
}

function enrichCandidate(row: any, category: string, roofByPosition: Record<string, any>, storageCoverage: any) {
  const key = positionKey(row?.positionInt ?? row?.position);
  const roof = key && roofByPosition[key] ? roofByPosition[key] : { defName: null, roofed: null };
  const storage = storageEvidence(category, key, storageCoverage);
  return asThingCandidate(row, category, roof, storage);
}

async function readForbidden(context: InspectionContext, baseItems: any[]) {
  const defs = [...new Set(baseItems.map(row => String(row?.['def.defName'] ?? '')).filter(Boolean))];
  if (!defs.length) return { status: 'complete', items: [], checkedDefs: [], unsupportedDefs: [], errors: [] };
  const example = baseItems.find(row => Number.isFinite(row?.thingIDNumber));
  if (!example) return { status: 'unknown', items: [], checkedDefs: [], unsupportedDefs: [], errors: [{ code: 'NO_ITEM_REFERENCE', message: 'No item row had a thingIDNumber for component inspection.' }] };
  const exampleDef = String(example['def.defName']);
  const refResult = await context.game.state.read('game', { thingId: exampleDef + example.thingIDNumber, depth: 0, budgetMs: BUDGET_MS });
  const exampleRef = asRef(checkResult(context, refResult, 'forbidden component example'));
  if (!exampleRef) throw new CollectionError('Forbidden component example returned no object reference.');
  const descriptionResult = await context.game.state.describe(exampleRef);
  const description = checkResult(context, descriptionResult, `state.describe(${exampleRef.type})`);
  const typeHasComponent = readable(description, 'compForbiddable');
  const byType = new Map<string, boolean>([[exampleRef.type, typeHasComponent]]);
  const checkedDefs: string[] = [];
  const unsupportedDefs: string[] = [];
  const errors: any[] = [];
  const forbiddenRows: any[] = [];

  const results = await mapLimit(defs, 6, async (def: string) => {
    try {
      const sample = baseItems.find(row => String(row?.['def.defName']) === def && Number.isFinite(row?.thingIDNumber));
      if (!sample) throw new CollectionError(`No sample row for ${def}.`);
      const ref = def === exampleDef ? exampleRef : asRef(checkResult(context, await context.game.state.read('game', { thingId: def + sample.thingIDNumber, depth: 0, budgetMs: BUDGET_MS }), `forbidden sample ${def}`));
      if (!ref) throw new CollectionError(`No object reference for ${def}.`);
      let support = byType.get(ref.type);
      if (support === undefined) {
        const dr = await context.game.state.describe(ref);
        const desc = checkResult(context, dr, `state.describe(${ref.type})`);
        support = readable(desc, 'compForbiddable');
        byType.set(ref.type, support);
      }
      if (!support) return { def, unsupported: true };
      const collection = await scanPages(context, { root: 'currentMap.items', where: { 'def.defName': def }, derived: false, fields: ['thingIDNumber', 'def.defName', 'compForbiddable.forbiddenInt'] }, `forbidden ${def}`);
      return { def, collection };
    } catch (error) {
      return { def, error: errorInfo(error) };
    }
  });
  for (const result of results) {
    if (result.unsupported) { unsupportedDefs.push(result.def); continue; }
    if (result.error) { errors.push({ def: result.def, error: result.error }); continue; }
    checkedDefs.push(result.def);
    if (result.collection.status !== 'complete') errors.push({ def: result.def, error: result.collection.error ?? { code: 'COLLECTION_PARTIAL', message: 'Only part of this definition collection was confirmed.' } });
    for (const row of result.collection.items) {
      if (row['compForbiddable.forbiddenInt'] !== true) {
        if (row['compForbiddable.forbiddenInt'] !== false) errors.push({ def: result.def, error: { code: 'FORBIDDEN_VALUE_UNKNOWN', message: `thingIDNumber=${String(row.thingIDNumber)} did not return a boolean.` } });
        continue;
      }
      const base = baseItems.find(item => String(item?.['def.defName']) === result.def && item?.thingIDNumber === row.thingIDNumber);
      forbiddenRows.push({ id: `${result.def}${row.thingIDNumber}`, def: result.def, thingIDNumber: row.thingIDNumber, quantity: base?.stackCount ?? null, position: position(base?.positionInt), hitPointsInt: base?.hitPointsInt ?? null, forbidden: true, facts: { defName: result.def, thingIDNumber: row.thingIDNumber, stackCount: base?.stackCount ?? null, positionInt: position(base?.positionInt), hitPointsInt: base?.hitPointsInt ?? null, forbiddenInt: true }, candidate: '被禁用物品先核对用途；可达性、预留状态和安全搬运未读取' });
    }
  }
  return { ...finalizeForbiddenEvidence(forbiddenRows, errors), checkedDefs, unsupportedDefs };
}

export function finalizeForbiddenEvidence(items: any[], errors: any[]) {
  return { status: errors.length ? 'partial' as const : 'complete' as const, items, errors };
}

async function readRotting(context: InspectionContext, baseItems: any[]) {
  const categoryDefs = [...new Set(baseItems.map(row => ({ row, def: String(row?.['def.defName'] ?? '') })).filter(entry => foodOrHerbCategory(entry.def)).map(entry => entry.def))];
  if (!categoryDefs.length) return { status: 'complete', items: [], inspectedRows: 0, errors: [] };
  const errors: any[] = [];
  const rotItems: any[] = [];
  const rotDescriptors = new Map<string, { fields: string[]; readable: boolean }>();
  const rowsByDef = await mapLimit(categoryDefs, 6, async (def: string) => {
    try {
      return { def, collection: await scanPages(context, { root: 'currentMap.items', where: { 'def.defName': def }, derived: false, fields: ['thingIDNumber', 'def.defName', 'comps'] }, `rotting ${def}`) };
    } catch (error) {
      return { def, error: errorInfo(error) };
    }
  });
  let inspectedRows = 0;
  for (const grouped of rowsByDef) {
    if (grouped.error) { errors.push({ def: grouped.def, error: grouped.error }); continue; }
    if (grouped.collection.status !== 'complete') errors.push({ def: grouped.def, error: grouped.collection.error ?? { code: 'COLLECTION_PARTIAL', message: 'Only part of this definition collection was confirmed.' } });
    for (const row of grouped.collection.items) {
      inspectedRows += 1;
      try {
        const listRef = asRef(row.comps);
        if (!listRef) continue;
        const listResult = await context.game.state.read(listRef, { depth: 1, budgetMs: BUDGET_MS, maxNodes: MAX_NODES });
        const listData = checkResult(context, listResult, `rotting comps ${grouped.def}:${row.thingIDNumber}`);
        const rotComp = (listData.items ?? []).map((component: any) => asRef(component)).find((component: ObjectRef | null) => component && /CompRottable$/i.test(String(component.type))) as ObjectRef | undefined;
        if (!rotComp) continue;
        let descriptor = rotDescriptors.get(rotComp.type);
        if (!descriptor) {
          const descriptionResult = await context.game.state.describe(rotComp);
          const description = checkResult(context, descriptionResult, `state.describe(${rotComp.type})`);
          const fields = ['rotProgressInt', 'disabled'].filter(field => readable(description, field));
          descriptor = { fields, readable: fields.includes('rotProgressInt') };
          rotDescriptors.set(rotComp.type, descriptor);
        }
        if (!descriptor.readable) { errors.push({ def: grouped.def, error: { code: 'ROT_PROGRESS_UNKNOWN', message: `${rotComp.type}.rotProgressInt is not readable.` } }); continue; }
        const componentResult = await context.game.state.read(rotComp, { fields: descriptor.fields, depth: 0, budgetMs: BUDGET_MS, maxNodes: MAX_NODES });
        const componentData = checkResult(context, componentResult, `rotting component ${grouped.def}:${row.thingIDNumber}`);
        const progress = componentData.fields?.rotProgressInt;
        const disabled = componentData.fields?.disabled;
        if (typeof progress !== 'number') { errors.push({ def: grouped.def, error: { code: 'ROT_PROGRESS_VALUE_UNKNOWN', message: `thingIDNumber=${String(row.thingIDNumber)} returned no numeric rotProgressInt.` } }); continue; }
        if (progress <= 0) continue;
        const base = baseItems.find(item => String(item?.['def.defName']) === grouped.def && item?.thingIDNumber === row.thingIDNumber);
        rotItems.push({ id: `${grouped.def}${row.thingIDNumber}`, def: grouped.def, thingIDNumber: row.thingIDNumber, quantity: base?.stackCount ?? null, position: position(base?.positionInt), rotProgressInt: roundNumber(progress, 2), disabled: disabled === true, facts: { defName: grouped.def, thingIDNumber: row.thingIDNumber, stackCount: base?.stackCount ?? null, positionInt: position(base?.positionInt), rotProgressInt: progress, disabled: disabled ?? null }, interpretation: 'rotProgressInt>0 证明腐坏计时已有进展；剩余时间、腐坏率和温度影响未读取', candidate: '优先核对储存位置和温度；不要据此推断还剩多少时间' });
      } catch (error) {
        errors.push({ def: grouped.def, thingIDNumber: row.thingIDNumber, error: errorInfo(error) });
      }
    }
  }
  return { status: errors.length ? 'partial' : 'complete', items: rotItems, inspectedRows, errors };
}

async function readApparel(context: InspectionContext, residents: any[]) {
  const records: any[] = [];
  const errors: any[] = [];
  for (const pawn of residents) {
    try {
      const collection = await queryAllChecked(context, { root: 'game', thingId: pawn.id, path: 'apparel.wornApparel.innerList', derived: false, fields: ['thingIDNumber', 'def.defName', 'hitPointsInt', 'compQuality.qualityInt'] }, `apparel ${pawn.id}`);
       records.push({ pawnId: pawn.id, name: pawn.name, collection: { status: collection.status, complete: collection.complete, total: collection.total, returned: collection.returned, pages: collection.pages.length, consistency: collection.consistency, truncated: collection.truncated, truncationBasis: collection.truncationBasis }, items: collection.items.map(row => ({ id: `${row['def.defName'] ?? 'unknown'}${row.thingIDNumber ?? 'unknown'}`, def: row['def.defName'] ?? null, thingIDNumber: row.thingIDNumber ?? null, hitPointsInt: row.hitPointsInt ?? null, quality: row['compQuality.qualityInt'] ?? null, facts: { defName: row['def.defName'] ?? null, thingIDNumber: row.thingIDNumber ?? null, hitPointsInt: row['hitPointsInt'] ?? null, quality: row['compQuality.qualityInt'] ?? null } })) });
    } catch (error) {
      errors.push({ pawnId: pawn.id, name: pawn.name, error: errorInfo(error) });
    }
  }
  return { status: errors.length ? 'partial' : 'complete', records, errors };
}

function lowDurability(items: any[], apparel: any[]) {
  const ground = items.filter(row => Number.isFinite(row?.hitPointsInt) && row.hitPointsInt >= 0 && row.hitPointsInt <= 50 && likelyEquipment(String(row?.['def.defName'] ?? ''))).map(row => ({ id: `${row['def.defName'] ?? 'unknown'}${row.thingIDNumber ?? 'unknown'}`, def: row['def.defName'] ?? null, thingIDNumber: row.thingIDNumber ?? null, hitPointsInt: row.hitPointsInt, position: position(row.positionInt), maxHitPoints: 'unknown', facts: { defName: row['def.defName'] ?? null, thingIDNumber: row.thingIDNumber ?? null, hitPointsInt: row.hitPointsInt, positionInt: position(row.positionInt) }, candidate: '核对最大耐久后安排替换；仅凭当前HP不能判断剩余百分比' }));
  const worn = apparel.flatMap(record => (record.items ?? []).filter((row: any) => Number.isFinite(row.hitPointsInt) && row.hitPointsInt >= 0 && row.hitPointsInt <= 50).map((row: any) => ({ ...row, pawnId: record.pawnId, name: record.name, maxHitPoints: 'unknown', position: null, candidate: '该殖民者身上装备当前HP≤50；核对最大耐久后安排替换' })));
  return { ground, worn, total: ground.length + worn.length };
}

function medicalCoverage(residents: any[]) {
  const doctors = residents.filter(pawn => {
    const value = pawn?.work?.Doctor;
    return value && value.disabled !== true && Number(value.priority) > 0;
  }).map(pawn => ({ id: pawn.id, name: pawn.name, priority: pawn.work.Doctor.priority }));
  return { doctors, doctorCount: doctors.length, status: residents.every(pawn => pawn?.work && pawn.work.Doctor) ? 'complete' : 'unknown' };
}

function memoryIsNegative(name: string): boolean {
  return /(Corpse|SleptInHeat|SleptInCold|SleepDisturbed|SoakingWet|Slighted|Insulted|KilledMyKin|NutrientPaste|Hungry|Starving|Pain|Dark|Ugly|ApparelDamaged|Rebuff|Disturbed|Heat|Cold)/i.test(name);
}

function memoryIsPositive(name: string): boolean {
  return /(Catharsis|AteFineMeal|AteLavishMeal|GoodBedroom|Comfortable|Recreation)/i.test(name);
}

async function readMemories(context: InspectionContext, pawn: any) {
  try {
    const collection = await queryAllChecked(context, { root: 'game', thingId: pawn.id, path: 'needs.mood.thoughts.memories.memories', derived: false, fields: ['def.defName', 'age'] }, `mood memories ${pawn.id}`, { key: memoryIdentityKey, mode: 'memory-stable-identity-only+anonymous-preserved' });
    const rows = collection.items.map(row => ({ def: row['def.defName'] ?? null, age: row.age ?? null, facts: { defName: row['def.defName'] ?? null, age: row.age ?? null } }));
    return { status: collection.status, complete: collection.complete, total: collection.total, returned: collection.returned, unique: collection.unique, duplicatesRemoved: collection.duplicatesRemoved, dedupeMode: collection.dedupeMode, anonymousRowsPreserved: collection.anonymousRowsPreserved, completeByCursor: collection.completeByCursor, integrity: collection.integrity, pages: collection.pages.length, consistency: collection.consistency, truncated: collection.truncated, truncationBasis: collection.truncationBasis, negative: rows.filter(row => typeof row.def === 'string' && memoryIsNegative(row.def)), positiveRebounds: rows.filter(row => typeof row.def === 'string' && memoryIsPositive(row.def)), note: 'memory age and def are evidence of thought history; they do not prove current causality; rows without a stable identity are retained and are not deduplicated by JSON value' };
  } catch (error) {
    return { status: 'unknown', error: errorInfo(error), negative: [], positiveRebounds: [] };
  }
}

async function readSituational(context: InspectionContext, pawn: any) {
  try {
    const handlerResult = await context.game.state.read('game', { thingId: pawn.id, path: 'needs.mood.thoughts.situational', depth: 0, budgetMs: BUDGET_MS, maxNodes: MAX_NODES });
    const handlerData = checkResult(context, handlerResult, `situational handler ${pawn.id}`);
    const handler = asRef(handlerData);
    if (!handler) return { status: 'unknown', error: { code: 'SITUATIONAL_REF_UNKNOWN', message: 'No situational thought handler reference was returned.' }, active: [] };
    const descriptionResult = await context.game.state.describe(handler);
    const description = checkResult(context, descriptionResult, `state.describe(situational ${pawn.id})`);
    if (!readable(description, 'cachedThoughts')) return { status: 'unknown', handlerType: handler.type, error: { code: 'SITUATIONAL_CACHE_UNREADABLE', message: 'cachedThoughts is not a readable field on the described handler.' }, active: [] };
    const cacheResult = await context.game.state.read(handler, { fields: ['cachedThoughts'], depth: 1, budgetMs: BUDGET_MS, maxNodes: MAX_NODES });
    const cacheData = checkResult(context, cacheResult, `situational cache ${pawn.id}`);
    const cached = collectionItems(cacheData.fields?.cachedThoughts);
    if (!cached) return { status: 'unknown', handlerType: handler.type, error: { code: 'SITUATIONAL_CACHE_ITEMS_UNKNOWN', message: 'cachedThoughts did not expose an items array.' }, active: [] };
    if (!cached.length) return { status: 'complete', handlerType: handler.type, fieldsDescribed: ['cachedThoughts'], active: [], note: 'situational cache was readable and empty' };
    const thoughtRef = asRef(cached[0]);
    if (!thoughtRef) return { status: 'unknown', handlerType: handler.type, error: { code: 'SITUATIONAL_THOUGHT_REF_UNKNOWN', message: 'First cached thought was not a readable reference.' }, active: [] };
    const thoughtDescriptionResult = await context.game.state.describe(thoughtRef);
    const thoughtDescription = checkResult(context, thoughtDescriptionResult, `state.describe(situational thought ${pawn.id})`);
    const wantedFields = ['def.defName', 'curStageIndex', 'reason', 'cachedMoodOffsetOfGroup'];
    const fields = wantedFields.filter(field => field === 'def.defName' ? readable(thoughtDescription, 'def') : readable(thoughtDescription, field));
    if (!fields.includes('def.defName')) return { status: 'unknown', handlerType: handler.type, error: { code: 'SITUATIONAL_DEF_UNREADABLE', message: 'The described thought does not expose a readable def field.' }, active: [] };
    const collection = await queryAllChecked(context, { ref: handler, path: 'cachedThoughts', derived: false, fields }, `situational cachedThoughts ${pawn.id}`);
    const active = collection.items.filter(row => row.curStageIndex == null || Number(row.curStageIndex) >= 0).map(row => ({ def: row['def.defName'] ?? null, stage: row.curStageIndex ?? null, reason: row.reason ?? null, moodOffset: row.cachedMoodOffsetOfGroup ?? null, facts: { defName: row['def.defName'] ?? null, curStageIndex: row.curStageIndex ?? null, reason: row.reason ?? null, cachedMoodOffsetOfGroup: row.cachedMoodOffsetOfGroup ?? null } }));
     return { status: collection.status, complete: collection.complete, handlerType: handler.type, fieldsDescribed: ['cachedThoughts', ...fields], active, totalCached: collection.total, pages: collection.pages.length, consistency: collection.consistency, truncated: collection.truncated, truncationBasis: collection.truncationBasis, note: 'only described readable fields were queried; no property getter was invoked' };
  } catch (error) {
    return { status: 'unknown', error: errorInfo(error), active: [] };
  }
}

async function readThoughts(context: InspectionContext, residents: any[]) {
  const byPawn: Record<string, any> = {};
  for (const pawn of residents) {
    if (context.invalidReason) break;
    const memories = await readMemories(context, pawn);
    const situational = await readSituational(context, pawn);
    byPawn[pawn.id] = { pawnId: pawn.id, name: pawn.name, memories, situational };
  }
  const pawnStatuses = Object.values(byPawn).flatMap((value: any) => [value.memories?.status, value.situational?.status]);
  return { status: context.invalidReason ? 'unknown' : pawnStatuses.some(status => status !== 'complete') ? 'partial' : 'complete', byPawn };
}

function distanceBetween(a: any, b: any): number | null {
  const left = position(a);
  const right = position(b);
  if (!left || !right) return null;
  return Math.hypot(left.x - right.x, left.z - right.z);
}

function buildFindings(residents: any[], thoughts: any, roomData: any, mapData: any, mapCandidates: any[], medical: any): Finding[] {
  const findings: Finding[] = [];
  for (const pawn of residents) {
    const name = pawn.name ?? pawn.id;
    const pos = pawn.position ? `(${pawn.position.x},${pawn.position.z})` : '位置未知';
    if (pawn.mentalState) findings.push({ key: `mental:${pawn.id}:${pawn.mentalState}`, severity: 'important', kind: 'mental-state', title: `${name}处于${pawn.mentalState}`, evidence: { pawnId: pawn.id, name, position: pawn.position, mentalState: pawn.mentalState, job: pawn.job }, suggestion: '先核对当前精神状态和最近思想，主控在战斗/研究节奏允许时优先处理。' });
    if (pawn.flags.dead) findings.push({ key: `dead:${pawn.id}`, severity: 'important', kind: 'dead', title: `${name}已死亡`, evidence: { pawnId: pawn.id, position: pawn.position }, suggestion: '确认战斗与医疗状态，避免把死亡殖民者继续派入工作。' });
    else if (pawn.flags.downed) findings.push({ key: `downed:${pawn.id}`, severity: 'important', kind: 'downed', title: `${name}倒地`, evidence: { pawnId: pawn.id, position: pawn.position, health: pawn.health }, suggestion: '安全后安排救援和医疗覆盖。' });
    if (typeof pawn.needs.food === 'number' && pawn.needs.food < 0.15) findings.push({ key: `food-critical:${pawn.id}`, severity: 'important', kind: 'food', title: `${name}食物需求低`, evidence: { pawnId: pawn.id, name, position: pawn.position, food: pawn.needs.food, mentalState: pawn.mentalState, job: pawn.job, context: '当前为play观察；若刚结束战斗，短时下降仍可能是战斗遗留，持续一轮才证明供给问题' }, suggestion: '安全时优先安排进食并核对可用食物位置；先不要把敌方附近物资当成可安全搬运。' });
    if (typeof pawn.needs.rest === 'number' && pawn.needs.rest < 0.12) findings.push({ key: `rest-critical:${pawn.id}`, severity: 'important', kind: 'rest', title: `${name}休息需求低`, evidence: { pawnId: pawn.id, name, position: pawn.position, rest: pawn.needs.rest, mentalState: pawn.mentalState, job: pawn.job, context: '当前为play观察；若战斗刚结束，短时疲劳与持续耗竭需分开观察' }, suggestion: '战斗收束后给出连续睡眠窗口，检查床位与室温；没有持续样本前不归因于主控措施。' });
    if (typeof pawn.needs.mood === 'number' && pawn.needs.mood < 0.2) findings.push({ key: `mood-critical:${pawn.id}`, severity: 'important', kind: 'mood', title: `${name}心情很低`, evidence: { pawnId: pawn.id, name, position: pawn.position, mood: pawn.needs.mood, mentalState: pawn.mentalState, negativeThoughts: thoughts?.byPawn?.[pawn.id]?.memories?.negative ?? [], situational: thoughts?.byPawn?.[pawn.id]?.situational?.active ?? [] }, suggestion: '按思想证据处理最便宜的直接原因，并密切看精神状态；恢复值不能在没有连续证据时归因于主控操作。' });
    const dangerous = (pawn.health.conditions ?? []).filter((condition: any) => /BloodLoss|Infection|FoodPoisoning|Heatstroke|Hypothermia|Malnutrition|ExtremePain/i.test(String(condition.def)));
    if (dangerous.length) findings.push({ key: `health:${pawn.id}:${dangerous.map((condition: any) => condition.def).sort().join(',')}`, severity: 'important', kind: 'health', title: `${name}有需要复核的健康状态`, evidence: { pawnId: pawn.id, name, position: pawn.position, conditions: dangerous, medicalCoverage: medical }, suggestion: medical.doctorCount ? '核对患者休息和医生工作是否实际可用，继续观察失血/感染是否增长。' : '当前没有可读到的启用医生工作者，安全后优先补医疗覆盖。' });
    const thought = thoughts?.byPawn?.[pawn.id];
    for (const active of thought?.situational?.active ?? []) {
      if (!active.def || !/(PsychicDrone|EnvironmentDark|ApparelDamaged|MentalBreak|SleptInHeat|SleptInCold)/i.test(active.def)) continue;
      findings.push({ key: `situational:${pawn.id}:${active.def}`, severity: /MentalBreak|EnvironmentDark/i.test(active.def) ? 'important' : 'watch', kind: 'situational-thought', title: `${name}有${active.def}情境思想`, evidence: { pawnId: pawn.id, name, position: pawn.position, thought: active, mood: pawn.needs.mood }, suggestion: active.def === 'EnvironmentDark' ? '检查所在房间的灯具存在和覆盖；当前只读证据不能证明照明覆盖范围。' : active.def === 'ApparelDamaged' ? '核对具体衣物当前HP和替换品，避免把已知破衣问题重复当成新事件。' : '结合最近思想和当前任务安排低成本缓解，保持连续观察。' });
    }
  }
  for (const candidate of mapCandidates.filter(row => row.kind === 'ground-item' && row.riskLevel)) {
    const location = candidate.position ? `(${candidate.position.x},${candidate.position.z})` : '位置未知';
    const itemLabel = `${candidate.def ?? 'unknown'}×${candidate.quantity ?? 'unknown'}`;
    const key = `ground-item-condition:${candidate.id}`;
    const important = candidate.riskLevel === 'important';
    findings.push({
      key,
      severity: candidate.riskLevel,
      kind: 'ground-item-condition',
      title: important ? `${itemLabel}在${location}露天且耐久偏低` : `${itemLabel}在${location}有耐久/损耗候选`,
      evidence: { ...candidate, findingReason: candidate.riskReason },
      suggestion: important
        ? '优先核对搬运安全并移入有屋顶的储存空间；stockpile覆盖本身不防雨，货架占地和真实roofed字段分开确认。'
        : '保留该物资的ID和当前证据，核对屋顶、货架占地与可达性后安排处理；maxHP或损耗字段unknown时不要臆测。',
    });
  }
  for (const candidate of mapCandidates.filter(row => row.roof?.roofed === true && /^Corpse_/i.test(row.def))) {
    findings.push({ key: `corpse:${candidate.def}:${candidate.thingIDNumber}:covered`, severity: 'important', kind: 'indoor-corpse', title: `有屋顶处发现${candidate.def}尸体`, evidence: candidate, suggestion: '主控安全时安排清理或埋葬；位置可读，通行、预留和敌情未读，先不要在战斗中抢操作。' });
  }
  for (const candidate of mapCandidates.filter(row => row.kind === 'human')) {
    const nearby = residents.map(pawn => ({ pawnId: pawn.id, name: pawn.name, distance: distanceBetween(candidate.position, pawn.position) })).filter(row => row.distance !== null).sort((a, b) => (a.distance as number) - (b.distance as number))[0];
    if (!nearby || (nearby.distance as number) > 30) continue;
    findings.push({ key: `watch:human-corpse-near-colony:${candidate.def}:${candidate.thingIDNumber}`, severity: 'watch', kind: 'human-corpse-near-colony', title: `生活区附近发现${candidate.def}尸体`, evidence: { defName: candidate.def, thingIDNumber: candidate.thingIDNumber, position: candidate.position, roofed: candidate.roof?.roofed ?? null, nearestResident: nearby }, suggestion: '战斗结束后核对位置、威胁和清理/埋葬任务；这是位置证据，未猜测Corpse_Human的innerPawn。' });
  }
  for (const candidate of mapCandidates.filter(row => row.category === 'herb-or-medicine-candidate' && row.roof?.roofed === false)) {
    findings.push({ key: `watch:unroofed-medicine:${candidate.def}:${candidate.thingIDNumber}`, severity: 'watch', kind: 'unroofed-medicine', title: `${candidate.def}无屋顶记录`, evidence: { defName: candidate.def, thingIDNumber: candidate.thingIDNumber, quantity: candidate.quantity, position: candidate.position, roofed: candidate.roof.roofed, storage: candidate.storage }, suggestion: '核对所在stockpile或储物建筑与搬运规则；roofed=false只证明无屋顶，不等同真实户外或未受储物保护。' });
  }
  for (const room of roomData?.items ?? []) {
    const role = defName(room['role.defName']) ?? room['role.defName'];
    const temperature = Number(room['tempTracker.temperatureInt']);
    if (role && role !== 'None' && Number.isFinite(temperature) && (temperature < 5 || temperature > 35)) findings.push({ key: `room-temp:${room.ID}`, severity: 'important', kind: 'temperature', title: `房间${room.ID}温度异常`, evidence: { roomId: room.ID, role, temperature, cachedOpenRoofCount: room.cachedOpenRoofCount ?? null, cachedCellCount: room.cachedCellCount ?? null }, suggestion: temperature > 35 ? '优先核对热源、通风和殖民者是否长时间停留。' : '优先核对热源与封闭情况，避免把短时室外暴露当作室内温度问题。' });
  }
  return findings;
}

export function classifyFindings(findings: Finding[], previousKeys: Iterable<string> = [], knownKeys: Iterable<string> = []) {
  const previous = new Set(previousKeys);
  const known = new Set(knownKeys);
  const newImportant: Finding[] = [];
  const knownPending: Finding[] = [];
  const watch: Finding[] = [];
  const seen = new Set<string>();
  for (const finding of findings) {
    if (seen.has(finding.key)) continue;
    seen.add(finding.key);
    if (finding.severity === 'watch') { watch.push(finding); continue; }
    if (previous.has(finding.key) || known.has(finding.key)) knownPending.push(finding);
    else newImportant.push(finding);
  }
  return { newImportant, knownPending, watch };
}

export function shouldSkipSameTick(last: any, current: any, phase: unknown, forceOnce = false): boolean {
  return !forceOnce && phase === 'play' && sameMeta(last, current) && Number(last.gameTick) === Number(current.gameTick);
}

function roomSummary(rows: any[]) {
  return rows.map(row => ({ id: row.ID ?? null, role: defName(row['role.defName']) ?? row['role.defName'] ?? null, temperature: roundNumber(row['tempTracker.temperatureInt'], 2), cachedOpenRoofCount: row.cachedOpenRoofCount ?? null, cachedCellCount: row.cachedCellCount ?? null, facts: { ID: row.ID ?? null, roleDefName: defName(row['role.defName']) ?? row['role.defName'] ?? null, temperatureInt: row['tempTracker.temperatureInt'] ?? null, cachedOpenRoofCount: row.cachedOpenRoofCount ?? null, cachedCellCount: row.cachedCellCount ?? null } }));
}

function latestMeta(observations: Array<Record<string, any>>) {
  return observations.length ? observations[observations.length - 1] : null;
}

export async function inspectColony(game: Game, lease: Record<string, unknown>) {
  const context: InspectionContext = { game, lease, observations: [], gaps: [], mapId: undefined, mapWidth: null, mapHeight: null, invalidReason: null };
  const pawnsResult = await section(context, 'pawns', () => readPawns(context));
  const residents = (pawnsResult as any)?.residents ?? [];
  const compactResidents = residents.map(compactPawn);
  const medical = medicalCoverage(residents);

  const mapRoot = await section(context, 'map-root', () => readMapRoot(context));
  const mapRef = (mapRoot as any)?.reference as ObjectRef | undefined;
  const itemScan = await section(context, 'map-items', () => scanPages(context, { root: 'currentMap.items', derived: false, fields: ['def.defName', 'thingIDNumber', 'stackCount', 'positionInt', 'hitPointsInt'] }, 'currentMap.items'));
  const thingScan = await section(context, 'map-things', () => scanPages(context, { root: 'currentMap.things', derived: false, fields: ['def.defName', 'thingIDNumber', 'positionInt', 'stackCount', 'hitPointsInt'] }, 'currentMap.things'));
  const roomScan = await section(context, 'rooms', () => readRooms(context));
  const itemRows = (itemScan as any)?.items ?? [];
  const thingRows = (thingScan as any)?.items ?? [];
  const corpseRows = thingRows.filter((row: any) => /^Corpse_/i.test(String(row?.['def.defName'] ?? '')));
  const transport = splitTransportRows(itemRows, thingRows);
  const itemCandidates = transport.itemCandidates;
  const livingPlants = transport.livingPlants;
  const allItemRows = (transport.allItemCandidates ?? []).map((entry: any) => entry.row);
  const candidatePositions = [...corpseRows, ...allItemRows, ...residents.map((pawn: any) => pawn.position)].map((row: any) => row?.positionInt ?? row?.position ?? row);
  const roof = mapRef
    ? await section(context, 'roof-evidence', () => readRoof(context, mapRef, candidatePositions, context.mapWidth, context.mapHeight))
    : (() => {
      const error = { code: 'ROOF_EVIDENCE_UNAVAILABLE', message: 'currentMap reference or state.map dimensions were unavailable; roof evidence was not read.' };
      context.gaps.push({ key: 'section:roof-evidence', section: 'roof-evidence', error });
      return unknownSection(error);
    })();
  const zones = await section(context, 'stockpile-zones', () => readZones(context));
  const storageCells = Array.isArray((zones as any)?.cells) ? new Set<string>((zones as any).cells) : null;
  const stockpileCells = Array.isArray((zones as any)?.stockpileCells) ? new Set<string>((zones as any).stockpileCells) : null;
  const storageBuildingCells = Array.isArray((zones as any)?.storageBuildingCells) ? new Set<string>((zones as any).storageBuildingCells) : null;
  const storageCoverage = { status: (zones as any)?.status ?? 'unknown', cells: storageCells, stockpileCells, storageBuildingCells, byCell: (zones as any)?.storageByCell ?? {} };
  const roofByPosition = (roof as any)?.byPosition ?? {};
  const foodHerb = itemCandidates.map((entry: any) => enrichCandidate(entry.row, entry.category, roofByPosition, storageCoverage));
  const defConditions = await section(context, 'item-condition-defs', () => readDefConditionCache(context, allItemRows));
  const allItemExposure = allItemExposureSection(itemScan, allItemRows, transport, roof, storageCoverage, defConditions);
  const corpses = corpseRows.map((row: any) => {
    const base = asThingCandidate(row, 'corpse', roofByPosition[positionKey(row.positionInt) ?? ''] ?? { defName: null, roofed: null }, null);
    const def = base.def;
    return { ...base, kind: def === 'Corpse_Human' ? 'human' : /^Corpse_(Animal|Deer|Ibex|Hare|Rat|Muffalo|Boomalope|Boomrat|Alpaca|Megasloth|Thrumbo|Turkey|Hen|Chicken|Pig|WildBoar|Warg|Wolf|Fox|Squirrel|Raccoon|Capybara|Tortoise|Turtle|Dromedary|Camel|Donkey|Horse|Gazelle|Goat|Sheep|Labrador|YorkshireTerrier|Cat|Dog|Bear|Cougar|Panther|Snowhare|Alphabeaver|GuineaPig|Monkey|Macaque|Ostrich|Emu|Penguin|Toxalope)/i.test(def) ? 'animal' : 'corpse-kind-unknown', candidate: base.roof.roofed === true ? '有屋顶尸体；安全后可作为清理/埋葬候选' : base.roof.roofed === false ? '无屋顶；真实户外状态和清理优先级仍未知' : '屋顶字段unknown；不据此推断位置风险', facts: { ...base.facts, defName: def, thingIDNumber: base.thingIDNumber, positionInt: base.position } };
  });
  const storageOmissions = (zones as any)?.status === 'complete' && storageCells ? foodHerb.filter(candidate => candidate.storage.inKnownStorageFootprint === false).map(candidate => ({ ...candidate, candidate: 'outside verified stockpile cells and storage-building footprints; storage filters, reservation and reachability remain unknown' })) : [];
  const unroofedFoodHerb = foodHerb.filter(candidate => candidate.roof.roofed === false);
  const roofUnknownFoodHerb = foodHerb.filter(candidate => candidate.roof.roofed === null);
  const forbidden = await section(context, 'forbidden-items', () => readForbidden(context, itemRows));
  const apparel = await section(context, 'worn-apparel', () => readApparel(context, residents));
  const apparelRecords = (apparel as any)?.records ?? [];
  const durability = lowDurability(itemRows, apparelRecords);
  const rotting = await section(context, 'rotting-items', () => readRotting(context, itemRows));
  const thoughts = await section(context, 'mood-thoughts', () => readThoughts(context, residents));
   const pawnRooms = mapRef ? await section(context, 'pawn-rooms', () => readPawnRooms(context, residents, mapRef)) : unknownSection(new CollectionError('currentMap reference unavailable; resident room evidence was not read.'));
  const compactRoomRows = (roomScan as any)?.items ? roomSummary((roomScan as any).items) : [];
  const lampLike = thingRows.filter((row: any) => /Lamp|Campfire|Torch|Heater|Fire/i.test(String(row?.['def.defName'] ?? ''))).map((row: any) => ({ id: `${row['def.defName'] ?? 'unknown'}${row.thingIDNumber ?? 'unknown'}`, def: row['def.defName'] ?? null, thingIDNumber: row.thingIDNumber ?? null, position: position(row.positionInt), facts: { defName: row['def.defName'] ?? null, thingIDNumber: row.thingIDNumber ?? null, positionInt: position(row.positionInt) } }));
  const candidatesForFindings = [...corpses, ...allItemExposure.items];
  const findings = buildFindings(compactResidents, thoughts, roomScan, { items: itemRows, things: thingRows }, candidatesForFindings, medical);
  const firstMeta = context.observations[0] ?? null;
  const ticks = context.observations.map(observation => observation.gameTick).filter(value => Number.isFinite(value)) as number[];
  const uniqueTicks = [...new Set(ticks)];
  const coverageGaps = [...context.gaps];
  const addIncompleteGap = (name: string, value: any) => {
    if (!value || value.status === 'complete' || coverageGaps.some(gap => gap.section === name)) return;
    const firstError = value.errors?.[0]?.error ?? value.errors?.[0];
    coverageGaps.push({ key: `incomplete:${name}`, section: name, error: value.error ?? firstError ?? { code: 'SECTION_INCOMPLETE', message: `${name} did not complete; confirmed rows remain visible.` } });
  };
  for (const [name, value] of [['map-root', mapRoot], ['currentMap.items', itemScan], ['currentMap.things', thingScan], ['currentMap.regionGrid.allRooms', roomScan], ['roof-evidence', roof], ['stockpile zones', zones], ['item-condition-defs', defConditions], ['all-item-exposure', allItemExposure], ['forbidden-items', forbidden], ['rotting-items', rotting], ['worn-apparel', apparel], ['mood-thoughts', thoughts], ['pawn-rooms', pawnRooms]] as Array<[string, any]>) addIncompleteGap(name, value);
  const status = context.invalidReason ? 'invalid' : coverageGaps.length ? 'partial' : 'complete';
  const foodHerbStatus = (itemScan as any)?.status === 'unknown'
    ? 'unknown'
    : (itemScan as any)?.status === 'complete' && (roof as any)?.status === 'complete' && (zones as any)?.status === 'complete'
      ? 'complete'
      : 'partial';
  const report: any = {
    schemaVersion: 2,
    status,
    observedAt: new Date().toISOString(),
    mode: 'read-only SDK state; no ui/runtime/action call',
    session: { sessionId: firstMeta?.sessionId ?? lease.sessionId ?? null, worldEpoch: firstMeta?.worldEpoch ?? lease.worldEpoch ?? null, mapId: context.mapId ?? null },
    observation: { tickMin: ticks.length ? Math.min(...ticks) : null, tickMax: ticks.length ? Math.max(...ticks) : null, ticks: uniqueTicks, consistency: uniqueTicks.length <= 1 ? 'same-tick' : 'mixed-ticks', calls: context.observations.length, note: 'running pagination uses sameTick:false; this report is a set of observations, not an atomic snapshot' },
    controlLease: { sessionId: lease.sessionId ?? null, worldEpoch: lease.worldEpoch ?? null, status: lease.status ?? null, owner: lease.owner ?? null, phase: lease.phase ?? null },
    requests: { pawns: (pawnsResult as any)?.request ?? { colonistsOnly: false, limit: 5000, budgetMs: 1000 }, collections: collectionRequest(), sameTickForPaging: false },
    map: {
      root: mapRoot,
      scans: { items: itemScan, things: thingScan, rooms: roomScan },
      corpses: { status: (thingScan as any)?.status === 'complete' ? 'complete' : 'unknown', total: corpses.length, items: corpses },
      forbiddenItems: forbidden,
      foodHerb: { status: foodHerbStatus, totalCandidates: foodHerb.length, items: foodHerb, unroofed: unroofedFoodHerb, roofUnknown: roofUnknownFoodHerb },
      allItemExposure,
      allItems: allItemExposure,
      livingPlants,
      rottingItems: rotting,
      durability: { ...durability, facts: 'ground items and worn apparel use current hitPointsInt; max hit points were not guessed' },
      storage: { zones, omissions: storageOmissions, status: (zones as any)?.status ?? 'unknown', note: 'stockpile覆盖、储物建筑完整占地（含rotation）与roofed天气证据分开；筛选、预留、可达性和战斗安全仍未读取' },
      roofEvidence: roof,
      rooms: { ...roomScan, items: compactRoomRows },
      residentRooms: pawnRooms,
      lightingEvidence: { lampLikeThings: lampLike, interpretation: 'lamp/fire presence and coordinates only; actual room light coverage was not read' },
    },
    colonists: { ...pawnsResult, residents: compactResidents, thoughts, apparel, medicalCoverage: medical },
    findings: { current: findings, newImportant: [], knownPending: [], watch: [] },
    coverageGaps,
    invalidation: context.invalidReason,
    interpretation: { causality: 'A lower need after an earlier sample is not attributed to a controller action without causal evidence.', catharsis: 'Catharsis, if present below, is reported as a positive rebound thought and is not treated as proof that the controller caused recovery.', transportItems: '全量地面物资来自currentMap.items；活植物从搬运候选排除。roofed=false证明天气暴露，stockpile覆盖不等于防雨，货架/储物建筑占地单独记录。', durability: 'current hitPointsInt分开记录基础MaxHitPoints与材料/品质修正后的actualMaxHitPoints；只有读到实际值才将ratioIsAccurate标为true，基础ThingDef统计对装备只作候选，不称为准确百分比。HP<0按不可应用处理，不能当作低耐久。', corpseRule: 'Corpse kind is taken only from the defName; Corpse_Human has no innerPawn lookup here.' },
  };
  return report;
}

async function mapLimit(values: string[], concurrency: number, fn: (value: string) => Promise<any>): Promise<any[]> {
  const results = new Array(values.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      results[index] = await fn(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}
