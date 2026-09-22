export type InspectionSummaryOptions = {
  reportPath?: string;
  maxItemsPerGroup?: number;
};

type RecordValue = Record<string, any>;

type Severity = {
  label: string;
  rank: number;
};

type Finding = {
  severity?: unknown;
  kind?: unknown;
  title?: unknown;
  evidence?: unknown;
  suggestion?: unknown;
};

type FindingGroup = {
  severity: Severity;
  kind: string;
  category: string | null;
  exposureBucket: ExposureBucket | null;
  findings: Finding[];
};

type ExposureBucket = 'exposed' | 'covered-stored' | 'insufficient';

const CATEGORY_LABELS: Record<string, string> = {
  food: '食品',
  medicine: '药品',
  equipment: '装备',
  corpse: '尸体',
  material: '材料',
  other: '其他',
};

const EXPOSURE_LABELS: Record<ExposureBucket, string> = {
  exposed: '露天',
  'covered-stored': '有顶且已知存储',
  insufficient: '证据不足',
};

function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}

function list(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown, fallback = ''): string {
  return value === undefined || value === null || value === '' ? fallback : String(value);
}

function numberText(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

function truncate(value: unknown, limit: number): string {
  const source = text(value);
  return source.length <= limit ? source : `${source.slice(0, Math.max(0, limit - 1))}…`;
}

function severityOf(value: unknown): Severity {
  const normalized = text(value, 'unknown').toLowerCase();
  if (['critical', 'emergency', 'urgent'].includes(normalized)) return { label: 'CRITICAL', rank: 0 };
  if (['important', 'error'].includes(normalized)) return { label: 'IMPORTANT', rank: 1 };
  if (normalized === 'warning') return { label: 'WARNING', rank: 2 };
  if (normalized === 'watch') return { label: 'WATCH', rank: 3 };
  if (['info', 'notice'].includes(normalized)) return { label: 'INFO', rank: 4 };
  return { label: 'UNKNOWN', rank: 5 };
}

function positionOf(value: RecordValue): string | null {
  const candidates = [value.position, value.positionInt, value.facts?.positionInt, value.facts?.position];
  for (const candidate of candidates) {
    const point = record(candidate);
    const x = numberText(point.x);
    const z = numberText(point.z);
    if (x !== null && z !== null) return `(${x},${z})`;
  }
  return null;
}

function itemCategory(finding: Finding): string {
  const evidence = record(finding.evidence);
  const def = text(evidence.def ?? evidence.defName).toLowerCase();
  const category = text(evidence.category).toLowerCase();
  const haystack = `${def} ${category}`;
  if (haystack.includes('corpse') || def.startsWith('corpse_')) return 'corpse';
  if (haystack.includes('medicine') || haystack.includes('herb') || haystack.includes('medical')) return 'medicine';
  if (haystack.includes('food') || /meal|rice|berry|berries|meat|rawfood/.test(haystack)) return 'food';
  if (haystack.includes('equipment') || haystack.includes('weapon') || haystack.includes('apparel')) return 'equipment';
  if (haystack.includes('material') || haystack.includes('textile') || haystack.includes('leather') || haystack.includes('wood') || haystack.includes('chunk')) return 'material';
  return 'other';
}

function groupCategory(finding: Finding): string | null {
  const kind = text(finding.kind, 'unknown');
  if (kind === 'ground-item-condition') return itemCategory(finding);
  if (/corpse/i.test(kind)) return 'corpse';
  return null;
}

function roofedOf(evidence: RecordValue): boolean | null {
  const roof = record(evidence.roof);
  if (typeof roof.roofed === 'boolean') return roof.roofed;
  const exposure = record(evidence.exposure);
  return typeof exposure.roofed === 'boolean' ? exposure.roofed : null;
}

function storageStateOf(evidence: RecordValue): { state: 'known' | 'not-known' | 'unknown'; label: string } {
  const storage = record(evidence.storage);
  const hasStorageEvidence = ['inKnownStorageFootprint', 'inKnownStockpileCell', 'inStorageBuildingFootprint']
    .some(key => typeof storage[key] === 'boolean');
  const labels: string[] = [];
  if (storage.inKnownStockpileCell === true) labels.push('known-stockpile');
  if (storage.inStorageBuildingFootprint === true) labels.push('known-storage-building');
  if (storage.inKnownStorageFootprint === true && labels.length === 0) labels.push('known-footprint');
  if (labels.length) return { state: 'known', label: labels.join('+') };
  if (hasStorageEvidence) return { state: 'not-known', label: 'not-in-known-storage' };
  return { state: 'unknown', label: 'unknown' };
}

function exposureBucketOf(finding: Finding): ExposureBucket | null {
  if (groupCategory(finding) === null) return null;
  const evidence = record(finding.evidence);
  const roofed = roofedOf(evidence);
  const storage = storageStateOf(evidence);
  if (roofed === false) return 'exposed';
  if (roofed === true && storage.state === 'known') return 'covered-stored';
  return 'insufficient';
}

function groupsFor(findings: Finding[]): FindingGroup[] {
  const groups = new Map<string, FindingGroup>();
  for (const finding of findings) {
    const severity = severityOf(finding.severity);
    const kind = text(finding.kind, 'unknown-kind');
    const category = groupCategory(finding);
    const exposureBucket = exposureBucketOf(finding);
    const key = `${severity.label}|${kind}|${category ?? ''}|${exposureBucket ?? ''}`;
    const existing = groups.get(key);
    if (existing) existing.findings.push(finding);
    else groups.set(key, { severity, kind, category, exposureBucket, findings: [finding] });
  }
  const exposureRank: Record<string, number> = { exposed: 0, 'covered-stored': 1, insufficient: 2, '': 3 };
  return [...groups.values()].sort((left, right) =>
    left.severity.rank - right.severity.rank
    || left.kind.localeCompare(right.kind)
    || text(left.category).localeCompare(text(right.category))
    || exposureRank[left.exposureBucket ?? ''] - exposureRank[right.exposureBucket ?? '']);
}

function quantityOf(evidence: RecordValue): number | null {
  const value = evidence.quantity ?? evidence.stackCount ?? evidence.facts?.stackCount;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function idOf(evidence: RecordValue): string {
  return text(evidence.thingIDNumber ?? evidence.id ?? evidence.pawnId ?? evidence.roomId ?? evidence.defName, 'unknown-id');
}

function conditionLabel(evidence: RecordValue): string | null {
  const condition = record(evidence.condition);
  if (!Object.keys(condition).length) return null;
  const current = condition.currentHitPoints ?? condition.hitPointsInt ?? evidence.hitPointsInt;
  const currentText = numberText(current) ?? text(current, 'unknown');
  const baseText = numberText(condition.baseMaxHitPoints);
  const actualText = numberText(condition.actualMaxHitPoints);
  const reportedMaxText = numberText(condition.maxHitPoints);
  const effectiveMaxUnknown = condition.actualMaxHitPoints === 'unknown'
    || condition.actualMaxHitPointsStatus === 'unknown'
    || condition.maxHitPointsBasis === 'base-def-only'
    || condition.maxHitPointsBasis === 'base-def-resource-like'
    || (baseText !== null && condition.ratioIsAccurate !== true && condition.actualMaxHitPointsStatus === 'not-read-material-quality');
  if (condition.damageStatus === 'not-applicable') return '耐久不适用';
  if (effectiveMaxUnknown) {
    if (baseText !== null) return `耐久候选 ${currentText}/base${baseText}，有效maxHP=unknown`;
    return `耐久候选 ${currentText}/maxHP=unknown`;
  }
  const maxText = actualText ?? reportedMaxText;
  if (maxText === null) return `耐久候选 ${currentText}/maxHP=unknown`;
  if (condition.ratioIsAccurate !== true) return `基础值候选 ${currentText}/${maxText}，比例未确认`;
  if (condition.lowDurability === true || condition.damageStatus === 'low') return `低耐久 ${currentText}/${maxText}`;
  if (condition.isDamaged === true || condition.damageStatus === 'damaged') return `已确认损坏 ${currentText}/${maxText}`;
  if (typeof condition.damageStatus === 'string' && condition.damageStatus.includes('candidate')) return `损耗候选 ${currentText}/${maxText}`;
  return `状态 ${currentText}/${maxText}`;
}

function itemLine(finding: Finding): string {
  const evidence = record(finding.evidence);
  const name = text(evidence.def ?? evidence.defName, 'unknown-def');
  const quantity = quantityOf(evidence);
  const position = positionOf(evidence) ?? '(坐标未知)';
  const condition = conditionLabel(evidence);
  const roofed = roofedOf(evidence);
  const exposure = text(record(evidence.exposure).exposure, 'unknown');
  const storage = storageStateOf(evidence);
  const roofedLabel = roofed === null ? 'unknown' : `${roofed}${roofed ? '(有顶)' : '(露天)'}`;
  return `${name}#${idOf(evidence)} ${position}${quantity === null ? '' : ` ×${numberText(quantity)}`} [exposure=${exposure}; roofed=${roofedLabel}; storage=${storage.label}] ${condition ?? '状态候选'}`;
}

function evidenceLine(finding: Finding): string {
  const evidence = record(finding.evidence);
  const parts: string[] = [];
  const pawn = evidence.pawnId ? `${text(evidence.name, 'pawn')}#${evidence.pawnId}` : '';
  if (pawn) parts.push(pawn);
  else if (evidence.roomId !== undefined) parts.push(`room#${evidence.roomId}`);
  else if (evidence.thingIDNumber !== undefined || evidence.id !== undefined) parts.push(`#${idOf(evidence)}`);
  const position = positionOf(evidence);
  if (position) parts.push(position);
  for (const key of ['mood', 'food', 'rest', 'temperature', 'roofed', 'weatherProtected']) {
    const value = evidence[key];
    if (value !== undefined && value !== null) parts.push(`${key}=${text(value)}`);
  }
  if (Array.isArray(evidence.conditions) && evidence.conditions.length) {
    const conditions = evidence.conditions.map((condition: any) => text(condition?.def, 'unknown-condition')).join(',');
    parts.push(`conditions=${truncate(conditions, 90)}`);
  }
  return parts.join(' ');
}

function groupQuantity(findings: Finding[]): number | null {
  const quantities = findings.map(finding => quantityOf(record(finding.evidence))).filter((value): value is number => value !== null);
  return quantities.length ? quantities.reduce((sum, value) => sum + value, 0) : null;
}

function isWatchLossCandidate(finding: Finding): boolean {
  const condition = record(record(finding.evidence).condition);
  const damageStatus = text(condition.damageStatus).toLowerCase();
  return condition.isDamaged !== true
    && condition.lowDurability !== true
    && damageStatus.includes('candidate');
}

function suggestionForGroup(group: FindingGroup): string | null {
  const original = text(group.findings[0]?.suggestion);
  if (group.severity.rank <= 2 || group.kind !== 'ground-item-condition') return original || null;
  if (group.exposureBucket === 'covered-stored' && group.findings.every(isWatchLossCandidate)) {
    return '已有 roofed=true 与已知储存占地证据，无需重复核对屋顶/搬运；当前仅为WATCH损耗候选，其他损耗、腐坏、冷藏与健康状态仍未判定。';
  }
  if (group.exposureBucket === 'exposed') {
    if (group.category === 'corpse') {
      return '露天尸体先区分新鲜可回收、近营地待清理和远处腐烂残骸；不能仅凭露天或旧损伤就要求全部搬回。';
    }
    if (group.category === 'material' && group.findings.every(finding => {
      const deterioration = record(record(record(finding.evidence).condition).deterioration);
      return typeof deterioration.rate !== 'number' || deterioration.rate <= 0;
    })) {
      return '仅有露天与历史耐久候选，尚无正的损耗速率证据；保留观察，不据此自动生成搬运订单。';
    }
    const stockpile = group.findings.some(finding => storageStateOf(record(finding.evidence)).label.includes('known-stockpile'));
    return `已有 roofed=false 露天证据${stockpile ? '；stockpile占地不等于防雨' : ''}；如非生产现场暂存，再安排有顶储存或搬运核实，腐坏/损耗剩余状态仍未知。`;
  }
  if (group.exposureBucket === 'insufficient') {
    return '屋顶或储存证据不足，保留为候选；不要据此推断搬运失败、腐坏程度、冷藏或健康状态。';
  }
  return original || null;
}

function formatGroup(group: FindingGroup, maxItems: number, reportPath: string): string[] {
  const lines: string[] = [];
  const shown = group.findings.slice(0, maxItems);
  const remaining = Math.max(0, group.findings.length - shown.length);
  const category = group.category ? `·${CATEGORY_LABELS[group.category] ?? group.category}` : '';
  const exposure = group.exposureBucket ? `·${EXPOSURE_LABELS[group.exposureBucket]}` : '';
  const quantity = groupQuantity(group.findings);
  const quantityKnown = group.findings.filter(finding => quantityOf(record(finding.evidence)) !== null).length;
  const totalLabel = group.kind === 'ground-item-condition' ? `总${group.findings.length}项` : `总${group.findings.length}条`;
  const quantityLabel = quantity === null ? '' : `，${quantityKnown < group.findings.length ? '已知' : ''}数量合计${numberText(quantity)}${quantityKnown < group.findings.length ? `（${quantityKnown}/${group.findings.length}项数量已知）` : ''}`;
  const shownLabel = `，列出${shown.length}/${group.findings.length}项`;
  lines.push(`【${group.severity.label}】${group.kind}${category}${exposure}：${totalLabel}${quantityLabel}${shownLabel}${remaining ? `，remaining=${remaining}；完整报告：${reportPath}` : ''}`);
  for (const finding of shown) {
    const isItem = group.kind === 'ground-item-condition';
    lines.push(`- ${isItem ? itemLine(finding) : `${text(finding.title, group.kind)}${evidenceLine(finding) ? `｜${evidenceLine(finding)}` : ''}`}`);
  }
  const suggestion = truncate(suggestionForGroup(group), 140);
  if (suggestion) lines.push(`  建议：${suggestion}`);
  return lines;
}

function coverageGapLines(report: RecordValue): string[] {
  const gaps = list(report.coverageGaps ?? report.gaps);
  if (!gaps.length) return ['coverageGaps=0'];
  return ['coverageGaps=' + gaps.length, ...gaps.map(gap => {
    const entry = record(gap);
    const error = record(entry.error);
    const code = text(error.code ?? entry.code, 'UNKNOWN_GAP');
    const message = text(error.message ?? entry.message, 'coverage evidence unavailable');
    return `- ${text(entry.section ?? entry.key, 'unknown-section')} [${code}] ${truncate(message, 180)}`;
  })];
}

/** Purely formats an inspectColony report; it performs no reads, writes, or runtime calls. */
export function formatInspectionSummary(reportValue: unknown, options: InspectionSummaryOptions = {}): string {
  const report = record(reportValue);
  const observation = record(report.observation);
  const tickMin = observation.tickMin ?? observation.tick ?? report.tick ?? 'unknown';
  const tickMax = observation.tickMax ?? observation.tick ?? report.tick ?? 'unknown';
  const reportPath = options.reportPath ?? 'full-inspection-latest.json';
  const maxItems = Math.max(1, Math.floor(options.maxItemsPerGroup ?? 4));
  const findings = list(record(report.findings).current) as Finding[];
  const lines = [
    `巡检短摘要｜status=${text(report.status, 'unknown')}｜tick=${text(tickMin)}–${text(tickMax)}｜findings=${findings.length}`,
    `优先级：CRITICAL > IMPORTANT > WARNING > WATCH > INFO > UNKNOWN；未知耐久仅列候选。`,
    ...coverageGapLines(report),
    `完整证据：${reportPath}`,
  ];
  const groups = groupsFor(findings);
  if (!groups.length) lines.push('当前没有 findings。');
  else for (const group of groups) lines.push(...formatGroup(group, maxItems, reportPath));
  return lines.join('\n');
}
