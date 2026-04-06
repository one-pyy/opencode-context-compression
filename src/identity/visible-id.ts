export type VisibleKind = "protected" | "compressible" | "referable";

export interface VisibleIdAllocationInput {
  readonly canonicalId: string;
  readonly visibleKind: VisibleKind;
  readonly allocatedAt: string;
}

export interface VisibleIdAllocation {
  readonly canonicalId: string;
  readonly visibleKind: VisibleKind;
  readonly visibleSeq: number;
  readonly visibleBase62: string;
  readonly assignedVisibleId: string;
  readonly allocatedAt: string;
}
