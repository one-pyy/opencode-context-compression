import { tool, type ToolContext } from "@opencode-ai/plugin";

import { persistMark } from "../marks/mark-service.js";
import { createSqliteSessionStateStore, type CompactionRoute, type HostMessageRecord, type JsonValue } from "../state/store.js";
import type { TransformEnvelope, TransformMessage, TransformPart } from "../seams/noop-observation.js";

const VISIBLE_PREFIX_PATTERN = /^\[(protected|referable|compressible)_([^\]]+)\](?:\s|$)/u;
const VISIBLE_STATE_PREFIX_PATTERN = /^(?:protected|referable|compressible)_(.+)$/u;
const REMINDER_MESSAGE_ID_FRAGMENT = ":dcp-reminder:";

export interface CreateCompressionMarkToolOptions {
  readonly pluginDirectory: string;
}

interface CompressionMarkArguments {
  readonly contractVersion: "v1";
  readonly route: CompactionRoute;
  readonly target: {
    readonly startVisibleMessageID: string;
    readonly endVisibleMessageID?: string;
  };
  readonly label?: string;
}

interface LiveCompressionMarkToolContext extends ToolContext {
  readonly messages?: readonly TransformEnvelope[];
}

interface VisibleProjectedMessage {
  readonly order: number;
  readonly state: "protected" | "referable" | "compressible";
  readonly visibleMessageID: string;
  readonly hostMessageID: string;
  readonly role: string;
}

export function createCompressionMarkTool(options: CreateCompressionMarkToolOptions) {
  return tool({
    description: "Persist a compaction mark for the current visible transcript.",
    args: {
      contractVersion: tool.schema
        .literal("v1")
        .describe("Frozen compression_mark argument contract version. Use 'v1'."),
      route: tool.schema
        .enum(["keep", "delete"])
        .describe("Compaction route to apply to the selected canonical visible span."),
      target: tool.schema
        .object({
          startVisibleMessageID: tool.schema
            .string()
            .trim()
            .min(1)
            .describe("Start visible message id from the current projected transcript, for example '000002_ab'."),
          endVisibleMessageID: tool.schema
            .string()
            .trim()
            .min(1)
            .optional()
            .describe("Optional inclusive end visible message id from the current projected transcript."),
        })
        .describe("Inclusive visible source span to persist as the durable mark source snapshot."),
      label: tool.schema
        .string()
        .trim()
        .min(1)
        .max(200)
        .optional()
        .describe("Optional human label for lookup convenience only; it is not the durable source of truth."),
    },
    async execute(args, context) {
      return executeCompressionMark(options, args as CompressionMarkArguments, context as LiveCompressionMarkToolContext);
    },
  });
}

async function executeCompressionMark(
  options: CreateCompressionMarkToolOptions,
  args: CompressionMarkArguments,
  context: LiveCompressionMarkToolContext,
): Promise<string> {
  const store = createSqliteSessionStateStore({
    pluginDirectory: options.pluginDirectory,
    sessionID: context.sessionID,
  });

  try {
    const liveMessages = readLiveMessages(context);
    ensureCanonicalHostHistory(store, liveMessages, context.messageID);

    const existing = store.getMarkByToolCallMessageID(context.messageID);
    if (existing !== undefined) {
      return renderExistingMark(existing.markID, store.listMarkSourceMessages(existing.markID).map((message) => message.hostMessageID));
    }

    const resolvedRange = resolveVisibleTargetRange(collectVisibleProjectedMessages(liveMessages), args.target);
    const resolvedVisibleMessageIDs = resolvedRange.map((message) => message.visibleMessageID);
    const resolvedHostMessageIDs = resolvedRange.map((message) => message.hostMessageID);
    const normalizedStartVisibleMessageID = normalizeVisibleSelector(args.target.startVisibleMessageID);
    const normalizedEndVisibleMessageID = normalizeVisibleSelector(
      args.target.endVisibleMessageID ?? args.target.startVisibleMessageID,
    );
    const defaultLabel = buildDefaultLabel(resolvedVisibleMessageIDs);
    const metadata = {
      toolName: "compression_mark",
      contractVersion: args.contractVersion,
      target: {
        startVisibleMessageID: resolvedVisibleMessageIDs[0],
        endVisibleMessageID: resolvedVisibleMessageIDs[resolvedVisibleMessageIDs.length - 1],
      },
      selectors: {
        startVisibleMessageID: normalizedStartVisibleMessageID,
        endVisibleMessageID: normalizedEndVisibleMessageID,
      },
      resolvedVisibleMessageIDs,
      resolvedHostMessageIDs,
    } satisfies JsonValue;

    const mark = persistMark({
      store,
      markID: `${context.sessionID}:compression-mark:${context.messageID}`,
      toolCallMessageID: context.messageID,
      route: args.route,
      markLabel: args.label ?? defaultLabel,
      metadata,
      snapshotMetadata: metadata,
      sourceMessages: resolvedRange.map((message) => ({
        hostMessageID: message.hostMessageID,
      })),
    }).mark;

    return [
      `Persisted compression_mark ${mark.markID}.`,
      `Route: ${mark.route}.`,
      `Visible span: ${resolvedVisibleMessageIDs.join(" -> ")}.`,
      `Host messages: ${resolvedHostMessageIDs.join(", ")}.`,
    ].join(" ");
  } finally {
    store.close();
  }
}

