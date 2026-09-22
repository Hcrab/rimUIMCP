import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFindings, classifyItemRisk, deriveCollectionIntegrity, deriveItemCondition, deriveItemExposure, finalizeForbiddenEvidence, formatGroundItemChecklist, inspectColony, mapGridIndex, shouldSkipSameTick, splitTransportRows, storageFootprintCells, storageEvidence, validateCompleteCollection } from '../agent/helpers/colony-inspection.ts';

test('rejects incomplete single page collections instead of inferring normal state', () => {
  assert.deepEqual(validateCompleteCollection({ items: [1, 2], total: 2, nextCursor: null, truncated: false }), { total: 2, returned: 2, truncated: false });
  assert.throws(() => validateCompleteCollection({ items: [1], total: 1, nextCursor: 1, truncated: false }), /nextCursor/);
  assert.throws(() => validateCompleteCollection({ items: [1], total: 1, nextCursor: null, truncated: true }), /truncated/);
  assert.throws(() => validateCompleteCollection({ items: [], total: 1, nextCursor: null, truncated: false }), /items for total/);
});

test('deduplicates stable finding keys before classifying history', () => {
  const finding = { key: 'mental:Human1252:Test', severity: 'important' as const, kind: 'mental-state', title: 'test', evidence: { pawnId: 'Human1252' }, suggestion: 'test' };
  const result = classifyFindings([finding, { ...finding }, { ...finding, key: 'room-temp:12', severity: 'watch' }], ['room-temp:12']);
  assert.equal(result.newImportant.length, 1);
  assert.equal(result.knownPending.length, 0);
  assert.equal(result.watch.length, 1);
  assert.equal(result.watch[0].key, 'room-temp:12');
});

test('skips a repeated tick only in play and never when explicitly forced once', () => {
  const first = { sessionId: 's', worldEpoch: 8, mapId: 'Map_0', gameTick: 4086378 };
  assert.equal(shouldSkipSameTick(first, { ...first }, 'play'), true);
  assert.equal(shouldSkipSameTick(first, { ...first }, 'research'), false);
  assert.equal(shouldSkipSameTick(first, { ...first }, 'play', true), false);
  assert.equal(shouldSkipSameTick(first, { ...first, gameTick: 4086379 }, 'play'), false);
});

test('derives pagination closure when the bridge omits truncated and preserves partial drift', () => {
  const closed = deriveCollectionIntegrity({ total: 2, returned: 2, totals: [2, 2], finalCursorClosed: true, truncatedFieldAvailable: false });
  assert.equal(closed.status, 'complete');
  assert.equal(closed.complete, true);
  assert.equal(closed.truncated, false);
  assert.match(closed.truncationBasis, /derived-final-cursor/);

  const pageFlagWasContinuation = deriveCollectionIntegrity({ total: 2, returned: 2, totals: [2, 2], finalCursorClosed: true, finalTruncated: false, truncatedFieldAvailable: true, intermediateTruncated: true });
  assert.equal(pageFlagWasContinuation.status, 'complete');
  assert.equal(pageFlagWasContinuation.integrity.intermediateTruncated, true);

  const drifted = deriveCollectionIntegrity({ total: 3, returned: 3, totals: [4, 3], duplicatesRemoved: 1, finalCursorClosed: true });
  assert.equal(drifted.status, 'partial');
  assert.equal(drifted.complete, false);
  assert.equal(drifted.integrity.collectionChanged, true);
});

