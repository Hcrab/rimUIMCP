import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findLocalizedNodes,
  billRepeatModeTextKey,
  matchesUiText,
  requireLocalizedNode,
  selectorForUiNode,
  storagePriorityTextKey,
} from '../agent/helpers/ui-text.ts';

test('matches the official English and Simplified Chinese labels used by common helpers', () => {
  const pairs = [
    ['Manual priorities', '自定义优先级', 'manualPriorities'],
    ['Clear all', '全部清除', 'clearAll'],
    ['Storage', '储存筛选', 'storage'],
    ['Bills', '清单', 'bills'],
    ['Add bill', '添加清单', 'addBill'],
    ['Details...', '详细...', 'details'],
    ['Close', '关闭', 'close'],
    ['Do X times', '做 X 次', 'repeatCount'],
    ['Do until you have X', '维持 X 个', 'targetCount'],
    ['Do forever', '不限次数', 'forever'],
    ['Suspended', '已暂停', 'suspended'],
    ['Not suspended', '未暂停', 'notSuspended'],
    ['Manage food policies', '管理食物方案', 'manageFoodPolicies'],
    ['Zoom in', '放大', 'zoomIn'],
  ] as const;

  for (const [english, chinese, key] of pairs) {
    assert.equal(matchesUiText(english, key), true, `${key} should match English`);
    assert.equal(matchesUiText(chinese, key), true, `${key} should match Simplified Chinese`);
  }
});

test('handles translated dynamic prefixes and storage priority choices without fuzzy matches', () => {
  assert.equal(matchesUiText('Priority: Critical', 'priority', 'prefix'), true);
  assert.equal(matchesUiText('优先级: 关键', 'priority', 'prefix'), true);
  assert.equal(matchesUiText('Plant: Potato plant', 'plant', 'prefix'), true);
  assert.equal(matchesUiText('种植: 土豆', 'plant', 'prefix'), true);
  assert.equal(matchesUiText('Force wear Flak vest', 'forceWear', 'prefix'), true);
  assert.equal(matchesUiText('强制穿戴防弹衣', 'forceWear', 'prefix'), true);
  assert.equal(matchesUiText('Equip bolt-action rifle', 'equip', 'prefix'), true);
  assert.equal(matchesUiText('装备栓动步枪', 'equip', 'prefix'), true);
  assert.equal(matchesUiText('Priority level: Critical', 'priority', 'prefix'), false);
  assert.equal(matchesUiText('Details', 'details'), true);
  assert.equal(matchesUiText('details...', 'details'), true);

  assert.equal(storagePriorityTextKey('Low'), 'storagePriorityLow');
  assert.equal(storagePriorityTextKey('Normal'), 'storagePriorityNormal');
  assert.equal(storagePriorityTextKey('Preferred'), 'storagePriorityPreferred');
  assert.equal(storagePriorityTextKey('Important'), 'storagePriorityImportant');
  assert.equal(storagePriorityTextKey('Critical'), 'storagePriorityCritical');
  assert.equal(storagePriorityTextKey('Unknown'), undefined);

  assert.equal(billRepeatModeTextKey('RepeatCount'), 'repeatCount');
  assert.equal(billRepeatModeTextKey('TargetCount'), 'targetCount');
  assert.equal(billRepeatModeTextKey('Forever'), 'forever');
  assert.equal(billRepeatModeTextKey('Unknown'), undefined);
});

test('resolves one current-snapshot control and retains semantic and row scope', () => {
  const node = requireLocalizedNode([
    {
      targetId: 'ui-element:1', actionId: 'work.priority', surface: 'main.work', role: 'checkbox',
      name: '自定义优先级', ownerId: 'Human1', rowKey: 'Doctor', parentTargetId: 'table', source: 'gui.checkbox', actionable: true,
    },
  ], 'manualPriorities');

  assert.deepEqual(selectorForUiNode(node), {
    surface: 'main.work', role: 'checkbox', actionId: 'work.priority', ownerId: 'Human1', rowKey: 'Doctor',
    source: 'gui.checkbox', name: '自定义优先级', exact: true,
  });
  assert.equal(findLocalizedNodes([
    {name: 'Priority: 关键', actionable: true},
    {name: '普通', actionable: true},
  ], 'priority', {match: 'prefix'}).length, 1);
});

test('cross-snapshot selectors omit transient parents but retain owner and row scope', () => {
  const firstSnapshot = selectorForUiNode({
    surface: 'Dialog_BillConfig:one', role: 'button', actionId: 'bill.suspended',
    ownerId: 'FueledStove1', rowKey: 'Bill_CookMealSimple_42', source: 'gui.button',
    name: 'Suspended', parentTargetId: 'ui-element:2647:8:78',
  });
  const nextSnapshot = selectorForUiNode({
    surface: 'Dialog_BillConfig:one', role: 'button', actionId: 'bill.suspended',
    ownerId: 'FueledStove1', rowKey: 'Bill_CookMealSimple_42', source: 'gui.button',
    name: 'Suspended', parentTargetId: 'ui-element:2647:9:91',
  });
  const otherRow = selectorForUiNode({
    surface: 'Dialog_BillConfig:one', role: 'button', actionId: 'bill.suspended',
    ownerId: 'FueledStove1', rowKey: 'Bill_CookMealSimple_43', source: 'gui.button',
    name: 'Suspended', parentTargetId: 'ui-element:2647:10:104',
  });

  assert.deepEqual(firstSnapshot, nextSnapshot);
  assert.equal('parentTargetId' in firstSnapshot, false);
  assert.equal(firstSnapshot.ownerId, 'FueledStove1');
  assert.equal(firstSnapshot.rowKey, 'Bill_CookMealSimple_42');
  assert.notDeepEqual(firstSnapshot, otherRow);
});

test('fails closed when a translated control is missing or ambiguous', () => {
  assert.throws(() => requireLocalizedNode([], 'clearAll'), /not found/);
  assert.throws(() => requireLocalizedNode([
    {name: 'Clear all', actionable: true},
    {name: '全部清除', actionable: true},
  ], 'clearAll'), /ambiguous/);
});