function readLiveMessages(context: LiveCompressionMarkToolContext): readonly TransformEnvelope[] {
  if (!Array.isArray(context.messages) || context.messages.length === 0) {
    throw new Error(
      "compression_mark requires the current projected transcript in tool context.messages before resolving visible targets.",
    );
  }

  return context.messages;
}

function ensureCanonicalHostHistory(
  store: ReturnType<typeof createSqliteSessionStateStore>,
  liveMessages: readonly TransformEnvelope[],
  toolCallMessageID: string,
): void {
  if (store.getHostMessage(toolCallMessageID) !== undefined) {
    return;
  }

  const existingPresentMessages = store.listHostMessages({ presentOnly: true });
  const canonicalMessages =
    existingPresentMessages.length > 0
      ? existingPresentMessages.map(toCanonicalHostMessageInput)
      : seedCanonicalMessagesFromVisibleTranscript(liveMessages);

  const byHostMessageID = new Map(canonicalMessages.map((message) => [message.hostMessageID, message]));
  byHostMessageID.set(toolCallMessageID, {
    hostMessageID: toolCallMessageID,
    canonicalMessageID: toolCallMessageID,
    role: "assistant",
  });

  store.syncCanonicalHostMessages({
    revision: store.getSessionState().lastCanonicalRevision,
    messages: [...byHostMessageID.values()],
  });
}

function toCanonicalHostMessageInput(message: HostMessageRecord) {
  return {
    hostMessageID: message.hostMessageID,
    canonicalMessageID: message.canonicalMessageID,
    role: message.role,
    hostCreatedAtMs: message.hostCreatedAtMs,
    metadata: message.metadata,
  };
}

function seedCanonicalMessagesFromVisibleTranscript(liveMessages: readonly TransformEnvelope[]) {
  const canonicalMessages = new Map<string, ReturnType<typeof toSeedCanonicalHostMessageInput>>();

  for (const message of liveMessages) {
    const visiblePrefix = parseVisiblePrefix(readPrimaryText(message.parts));
    if (visiblePrefix === undefined || visiblePrefix.state === "referable") {
      continue;
    }

    const hostMessageID = readNonEmptyString(message.info.id, "message.info.id");
    if (hostMessageID.includes(REMINDER_MESSAGE_ID_FRAGMENT)) {
      continue;
    }

    canonicalMessages.set(hostMessageID, toSeedCanonicalHostMessageInput(message.info, hostMessageID));
  }

  return [...canonicalMessages.values()];
}

function toSeedCanonicalHostMessageInput(message: TransformMessage, hostMessageID: string) {
  return {
    hostMessageID,
    canonicalMessageID: hostMessageID,
    role: readNonEmptyString(message.role, "message.info.role"),
    ...(typeof message.time?.created === "number" ? { hostCreatedAtMs: message.time.created } : {}),
  };
}