test('keeps living plants out of transport candidates and covers rotated storage footprints', () => {
  const split = splitTransportRows(
    [
      { 'def.defName': 'RawRice', thingIDNumber: 1 },
      { 'def.defName': 'MedicineHerbal', thingIDNumber: 2 },
      { 'def.defName': 'WoolAlpaca', thingIDNumber: 3 },
      { 'def.defName': 'Leather_Plain', thingIDNumber: 4 },
      { 'def.defName': 'Steel', thingIDNumber: 5 },
      { 'def.defName': 'Plant_Berry', thingIDNumber: 6 },
    ],
    [{ 'def.defName': 'Plant_Berry', thingIDNumber: 3 }, { 'def.defName': 'Plant_HealrootWild', thingIDNumber: 4 }],
  );
  assert.equal(split.itemCandidates.length, 2);
  assert.equal(split.allItemCandidates.length, 5);
  assert.deepEqual(split.allItemCandidates.map((entry: any) => entry.category), [
    'food-candidate', 'herb-or-medicine-candidate', 'textile-or-leather', 'textile-or-leather', 'raw-or-construction-material',
  ]);
  assert.equal(split.excludedLivingItems.length, 1);
  assert.equal(split.livingPlants.count, 2);
  assert.equal(split.livingPlants.excludedFromTransport, true);

  assert.deepEqual(storageFootprintCells({ x: 125, z: 132 }, { x: 2, z: 1 }, 0).sort(), ['125,132', '126,132']);
  assert.deepEqual(storageFootprintCells({ x: 125, z: 132 }, { x: 2, z: 1 }, 1).sort(), ['125,131', '125,132']);
  assert.deepEqual(storageFootprintCells({ x: 141, z: 142 }, { x: 1, z: 1 }, 0), ['141,142']);
});

test('retains confirmed forbidden rows when one definition check fails', () => {
  const confirmed = [{ def: 'Steel', thingIDNumber: 1, forbidden: true }];
  const result = finalizeForbiddenEvidence(confirmed, [{ def: 'ChunkGranite', error: { code: 'UNSUPPORTED' } }]);
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.items, confirmed);
  assert.equal(result.errors.length, 1);
});

test('uses the actual map width for non-250 roof and room indices', () => {
  assert.equal(mapGridIndex({ x: 299, y: 0, z: 2 }, 300, 160), 899);
  assert.equal(mapGridIndex({ x: 300, y: 0, z: 2 }, 300, 160), null);
  assert.equal(mapGridIndex({ x: 299, y: 0, z: 2 }, 250, 160), null);
});

test('reports exposed wool at 11/90 as important while keeping stockpile and shelf evidence separate', () => {
  const storage = storageEvidence('textile-or-leather', '170,134', {
    status: 'complete',
    cells: new Set(['170,134']),
    stockpileCells: new Set(['170,134']),
    storageBuildingCells: new Set(),
    byCell: {},
  });
  const exposure = deriveItemExposure({ defName: null, roofed: false }, storage);
  const condition = deriveItemCondition({ hitPointsInt: 11 }, {
    def: 'WoolAlpaca',
    useHitPoints: true,
    baseMaxHitPoints: 90,
    baseMaxHitPointsSource: 'ThingDef.statBases.MaxHitPoints',
    deteriorationRate: 0.1,
    deteriorationRateSource: 'ThingDef.statBases.DeteriorationRate',
  });
  const item = { id: 'WoolAlpaca176785', def: 'WoolAlpaca', quantity: 45, position: { x: 170, y: 0, z: 134 }, roof: { roofed: false }, storage, exposure, condition };
  assert.equal(condition.healthRatio, 0.1222);
  assert.equal(condition.baseMaxHitPoints, 90);
  assert.equal(condition.actualMaxHitPoints, 'unknown');
  assert.equal(condition.maxHitPointsBasis, 'base-def-resource-like');
  assert.equal(condition.ratioIsAccurate, false);
  assert.equal(condition.status, 'partial');
  assert.equal(condition.damageStatus, 'low');
  assert.equal(exposure.weatherProtected, false);
  assert.equal(exposure.inKnownStockpileCell, true);
  assert.equal(storage.inStorageBuildingFootprint, false);
  assert.deepEqual(classifyItemRisk(item), { severity: 'important', reason: 'low-durability+unroofed' });
  assert.match(formatGroundItemChecklist({ ...item, riskLevel: 'important' }), /WoolAlpaca176785 WoolAlpaca×45 \(170,134\) HP=11\/90 roofed=false shelf=false stockpile=true level=important/);
});

