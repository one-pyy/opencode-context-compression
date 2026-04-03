import type { Hooks } from "@opencode-ai/plugin";

type MessagesTransformHook = NonNullable<Hooks["experimental.chat.messages.transform"]>;
type ChatParamsHook = NonNullable<Hooks["chat.params"]>;
type ToolExecuteBeforeHook = NonNullable<Hooks["tool.execute.before"]>;

export type MessagesTransformInput = Parameters<MessagesTransformHook>[0];
export type MessagesTransformOutput = Parameters<MessagesTransformHook>[1];
export type ChatParamsInput = Parameters<ChatParamsHook>[0];
export type ChatParamsOutput = Parameters<ChatParamsHook>[1];
export type ToolExecuteBeforeInput = Parameters<ToolExecuteBeforeHook>[0];
export type ToolExecuteBeforeOutput = Parameters<ToolExecuteBeforeHook>[1];
export type TransformEnvelope = MessagesTransformOutput["messages"][number];
export type TransformMessage = TransformEnvelope["info"];
export type TransformPart = TransformEnvelope["parts"][number];

export type SeamName =
  | "experimental.chat.messages.transform"
  | "chat.params"
  | "tool.execute.before";

type ShapeKind =
  | "array"
  | "bigint"
  | "boolean"
  | "function"
  | "null"
  | "number"
  | "object"
  | "string"
  | "symbol"
  | "undefined";

export type ShapeSummary =
  | {
      kind: Exclude<ShapeKind, "array" | "object">;
    }
  | {
      kind: "array";
      length: number;
      elementKinds: ShapeKind[];
      sample?: ShapeSummary;
    }
  | {
      kind: "object";
      keys: string[];
      entries?: Record<string, ShapeSummary>;
    };

export type IdentityFieldObservation = {
  path: string;
  value: string;
};

export type SeamObservation = {
  seam: SeamName;
  sequence: number;
  inputShape: ShapeSummary;
  outputShape: ShapeSummary;
  identityFields: IdentityFieldObservation[];
};

type ObservationDraft = Omit<SeamObservation, "sequence">;

export type SeamObservationJournal = {
  readonly entries: ReadonlyArray<SeamObservation>;
  clear(): void;
  record(entry: ObservationDraft): SeamObservation;
};

export type NoopObservationHooks = {
  "experimental.chat.messages.transform": MessagesTransformHook;
  "chat.params": ChatParamsHook;
  "tool.execute.before": ToolExecuteBeforeHook;
};

const MAX_SHAPE_DEPTH = 3;

export function createSeamObservationJournal(): SeamObservationJournal {
  const entries: SeamObservation[] = [];
  let nextSequence = 1;

  return {
    get entries() {
      return entries;
    },
    clear() {
      entries.length = 0;
      nextSequence = 1;
    },
    record(entry) {
      const observed = {
        ...entry,
        sequence: nextSequence++,
      } satisfies SeamObservation;

      entries.push(observed);
      return observed;
    },
  };
}

export function observeMessagesTransform(
  input: MessagesTransformInput,
  output: MessagesTransformOutput,
): ObservationDraft {
  const identityFields: IdentityFieldObservation[] = [];

  output.messages.forEach((message, messageIndex) => {
    captureMessageIdentityFields(identityFields, `output.messages[${messageIndex}].info`, message.info);
    captureTransformPartIdentityFields(
      identityFields,
      `output.messages[${messageIndex}].parts`,
      message.parts,
    );
  });

  return {
    seam: "experimental.chat.messages.transform",
    inputShape: summarizeShape(input),
    outputShape: summarizeShape(output),
    identityFields,
  };
}

export function observeChatParams(input: ChatParamsInput, output: ChatParamsOutput): ObservationDraft {
  const identityFields: IdentityFieldObservation[] = [];

  captureStringIdentityField(identityFields, "input.sessionID", input.sessionID);
  captureMessageIdentityFields(identityFields, "input.message", input.message);

  return {
    seam: "chat.params",
    inputShape: summarizeShape(input),
    outputShape: summarizeShape(output),
    identityFields,
  };
}

export function observeToolExecuteBefore(
  input: ToolExecuteBeforeInput,
  output: ToolExecuteBeforeOutput,
): ObservationDraft {
  const identityFields: IdentityFieldObservation[] = [];

  captureStringIdentityField(identityFields, "input.sessionID", input.sessionID);
  captureStringIdentityField(identityFields, "input.callID", input.callID);

  return {
    seam: "tool.execute.before",
    inputShape: summarizeShape(input),
    outputShape: summarizeShape(output),
    identityFields,
  };
}

export function createNoopObservationHooks(
  journal: SeamObservationJournal = createSeamObservationJournal(),
): {
  journal: SeamObservationJournal;
  hooks: NoopObservationHooks;
} {
  return {
    journal,
    hooks: {
      "experimental.chat.messages.transform": async (input, output) => {
        journal.record(observeMessagesTransform(input, output));
      },
      "chat.params": async (input, output) => {
        journal.record(observeChatParams(input, output));
      },
      "tool.execute.before": async (input, output) => {
        journal.record(observeToolExecuteBefore(input, output));
      },
    },
  };
}

function summarizeShape(value: unknown, depth = 0): ShapeSummary {
  if (value === null) {
    return { kind: "null" };
  }

  if (Array.isArray(value)) {
    const sampledShapes = value.slice(0, 3).map((item) => summarizeShape(item, depth + 1));

    return {
      kind: "array",
      length: value.length,
      elementKinds: [...new Set(sampledShapes.map((item) => item.kind))].sort() as ShapeKind[],
      sample: depth >= MAX_SHAPE_DEPTH || sampledShapes.length === 0 ? undefined : sampledShapes[0],
    };
  }

  const valueType = typeof value;
  if (valueType !== "object") {
    return { kind: valueType };
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();

  if (depth >= MAX_SHAPE_DEPTH) {
    return {
      kind: "object",
      keys,
    };
  }

  const entries = Object.fromEntries(keys.map((key) => [key, summarizeShape(record[key], depth + 1)]));

  return {
    kind: "object",
    keys,
    entries,
  };
}

function captureMessageIdentityFields(
  fields: IdentityFieldObservation[],
  basePath: string,
  message: TransformMessage | ChatParamsInput["message"],
): void {
  captureStringIdentityField(fields, `${basePath}.id`, message.id);
  captureStringIdentityField(fields, `${basePath}.sessionID`, message.sessionID);

  if ("parentID" in message && typeof message.parentID === "string") {
    captureStringIdentityField(fields, `${basePath}.parentID`, message.parentID);
  }
}

function captureTransformPartIdentityFields(
  fields: IdentityFieldObservation[],
  basePath: string,
  parts: TransformPart[],
): void {
  parts.forEach((part, index) => {
    captureRecordIdentityField(fields, `${basePath}[${index}].id`, part, "id");
    captureRecordIdentityField(fields, `${basePath}[${index}].sessionID`, part, "sessionID");
    captureRecordIdentityField(fields, `${basePath}[${index}].messageID`, part, "messageID");
  });
}

function captureRecordIdentityField(
  fields: IdentityFieldObservation[],
  path: string,
  value: Record<string, unknown>,
  key: string,
): void {
  const candidate = value[key];
  if (typeof candidate === "string" && candidate.length > 0) {
    fields.push({ path, value: candidate });
  }
}

function captureStringIdentityField(
  fields: IdentityFieldObservation[],
  path: string,
  value: string | undefined,
): void {
  if (typeof value === "string" && value.length > 0) {
    fields.push({ path, value });
  }
}
