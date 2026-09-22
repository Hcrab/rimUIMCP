import type {Selector} from '../../packages/sdk/src/index.ts';

/**
 * Labels emitted by the vanilla English and Simplified Chinese UI.
 * Values come from the local Core language files and the BillRepeatMode defs.
 */
export const UI_TEXT = {
  manualPriorities: ['Manual priorities', '自定义优先级'],
  clearAll: ['Clear all', '全部清除'],
  storage: ['Storage', '储存筛选'],
  priority: ['Priority:', '优先级:'],
  bills: ['Bills', '清单'],
  addBill: ['Add bill', '添加清单'],
  details: ['Details...', 'Details', '详细...', '详细'],
  close: ['Close', '关闭'],
  repeatCount: ['do X times', '做 X 次'],
  targetCount: ['do until you have X', '维持 X 个'],
  forever: ['do forever', '不限次数'],
  suspended: ['Suspended', '已暂停'],
  notSuspended: ['Not suspended', '未暂停'],
  includeEquipped: ['Include equipped', '包括已装备的'],
  plant: ['Plant:', '种植:'],
  manageFoodPolicies: ['Manage food policies', '管理食物方案'],
  zoomIn: ['Zoom in', '放大'],
  equip: ['Equip', '装备'],
  forceWear: ['Force wear', '强制穿戴'],
  storagePriorityLow: ['low', '较低'],
  storagePriorityNormal: ['normal', '普通'],
  storagePriorityPreferred: ['preferred', '优先'],
  storagePriorityImportant: ['important', '重要'],
  storagePriorityCritical: ['critical', '关键'],
} as const;

export type UiTextKey = keyof typeof UI_TEXT;
export type UiTextMatch = 'exact' | 'prefix';
export type StoragePriority = 'Low' | 'Normal' | 'Preferred' | 'Important' | 'Critical';

export type UiNode = {
  targetId?: string | null;
  actionId?: string | null;
  ownerId?: string | null;
  rowKey?: string | null;
  parentTargetId?: string | null;
  surface?: string | null;
  role?: string | null;
  name?: string | null;
  source?: string | null;
  actionable?: boolean | null;
  [key: string]: unknown;
};

export type UiNodeMatchOptions<T extends UiNode = UiNode> = {
  match?: UiTextMatch;
  predicate?: (node: T) => boolean;
};

const comparable = (value: string) => value.trim().toLocaleLowerCase();

/** Matches only an exact label or an explicit prefix; it never guesses from arbitrary text. */
export function matchesUiText(value: unknown, key: UiTextKey, match: UiTextMatch = 'exact') {
  if (typeof value !== 'string') return false;
  const actual = comparable(value);
  return UI_TEXT[key].some(expected => {
    const wanted = comparable(expected);
    return match === 'prefix' ? actual.startsWith(wanted) : actual === wanted;
  });
}

export function findLocalizedNodes<T extends UiNode>(nodes: readonly T[], key: UiTextKey, options: UiNodeMatchOptions<T> = {}) {
  const match = options.match ?? 'exact';
  return nodes.filter(node => (!options.predicate || options.predicate(node)) && matchesUiText(node.name, key, match));
}

/** Requires a single current-snapshot control and reports both missing and ambiguous controls. */
export function requireUniqueUiNode<T extends UiNode>(nodes: readonly T[], predicate: (node: T) => boolean, description: string) {
  const matches = nodes.filter(predicate);
  if (matches.length === 0) throw new Error(`${description} was not found in the current UI snapshot.`);
  if (matches.length > 1) {
    const visible = matches.map(node => node.name ?? node.actionId ?? node.targetId ?? '<unnamed>').join(', ');
    throw new Error(`${description} is ambiguous in the current UI snapshot: ${visible}.`);
  }
  return matches[0];
}

export function requireLocalizedNode<T extends UiNode>(nodes: readonly T[], key: UiTextKey, options: UiNodeMatchOptions<T> = {}) {
  const expected = UI_TEXT[key].join(' / ');
  return requireUniqueUiNode(nodes, node => (!options.predicate || options.predicate(node)) && matchesUiText(node.name, key, options.match ?? 'exact'), `Localized control [${expected}]`);
}

/**
 * Rebuilds a selector from the observed node. Stable semantic identity is retained
 * whenever present, while the snapshot scope keeps duplicate rows from colliding.
 */
export function selectorForUiNode(node: UiNode): Selector {
  const selector: Selector = {};
  // Parent target IDs belong to one snapshot; locators resolve a fresh snapshot.
  for (const key of ['surface', 'role', 'actionId', 'ownerId', 'rowKey', 'source'] as const) {
    const value = node[key];
    if (typeof value === 'string') selector[key] = value;
  }
  if (typeof node.name === 'string') {
    selector.name = node.name;
    selector.exact = true;
  }
  return selector;
}

export function storagePriorityTextKey(priority: string): UiTextKey | undefined {
  const keys: Partial<Record<StoragePriority, UiTextKey>> = {
    Low: 'storagePriorityLow',
    Normal: 'storagePriorityNormal',
    Preferred: 'storagePriorityPreferred',
    Important: 'storagePriorityImportant',
    Critical: 'storagePriorityCritical',
  };
  return keys[priority as StoragePriority];
}

export function billRepeatModeTextKey(mode: string): UiTextKey | undefined {
  return ({
    RepeatCount: 'repeatCount',
    TargetCount: 'targetCount',
    Forever: 'forever',
  } as Record<string, UiTextKey>)[mode];
}
