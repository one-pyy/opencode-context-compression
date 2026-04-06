export type InternalModuleName =
  | "RuntimeConfigLoader"
  | "PromptResolver"
  | "CanonicalIdentityService"
  | "HistoryReplayReader"
  | "ResultGroupRepository"
  | "ProjectionBuilder"
  | "PolicyEngine"
  | "ReminderService"
  | "CompactionInputBuilder"
  | "CompactionRunner"
  | "OutputValidator"
  | "SendEntryGate"
  | "ChatParamsScheduler"
  | "SafeTransportAdapter";

export type InternalModuleMutability = "read-only" | "mutable";

export interface InternalModuleContract<
  Name extends InternalModuleName = InternalModuleName,
> {
  readonly module: Name;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly mutability: InternalModuleMutability;
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  readonly errorTypes: readonly string[];
  readonly idempotency: string;
  readonly dependencyDirection: {
    readonly inboundFrom: readonly ("external-adapters" | InternalModuleName)[];
    readonly outboundTo: readonly InternalModuleName[];
  };
}

export function defineInternalModuleContract<
  const Name extends InternalModuleName,
>(contract: InternalModuleContract<Name>): InternalModuleContract<Name> {
  return Object.freeze({
    ...contract,
    inputs: Object.freeze([...contract.inputs]),
    outputs: Object.freeze([...contract.outputs]),
    reads: Object.freeze([...contract.reads]),
    writes: Object.freeze([...contract.writes]),
    errorTypes: Object.freeze([...contract.errorTypes]),
    dependencyDirection: Object.freeze({
      inboundFrom: Object.freeze([...contract.dependencyDirection.inboundFrom]),
      outboundTo: Object.freeze([...contract.dependencyDirection.outboundTo]),
    }),
  });
}
