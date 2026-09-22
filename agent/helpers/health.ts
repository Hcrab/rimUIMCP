export type HealthCondition = {
  def: string;
  part?: string | null;
  severity: number;
  reference?: {id: string; sessionId: string; worldEpoch: number};
};

export type ObservedHealth = {conditions?: HealthCondition[]};

function conditionKey(condition: HealthCondition, index: number) {
  const ref = condition.reference;
  return ref
    ? `${ref.sessionId}:${ref.worldEpoch}:${ref.id}`
    : `${condition.def}:${condition.part ?? ''}:${index}`;
}

/** Compare individual injuries, so healing on one arm cannot conceal a new hit on the other. */
export function worseningConditions(before: ObservedHealth, after: ObservedHealth) {
  const previous = new Map((before.conditions ?? []).map((condition, index) => [conditionKey(condition, index), condition]));
  return (after.conditions ?? []).filter((condition, index) => {
    const old = previous.get(conditionKey(condition, index));
    return !old || old.def !== condition.def || old.part !== condition.part
      || !Number.isFinite(condition.severity) || !Number.isFinite(old.severity)
      || condition.severity > old.severity + 0.0001;
  });
}