test('does not alert HP=-1 steel or stone as damaged and marks missing maxHP explicitly', () => {
  const steel = deriveItemCondition({ hitPointsInt: -1 }, { useHitPoints: false, maxHitPoints: null });
  assert.equal(steel.damageStatus, 'not-applicable');
  assert.equal(steel.lowDurability, false);
  assert.equal(classifyItemRisk({ condition: steel, exposure: { roofed: false } }), null);

  const unknown = deriveItemCondition({ hitPointsInt: 20 }, { useHitPoints: true, maxHitPoints: null });
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.maxHitPoints, 'unknown');
  assert.equal(unknown.damageStatus, 'absolute-low-candidate');
  assert.deepEqual(classifyItemRisk({ condition: unknown, exposure: { roofed: false } }), { severity: 'watch', reason: 'damaged+unroofed' });
});

test('does not present a ThingDef base max as an accurate equipment percentage', () => {
  const condition = deriveItemCondition({ 'def.defName': 'Apparel_Test', hitPointsInt: 20 }, {
    def: 'Apparel_Test',
    useHitPoints: true,
    baseMaxHitPoints: 100,
    baseMaxHitPointsSource: 'ThingDef.statBases.MaxHitPoints',
  });
  assert.equal(condition.baseMaxHitPoints, 100);
  assert.equal(condition.actualMaxHitPoints, 'unknown');
  assert.equal(condition.maxHitPoints, 'unknown');
  assert.equal(condition.healthRatio, null);
  assert.equal(condition.baseHealthRatio, 0.2);
  assert.equal(condition.ratioIsAccurate, false);
  assert.equal(condition.maxHitPointsBasis, 'base-def-only');
  assert.equal(condition.damageStatus, 'base-low-candidate');
  assert.deepEqual(classifyItemRisk({ condition, exposure: { roofed: false }, category: 'equipment' }), { severity: 'watch', reason: 'base-low-candidate+unroofed' });
});

