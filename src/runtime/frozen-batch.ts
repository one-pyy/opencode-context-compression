export interface FrozenBatch<T> {
  readonly frozenAtMs: number;
  readonly members: readonly T[];
  readonly memberIDs: readonly string[];
  readonly size: number;
  has(memberID: string): boolean;
}

export function freezeBatch<T>(
  members: readonly T[],
  identifyMember: (member: T) => string,
  now: () => number = Date.now,
): FrozenBatch<T> {
  const snapshot = Object.freeze([...members]);
  const memberIDs = Object.freeze(snapshot.map((member) => identifyMember(member)));
  const memberIDSet = new Set(memberIDs);

  return Object.freeze({
    frozenAtMs: now(),
    members: snapshot,
    memberIDs,
    size: snapshot.length,
    has(memberID: string) {
      return memberIDSet.has(memberID);
    },
  });
}
