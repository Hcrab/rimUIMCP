import assert from 'node:assert/strict';
import test from 'node:test';
import { formatInspectionSummary } from '../agent/helpers/inspection-summary.ts';

const itemFinding = (id: number, def: string, category: string, x: number, z: number, quantity: number, condition: Record<string, unknown> = {}, evidence: Record<string, unknown> = {}) => ({
  severity: 'warning',
  kind: 'ground-item-condition',
  title: `${def} condition candidate`,
  evidence: { id: `${def}${id}`, thingIDNumber: id, def, category, quantity, position: { x, z }, ...evidence, condition },
  suggestion: '顺手核对位置和搬运优先级。',
});

test('watch candidates keep their severity and missing quantities are not presented as a complete total', () => {
  const known = itemFinding(1, 'RawRice', 'food-candidate', 1, 2, 8);
  const missing = {severity: 'watch', kind: 'ground-item-condition', evidence: {def: 'RawRice', thingIDNumber: 2, category: 'food-candidate'}};
  const summary = formatInspectionSummary({findings: {current: [{...known, severity: 'watch'}, missing]}});
  assert.match(summary, /【WATCH】ground-item-condition·食品·证据不足/);
  assert.match(summary, /已知数量合计8（1\/2项数量已知）/);
  assert.doesNotMatch(summary, /【WARNING】/);
});