test('inspection uses a lease roster, normalizes memory queryAll metadata, and materializes full items', async () => {
  const meta = (tick = 100) => ({ sessionId: 'inspection-session', worldEpoch: 4, mapId: 'Map_500', gameTick: tick, uiFrame: tick, snapshotId: `inspection-${tick}` });
  const ref = (id: string, type: string) => ({ id, sessionId: 'inspection-session', worldEpoch: 4, type });
  const mapRef = ref('map-500', 'Verse.Map');
  const roomRef = ref('room-1', 'Verse.Room');
  const zoneRef = ref('zone-1', 'Verse.Zone_Stockpile');
  const items = [
    { 'def.defName': 'WoolAlpaca', thingIDNumber: 176785, stackCount: 45, positionInt: { x: 170, y: 0, z: 134 }, hitPointsInt: 11 },
    { 'def.defName': 'Leather_Plain', thingIDNumber: 176786, stackCount: 12, positionInt: { x: 200, y: 0, z: 100 }, hitPointsInt: 80 },
    { 'def.defName': 'Steel', thingIDNumber: 176787, stackCount: 30, positionInt: { x: 10, y: 0, z: 10 }, hitPointsInt: -1 },
    { 'def.defName': 'Plant_Berry', thingIDNumber: 176788, stackCount: 1, positionInt: { x: 12, y: 0, z: 12 }, hitPointsInt: -1 },
  ];
  const pawns = [
    { id: 'NewA', name: 'One', factionIsPlayer: true, humanlike: true, position: { x: 20, z: 20 }, needs: {}, health: { conditions: [] }, work: {} },
    { id: 'NewB', name: 'Two', factionIsPlayer: true, humanlike: true, position: { x: 21, z: 20 }, needs: {}, health: { conditions: [] }, work: {} },
    { id: 'NewC', name: 'Three', factionIsPlayer: true, humanlike: true, position: { x: 22, z: 20 }, needs: {}, health: { conditions: [] }, work: {} },
  ];
  const statRef = (id: string) => ref(id, 'Verse.StatDef');
  const modifierRef = (id: string) => ref(id, 'Verse.StatModifier');
  const statBasesRef = (id: string) => ref(id, 'System.Collections.Generic.List`1[Verse.StatModifier]');
  const statBases = {
    'stats-wool': [modifierRef('modifier-wool-max'), modifierRef('modifier-wool-deterioration')],
    'stats-leather': [modifierRef('modifier-leather-max')],
    'stats-steel': [],
  } as Record<string, any[]>;
  const modifiers = {
    'modifier-wool-max': { stat: statRef('stat-max-hit-points'), value: 90 },
    'modifier-wool-deterioration': { stat: statRef('stat-deterioration-rate'), value: 0.1 },
    'modifier-leather-max': { stat: statRef('stat-max-hit-points'), value: 100 },
  } as Record<string, any>;
  const statDefs = { 'stat-max-hit-points': 'MaxHitPoints', 'stat-deterioration-rate': 'DeteriorationRate' } as Record<string, string>;
  const assertReadableFields = (requested: unknown, allowed: string[]) => {
    const unknownField = (Array.isArray(requested) ? requested : []).find((field: unknown) => !allowed.includes(String(field)));
    if (unknownField) throw Object.assign(new Error(`FIELD_NOT_FOUND: ${String(unknownField)}`), { code: 'FIELD_NOT_FOUND' });
  };
  let memoryMissingPage = false;
  let itemDuplicate = false;
  // This is the actual projected shape: no row reference is included, so
  // equal def+age values must remain two separate memory rows.
  const memoryRows = [{ 'def.defName': 'AteFineMeal', age: 4 }, { 'def.defName': 'AteFineMeal', age: 4 }];
  const defs: Record<string, any> = {
    WoolAlpaca: { defName: 'WoolAlpaca', useHitPoints: true, statBases: statBasesRef('stats-wool') },
    Leather_Plain: { defName: 'Leather_Plain', useHitPoints: true, statBases: statBasesRef('stats-leather') },
    Steel: { defName: 'Steel', useHitPoints: false, statBases: statBasesRef('stats-steel') },
  };
  const calls: Array<{ method: string; args?: any }> = [];
  const state = {
    pawns: async () => ({ success: true, requestId: 'pawns', meta: meta(), data: { items: pawns, total: pawns.length, nextCursor: null, truncated: false } }),
    map: async () => ({ success: true, requestId: 'map', meta: meta(), data: { id: 'Map_500', reference: mapRef, width: 300, height: 160 } }),
    roots: async () => ({ success: true, requestId: 'roots', meta: meta(), data: { currentMap: mapRef } }),
    describe: async (target: any) => ({
      success: true,
      requestId: 'describe',
      meta: meta(),
      data: target.id === 'zone-1' ? { type: target.type, fields: [{ name: 'cells', readable: true }] } : target.id === 'map-500' ? { type: target.type, fields: [{ name: 'regionGrid', readable: true }, { name: 'roofGrid', readable: true }, { name: 'zoneManager', readable: true }] } : { type: target.type, fields: [] },
    }),
    query: async (options: any) => {
      calls.push({ method: 'state.query', args: options });
      const root = options.root;
      if (root === 'game' && options.path === 'needs.mood.thoughts.memories.memories') {
        const rows = memoryMissingPage ? memoryRows.slice(0, 1) : memoryRows;
        return { success: true, requestId: 'query-memories', meta: meta(), data: { items: rows, total: 2, nextCursor: null } };
      }
      if (root === 'currentMap.items') {
        const wanted = options.where?.['def.defName'];
        let rows = wanted ? items.filter(row => row['def.defName'] === wanted) : items;
        if (!wanted && itemDuplicate) rows = [...rows, rows[0]];
        return { success: true, requestId: 'query-items', meta: meta(), data: { items: rows, total: rows.length, nextCursor: null } };
      }
      if (root === 'currentMap.things') {
        const rows = [{ 'def.defName': 'Plant_Berry', thingIDNumber: 176789, positionInt: { x: 14, y: 0, z: 14 }, stackCount: 1, hitPointsInt: -1 }];
        return { success: true, requestId: 'query-things', meta: meta(), data: { items: rows, total: rows.length, nextCursor: null } };
      }
      if (root === 'currentMap.buildings') {
        const rows = [{ 'def.defName': 'Shelf', thingIDNumber: 9001, positionInt: { x: 200, y: 0, z: 100 }, 'def.size.x': 2, 'def.size.z': 1, 'rotationInt.rotInt': 0 }];
        return { success: true, requestId: 'query-buildings', meta: meta(), data: { items: rows, total: rows.length, nextCursor: null } };
      }
      if (root === 'currentMap.regionGrid.allRooms') {
        const rows = [{ ID: 'room-1', 'role.defName': 'Bedroom', 'tempTracker.temperatureInt': 21, cachedOpenRoofCount: 0, cachedCellCount: 12 }];
        return { success: true, requestId: 'query-rooms', meta: meta(), data: { items: rows, total: rows.length, nextCursor: null } };
      }
      if (root === 'defs') {
        assertReadableFields(options.fields, ['defName', 'useHitPoints', 'statBases']);
        const name = options.where?.defName;
        const row = defs[name];
        return { success: true, requestId: 'query-def', meta: meta(), data: { items: row ? [row] : [], total: row ? 1 : 0, nextCursor: null } };
      }
      return { success: true, requestId: 'query-pawn-list', meta: meta(), data: { items: [], total: 0, nextCursor: null } };
    },
    read: async (target: any, options: any = {}) => {
      calls.push({ method: 'state.read', args: { target, options } });
      if (options.path === 'zoneManager.allZones') return { success: true, requestId: 'zones', meta: meta(), data: { items: [zoneRef] } };
      if (target === 'currentMap' && options.path === 'zoneManager.allZones') return { success: true, requestId: 'zones', meta: meta(), data: { items: [zoneRef] } };
      if (target?.id === 'zone-1') return { success: true, requestId: 'zone', meta: meta(), data: { fields: { ID: 'zone-1', cells: { items: [{ x: 170, y: 0, z: 134 }] } } } };
      if (target?.id === 'room-1') return { success: true, requestId: 'room', meta: meta(), data: { fields: { ID: 'room-1', 'role.defName': 'Bedroom', 'tempTracker.temperatureInt': 21, cachedOpenRoofCount: 0, cachedCellCount: 12 } } };
      if (target?.id && Object.prototype.hasOwnProperty.call(statBases, target.id)) return { success: true, requestId: 'stat-bases', meta: meta(), data: { items: statBases[target.id] } };
      if (target?.id && Object.prototype.hasOwnProperty.call(modifiers, target.id)) {
        assertReadableFields(options.fields, ['stat', 'value']);
        return { success: true, requestId: 'stat-modifier', meta: meta(), data: { fields: modifiers[target.id] } };
      }
      if (target?.id && Object.prototype.hasOwnProperty.call(statDefs, target.id)) {
        assertReadableFields(options.fields, ['defName']);
        return { success: true, requestId: 'stat-def', meta: meta(), data: { fields: { defName: statDefs[target.id] } } };
      }
      if (target?.id === 'map-500' && Array.isArray(options.fields)) {
        const fields: Record<string, any> = {};
        for (const field of options.fields) {
          if (field.startsWith('roofGrid.')) {
            const index = Number(field.match(/roofGrid\.roofGrid\.(\d+)\./)?.[1]);
            fields[field] = index === (134 * 300 + 170) || index === (10 * 300 + 10) ? null : 'RoofConstructed';
          } else if (field.startsWith('regionGrid.')) fields[field] = roomRef;
        }
        return { success: true, requestId: 'map-fields', meta: meta(), data: { fields } };
      }
      if (target === 'game' && options.path) return { success: true, requestId: 'game-path', meta: meta(), data: {} };
      if (target === 'game' && options.thingId) return { success: true, requestId: 'thing-ref', meta: meta(), data: ref(`${options.thingId}`, 'Verse.Thing') };
      return { success: true, requestId: 'read', meta: meta(), data: {} };
    },
  };
  const report = await inspectColony({ state } as any, { sessionId: 'inspection-session', worldEpoch: 4, expectedColonists: pawns.map(pawn => ({ id: pawn.id, name: pawn.name })) });
  const all = report.map.allItemExposure;
  const wool = all.items.find((item: any) => item.def === 'WoolAlpaca');
  const steel = all.items.find((item: any) => item.def === 'Steel');
  const memories = report.colonists.thoughts.byPawn.NewA.memories;
  assert.deepEqual(report.map.root.grid.width, 300);
  assert.deepEqual(report.map.root.grid.height, 160);
  assert.deepEqual(report.colonists.roster.expected, pawns.map(pawn => ({ id: pawn.id, name: pawn.name })));
  assert.equal(report.colonists.roster.missing.length, 0);
  assert.equal(all.status, 'partial');
  assert.equal(all.total, 3);
  assert.equal(all.excludedLivingItems, 1);
  assert.equal(wool.quantity, 45);
  assert.equal(wool.position.x, 170);
  assert.equal(wool.condition.maxHitPoints, 90);
  assert.equal(wool.condition.baseMaxHitPoints, 90);
  assert.equal(wool.condition.actualMaxHitPoints, 'unknown');
  assert.equal(wool.condition.actualMaxHitPointsStatus, 'not-read-material-quality');
  assert.equal(wool.condition.maxHitPointsBasis, 'base-def-resource-like');
  assert.equal(wool.condition.ratioIsAccurate, false);
  assert.equal(wool.condition.healthRatio, 0.1222);
  assert.equal(wool.exposure.roofed, false);
  assert.equal(wool.storage.inKnownStockpileCell, true);
  assert.equal(wool.storage.inStorageBuildingFootprint, false);
  assert.equal(steel.condition.maxHitPoints, 'unknown');
  assert.equal(steel.condition.damageStatus, 'not-applicable');
  assert.equal(all.conditionDefinitions.cachedDefs, 3);
  assert.equal(all.conditionDefinitions.errors.length, 0);
  assert.equal(memories.status, 'complete');
  assert.equal(memories.complete, true);
  assert.equal(memories.total, 2);
  assert.equal(memories.returned, 2);
  assert.equal(memories.unique, 2);
  assert.equal(memories.duplicatesRemoved, 0);
  assert.equal(memories.dedupeMode, 'memory-stable-identity-only+anonymous-preserved');
  assert.equal(memories.anonymousRowsPreserved, 2);
  assert.equal(memories.positiveRebounds.length, 2);
  assert.equal(memories.completeByCursor, true);
  assert.equal(memories.truncated, false);
  assert.equal(memories.truncationBasis, 'derived-final-cursor+total+no-duplicates+stable-total');
  assert.deepEqual(memories.integrity, { finalCursorClosed: true, totalMatches: true, duplicatesRemoved: 0, collectionChanged: false, intermediateTruncated: false });
  assert.ok(report.findings.current.some((finding: any) => finding.kind === 'ground-item-condition' && finding.severity === 'important' && finding.evidence.id === wool.id));
  const defCalls = calls.filter(call => call.method === 'state.query' && call.args?.root === 'defs');
  assert.deepEqual(defCalls.map(call => call.args.where.defName).sort(), ['Leather_Plain', 'Steel', 'WoolAlpaca']);
  assert.ok(defCalls.every(call => JSON.stringify(call.args.fields) === JSON.stringify(['defName', 'useHitPoints', 'statBases'])));
  assert.ok(defCalls.every(call => !call.args.fields.includes('baseHitPoints')));
  assert.ok(calls.some(call => call.method === 'state.read' && call.args?.target?.id === 'stats-wool'));
  assert.ok(calls.some(call => call.method === 'state.read' && call.args?.target?.id === 'modifier-wool-max' && call.args.options.fields?.join(',') === 'stat,value'));
  assert.ok(calls.some(call => call.method === 'state.read' && call.args?.target?.id === 'stat-max-hit-points' && call.args.options.fields?.join(',') === 'defName'));
  await assert.rejects(() => state.query({ root: 'defs', where: { defName: 'StrictProbe' }, fields: ['baseHitPoints'] }), /FIELD_NOT_FOUND/);
  memoryMissingPage = true;
  const partialReport = await inspectColony({ state } as any, { sessionId: 'inspection-session', worldEpoch: 4, expectedColonists: pawns.map(pawn => ({ id: pawn.id, name: pawn.name })) });
  const partialMemories = partialReport.colonists.thoughts.byPawn.NewA.memories;
  assert.equal(partialMemories.status, 'partial');
  assert.equal(partialMemories.complete, false);
  assert.equal(partialMemories.total, 2);
  assert.equal(partialMemories.returned, 1);
  assert.equal(partialMemories.unique, 1);
  assert.equal(partialMemories.integrity.totalMatches, false);
  assert.equal(partialMemories.truncationBasis, 'unknown-incomplete-collection');

  memoryMissingPage = false;
  itemDuplicate = true;
  const duplicateReport = await inspectColony({ state } as any, { sessionId: 'inspection-session', worldEpoch: 4, expectedColonists: pawns.map(pawn => ({ id: pawn.id, name: pawn.name })) });
  const duplicateItems = duplicateReport.map.scans.items;
  assert.equal(duplicateItems.status, 'partial');
  assert.equal(duplicateItems.complete, false);
  assert.equal(duplicateItems.total, 5);
  assert.equal(duplicateItems.returned, 5);
  assert.equal(duplicateItems.unique, 4);
  assert.equal(duplicateItems.duplicatesRemoved, 1);
  assert.equal(duplicateItems.integrity.duplicatesRemoved, 1);
});

