export type ReplayablePluginToolName =
  | "compression_mark"
  | "compression_inspect"
  | "compression_recall";

export function isReplayablePluginToolName(
  toolName: string,
): toolName is ReplayablePluginToolName {
  return (
    toolName === "compression_mark" ||
    toolName === "compression_inspect" ||
    toolName === "compression_recall"
  );
}

export function buildReplayToolMessageId(input: {
  readonly hostMessageId: string;
  readonly toolName: ReplayablePluginToolName;
  readonly callID?: string;
  readonly ordinal: number;
}): string {
  const callIdentity =
    typeof input.callID === "string" && input.callID.trim().length > 0
      ? input.callID.trim()
      : `${input.toolName}:${input.ordinal}`;
  return `${input.hostMessageId}#${input.toolName}#${callIdentity}`;
}