test('keeps a bounded executable checklist while preserving counts, priority, gaps, and unknown durability', () => {
  const report = {
    status: 'partial',
    observation: { tickMin: 382860, tickMax: 382900 },
    coverageGaps: [{ section: 'all-item-exposure', error: { code: 'ITEM_CONDITION_UNKNOWN', message: '2 ground items have no reliable maxHP.' } }],
    findings: {
      current: [
        {
          severity: 'critical',
          kind: 'health',
          title: '陆铸衡健康状态需立即复核',
          evidence: { pawnId: 'Human3136', name: '陆铸衡', position: { x: 136, z: 125 }, mood: 0.31, conditions: [{ def: 'Gunshot' }] },
          suggestion: '确认医生和休息安排。',
        },
        itemFinding(1001, 'MealSimple', 'food-candidate', 10, 10, 2, { currentHitPoints: 60, maxHitPoints: 60, ratioIsAccurate: true }),
        itemFinding(1002, 'MealSimple', 'food-candidate', 11, 10, 3, { currentHitPoints: 60, maxHitPoints: 60, ratioIsAccurate: true }),
        itemFinding(1003, 'MealSimple', 'food-candidate', 12, 10, 3, { currentHitPoints: 60, maxHitPoints: 60, ratioIsAccurate: true }),
        itemFinding(9001, 'MeleeWeapon_Club', 'equipment', 20, 21, 1, { currentHitPoints: 20, maxHitPoints: 'unknown', maxHitPointsStatus: 'unknown', actualMaxHitPoints: 'unknown', ratioIsAccurate: false, damageStatus: 'base-damaged-candidate' }),
      ],
    },
  };

  const summary = formatInspectionSummary(report, { maxItemsPerGroup: 2, reportPath: 'runs/500-2026-09-14/full-inspection-latest.json' });

  assert.ok(summary.indexOf('【CRITICAL】') < summary.indexOf('【WARNING】'));
  assert.match(summary, /status=partial.*tick=382860–382900.*findings=5/);
  assert.match(summary, /coverageGaps=1/);
  assert.match(summary, /ITEM_CONDITION_UNKNOWN/);
  assert.match(summary, /ground-item-condition·食品·证据不足：总3项，数量合计8，列出2\/3项，remaining=1；完整报告：runs\/500-2026-09-14\/full-inspection-latest\.json/);
  assert.match(summary, /MealSimple#1001 \(10,10\) ×2/);
  assert.doesNotMatch(summary, /MealSimple#1003/);
  assert.match(summary, /MeleeWeapon_Club#9001 \(20,21\) ×1 \[exposure=unknown; roofed=unknown; storage=unknown\] 耐久候选 20\/maxHP=unknown/);
  assert.doesNotMatch(summary, /MeleeWeapon_Club#9001.*已确认损坏/);
});

test('separates exposed and covered stored watch items and uses the matching evidence in each suggestion', () => {
  const exposed = itemFinding(10, 'RawRice', 'food-candidate', 1, 2, 1, {
    currentHitPoints: 10,
    maxHitPoints: 60,
    maxHitPointsStatus: 'known',
    actualMaxHitPoints: 60,
    ratioIsAccurate: true,
    lowDurability: true,
    damageStatus: 'low',
  }, {
    roof: { roofed: false, defName: null },
    exposure: { exposure: 'exposed', roofed: false, weatherProtected: false },
    storage: { inKnownStorageFootprint: true, inKnownStockpileCell: true, inStorageBuildingFootprint: false },
  });
  const covered = itemFinding(11, 'RawRice', 'food-candidate', 3, 4, 2, {
    currentHitPoints: 59,
    maxHitPoints: 60,
    maxHitPointsStatus: 'known',
    baseMaxHitPoints: 60,
    actualMaxHitPoints: 'unknown',
    ratioIsAccurate: false,
    damageStatus: 'base-damaged-candidate',
  }, {
    roof: { roofed: true, defName: 'RoofConstructed' },
    exposure: { exposure: 'sheltered', roofed: true, weatherProtected: true },
    storage: { inKnownStorageFootprint: true, inKnownStockpileCell: false, inStorageBuildingFootprint: true },
  });

  const summary = formatInspectionSummary({findings: {current: [{...exposed, severity: 'watch'}, {...covered, severity: 'watch'}]}});
  const exposedStart = summary.indexOf('【WATCH】ground-item-condition·食品·露天');
  const coveredStart = summary.indexOf('【WATCH】ground-item-condition·食品·有顶且已知存储');
  assert.ok(exposedStart >= 0 && coveredStart > exposedStart);
  const exposedGroup = summary.slice(exposedStart, coveredStart);
  const coveredGroup = summary.slice(coveredStart);
  assert.match(exposedGroup, /roofed=false\(露天\)/);
  assert.match(exposedGroup, /storage=known-stockpile/);
  assert.match(exposedGroup, /stockpile占地不等于防雨/);
  assert.match(coveredGroup, /roofed=true\(有顶\)/);
  assert.match(coveredGroup, /storage=known-storage-building/);
  assert.match(coveredGroup, /已有 roofed=true 与已知储存占地证据，无需重复核对屋顶\/搬运/);
  assert.doesNotMatch(coveredGroup, /roofed=false|stockpile占地不等于防雨|如非生产现场暂存/);
});

test('keeps a known base maxHP when the effective maxHP is unknown', () => {
  const summary = formatInspectionSummary({findings: {current: [itemFinding(60, 'Leather_Wolf', 'textile-or-leather', 5, 6, 1, {
    currentHitPoints: 59,
    maxHitPoints: 60,
    maxHitPointsStatus: 'known',
    baseMaxHitPoints: 60,
    actualMaxHitPoints: 'unknown',
    actualMaxHitPointsStatus: 'not-read-material-quality',
    ratioIsAccurate: false,
    damageStatus: 'base-damaged-candidate',
  })]}});

  assert.match(summary, /耐久候选 59\/base60，有效maxHP=unknown/);
  assert.doesNotMatch(summary, /59\/maxHP=unknown/);
});

test('exposed old stone and corpse candidates do not become unconditional haul-home orders', () => {
  const evidence = {roof: {roofed: false}, storage: {inKnownStorageFootprint: false}};
  const findings = [
    {...itemFinding(1, 'ChunkLimestone', 'raw-or-construction-material', 56, 101, 1,
      {damageStatus: 'base-damaged-candidate', deterioration: {status: 'unknown', rate: null}}, evidence), severity: 'watch'},
    {...itemFinding(2, 'Corpse_Deer', 'ground-item', 158, 212, 1,
      {damageStatus: 'base-damaged-candidate'}, evidence), severity: 'watch'},
  ];
  const summary = formatInspectionSummary({findings: {current: findings}});
  assert.match(summary, /远处腐烂残骸/);
  assert.match(summary, /不据此自动生成搬运订单/);
  assert.doesNotMatch(summary, /如非生产现场暂存/);
});
