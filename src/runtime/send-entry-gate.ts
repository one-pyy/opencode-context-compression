import type { Hooks } from "@opencode-ai/plugin";

import { defineInternalModuleContract } from "../internal/module-contract.js";

type ToolExecuteBeforeHook = NonNullable<Hooks["tool.execute.before"]>;

export type ToolExecuteBeforeInput = Parameters<ToolExecuteBeforeHook>[0];
export type ToolExecuteBeforeOutput = Parameters<ToolExecuteBeforeHook>[1];

export interface ToolExecutionGateDecision {
  readonly lane: "dcp" | "passthrough";
  readonly blocked: false;
}

export interface ToolExecutionGateService {
  beforeExecution(
    input: ToolExecuteBeforeInput,
  ):
    | Promise<ToolExecutionGateDecision>
    | ToolExecutionGateDecision;
}

export interface ToolExecuteBeforeExternalContract {
  readonly seam: "tool.execute.before";
  readonly inputShape: "tool name sessionID callID and mutable args output";
  readonly outputShape: "same args object unless an explicit gate policy mutates it";
  readonly callTiming: "immediately before a tool executes";
  readonly visibleSideEffects: readonly [
    "non-DCP tools bypass",
    "must not run projection or result-group rendering"
  ];
  readonly errorSemantics: readonly [
    "gate policy may throw admission errors later",
    "Task 6 adapter keeps output args unchanged"
  ];
  readonly relationToRuntime: {
    readonly replay: "does not replay mark history";
    readonly resultGroups: "does not read or write result-groups";
    readonly scheduler: "coordinates with send-entry gating only and stays outside projection";
  };
}

export interface GateResult {
  readonly waited: boolean;
  readonly releasedBy: "no-lock" | "lock-cleared" | "timeout";
  readonly reason: string;
}

export interface SendEntryGate {
  waitIfNeeded(sessionId: string): Promise<GateResult>;
}

export const SEND_ENTRY_GATE_INTERNAL_CONTRACT = defineInternalModuleContract({
  module: "SendEntryGate",
  inputs: ["sessionId"],
  outputs: ["GateResult"],
  mutability: "read-only",
  reads: ["runtime lock state"],
  writes: [],
  errorTypes: ["LOCK_TIMEOUT", "SESSION_NOT_READY"],
  idempotency:
    "Observationally idempotent for the same lock state snapshot, though elapsed waiting time may differ.",
  dependencyDirection: {
    inboundFrom: ["external-adapters"],
    outboundTo: [],
  },
});

export const TOOL_EXECUTE_BEFORE_EXTERNAL_CONTRACT = Object.freeze({
  seam: "tool.execute.before",
  inputShape: "tool name sessionID callID and mutable args output",
  outputShape: "same args object unless an explicit gate policy mutates it",
  callTiming: "immediately before a tool executes",
  visibleSideEffects: [
    "non-DCP tools bypass",
    "must not run projection or result-group rendering",
  ],
  errorSemantics: [
    "gate policy may throw admission errors later",
    "Task 6 adapter keeps output args unchanged",
  ],
  relationToRuntime: {
    replay: "does not replay mark history",
    resultGroups: "does not read or write result-groups",
    scheduler:
      "coordinates with send-entry gating only and stays outside projection",
  },
} satisfies ToolExecuteBeforeExternalContract);

export function createDefaultToolExecutionGate(): ToolExecutionGateService {
  return {
    beforeExecution(input) {
      return {
        lane: input.tool === "compression_mark" ? "dcp" : "passthrough",
        blocked: false,
      };
    },
  } satisfies ToolExecutionGateService;
}

export function createStaticSendEntryGate(
  result: GateResult = {
    waited: false,
    releasedBy: "no-lock",
    reason: "no active compaction lock",
  },
): SendEntryGate {
  return {
    async waitIfNeeded() {
      return result;
    },
  } satisfies SendEntryGate;
}

export function createToolExecuteBeforeHook(options: {
  readonly gate?: ToolExecutionGateService;
} = {}): ToolExecuteBeforeHook {
  const gate = options.gate ?? createDefaultToolExecutionGate();

  return async (input) => {
    await gate.beforeExecution(input);
  };
}

export function createSendEntryGateHooks(options: {
  readonly gate?: ToolExecutionGateService;
} = {}): Pick<Hooks, "tool.execute.before"> {
  return {
    "tool.execute.before": createToolExecuteBeforeHook(options),
  };
}