function collectVisibleProjectedMessages(liveMessages: readonly TransformEnvelope[]): VisibleProjectedMessage[] {
  return liveMessages.flatMap((message, order) => {
    const visiblePrefix = parseVisiblePrefix(readPrimaryText(message.parts));
    if (visiblePrefix === undefined) {
      return [];
    }

    return [
      {
        order,
        state: visiblePrefix.state,
        visibleMessageID: visiblePrefix.visibleMessageID,
        hostMessageID: readNonEmptyString(message.info.id, "message.info.id"),
        role: readNonEmptyString(message.info.role, "message.info.role"),
      } satisfies VisibleProjectedMessage,
    ];
  });
}

function resolveVisibleTargetRange(
  visibleMessages: readonly VisibleProjectedMessage[],
  target: CompressionMarkArguments["target"],
): VisibleProjectedMessage[] {
  const startVisibleMessageID = normalizeVisibleSelector(target.startVisibleMessageID);
  const endVisibleMessageID = normalizeVisibleSelector(target.endVisibleMessageID ?? target.startVisibleMessageID);
  const byVisibleMessageID = new Map(visibleMessages.map((message) => [message.visibleMessageID, message]));
  const start = byVisibleMessageID.get(startVisibleMessageID);
  const end = byVisibleMessageID.get(endVisibleMessageID);

  if (start === undefined) {
    throw new Error(
      `compression_mark could not resolve start visible message '${startVisibleMessageID}' in the current projected transcript.`,
    );
  }
  if (end === undefined) {
    throw new Error(
      `compression_mark could not resolve end visible message '${endVisibleMessageID}' in the current projected transcript.`,
    );
  }
  if (start.order > end.order) {
    throw new Error(
      `compression_mark requires target.startVisibleMessageID to appear before target.endVisibleMessageID in the current visible view.`,
    );
  }

  const range = visibleMessages.slice(start.order, end.order + 1);
  if (range.some((message) => message.state !== "compressible")) {
    throw new Error(
      "compression_mark v1 targets must resolve to a contiguous visible span of compressible canonical messages only.",
    );
  }

  return range;
}

function parseVisiblePrefix(text: string | undefined):
  | {
      readonly state: "protected" | "referable" | "compressible";
      readonly visibleMessageID: string;
    }
  | undefined {
  if (text === undefined) {
    return undefined;
  }

  const match = VISIBLE_PREFIX_PATTERN.exec(text);
  if (match === null) {
    return undefined;
  }

  const state = match[1];
  const visibleMessageID = match[2];
  if (state !== "protected" && state !== "referable" && state !== "compressible") {
    return undefined;
  }
  if (typeof visibleMessageID !== "string" || visibleMessageID.length === 0) {
    return undefined;
  }

  return {
    state,
    visibleMessageID,
  };
}

function normalizeVisibleSelector(value: string): string {
  let normalized = value.trim();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }

  while (true) {
    const match = VISIBLE_STATE_PREFIX_PATTERN.exec(normalized);
    if (match === null) {
      break;
    }
    normalized = match[1] ?? normalized;
  }

  if (normalized.length === 0) {
    throw new Error("compression_mark requires a non-empty visible message selector.");
  }

  return normalized;
}

function buildDefaultLabel(visibleMessageIDs: readonly string[]): string {
  if (visibleMessageIDs.length === 0) {
    return "compression_mark";
  }

  const first = visibleMessageIDs[0];
  const last = visibleMessageIDs[visibleMessageIDs.length - 1];
  return first === last ? first : `${first}~${last}`;
}

function renderExistingMark(markID: string, hostMessageIDs: readonly string[]): string {
  return [
    `compression_mark already persisted ${markID} for this tool-call host message.`,
    `Host messages: ${hostMessageIDs.join(", ")}.`,
  ].join(" ");
}

function readPrimaryText(parts: readonly TransformPart[]): string | undefined {
  const textPart = parts.find(
    (part): part is TransformPart & { readonly type: "text"; readonly text: string } =>
      part.type === "text" && typeof (part as Record<string, unknown>).text === "string",
  );
  return textPart?.text;
}

function readNonEmptyString(value: unknown, path: string): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  throw new Error(`compression_mark requires non-empty '${path}'.`);
}