test('does not claim complete exposure coverage when state.map dimensions cannot be read', async () => {
  const meta = { sessionId: 'broken-map', worldEpoch: 1, mapId: 'Map_broken', gameTick: 1, uiFrame: 1, snapshotId: 'broken-map-1' };
  const response = (data: any) => ({ success: true, requestId: 'offline', meta, data });
  const state = {
    pawns: async () => response({ items: [], total: 0, nextCursor: null, truncated: false }),
    map: async () => ({ success: false, requestId: 'map-failure', meta, error: { code: 'MAP_READ_FAILED', message: 'offline fixture' } }),
    roots: async () => response({ currentMap: null }),
    describe: async () => response({ fields: [] }),
    query: async () => response({ items: [], total: 0, nextCursor: null }),
    read: async () => response({ items: [], fields: {} }),
  };
  const report = await inspectColony({ state } as any, { sessionId: 'broken-map', worldEpoch: 1 });
  assert.equal(report.status, 'partial');
  assert.equal(report.map.root.status, 'unknown');
  assert.equal(report.map.roofEvidence.status, 'unknown');
  assert.equal(report.map.root.grid, undefined);
  assert.ok(report.coverageGaps.some((gap: any) => gap.section === 'map-root'));
  assert.ok(report.coverageGaps.some((gap: any) => gap.section === 'roof-evidence'));
});
