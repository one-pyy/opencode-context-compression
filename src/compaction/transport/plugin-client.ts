import type { PluginInput } from "@opencode-ai/plugin";
import {
  CompactionTransportAbortedError,
  CompactionTransportFatalError,
  CompactionTransportRetryableError,
  CompactionTransportTimeoutError,
} from "./errors.js";
import type {
  CompactionTransport,
  CompactionTransportRequest,
  CompactionTransportTranscriptEntry,
} from "./types.js";
import { parseCompactionJsonPayload } from "./validation.js";

export function createPluginClientCompactionTransport(
  pluginInput: PluginInput,
): CompactionTransport {
  return {
    async invoke(request: CompactionTransportRequest): Promise<unknown> {
      if (request.signal?.aborted) {
        throw new CompactionTransportAbortedError({
          origin: "caller",
          reason: formatAbortReason(request.signal.reason),
        });
      }

      let sessionId: string;
      try {
        const createResponse = await pluginInput.client.session.create({
          query: {
            directory: pluginInput.directory,
          },
          throwOnError: true,
        });
        sessionId = createResponse.data.id;
      } catch (error) {
        throw new CompactionTransportFatalError(
          `Failed to create temporary session: ${formatError(error)}`,
        );
      }

      try {
        const messages = buildMessagesFromTranscript(
          request.transcript,
          request.promptText,
          request.executionMode,
          request.hint,
        );

        const timeoutController = new AbortController();
        const timeoutId = setTimeout(() => {
          timeoutController.abort("timeout");
        }, request.timeoutMs);

        const combinedSignal = combineAbortSignals([
          request.signal,
          timeoutController.signal,
        ]);

        try {
          const response = await pluginInput.client.session.prompt({
            path: { id: sessionId },
            body: {
              model: parseModel(request.model),
              parts: messages,
            },
            query: { directory: pluginInput.directory },
            throwOnError: true,
          });

          clearTimeout(timeoutId);

          const contentText = extractContentText(response.data.parts);

          return parseCompactionJsonPayload(contentText, request);
        } catch (error) {
          clearTimeout(timeoutId);

          if (combinedSignal?.aborted) {
            if (timeoutController.signal.aborted) {
              throw new CompactionTransportTimeoutError(request.timeoutMs);
            }
            throw new CompactionTransportAbortedError({
              origin: "caller",
              reason: formatAbortReason(request.signal?.reason),
            });
          }

          throw mapApiError(error);
        }
      } finally {
        try {
          await pluginInput.client.session.delete({
            path: { id: sessionId },
            throwOnError: false,
          });
        } catch {
        }
      }
    },
  };
}

function buildMessagesFromTranscript(
  transcript: readonly CompactionTransportTranscriptEntry[],
  promptText: string,
  executionMode: "compact" | "delete",
  hint?: string,
): Array<{ type: "text"; text: string }> {
  const messages: Array<{ type: "text"; text: string }> = [];

  // Add system prompt
  messages.push({
    type: "text",
    text: promptText,
  });
  if (hint) messages.push({ type: "text", text: `Compression hint: ${hint}` });

  // Add transcript entries
  for (const entry of transcript) {
    const rolePrefix =
      entry.role === "user"
        ? "User"
        : entry.role === "assistant"
          ? "Assistant"
          : "Tool";

    messages.push({
      type: "text",
      text: `${rolePrefix} (${entry.hostMessageID}; source_range=${entry.sourceStartSeq}..${entry.sourceEndSeq}): ${entry.contentText}`,
    });
  }

  // Add instruction based on execution mode
  const instruction =
    executionMode === "compact"
      ? "Please compress the above conversation into a concise summary."
      : "Extract still-valid information with its scope, attribution, and uncertainties. Retire obsolete process. Return the required JSON envelope.";

  messages.push({
    type: "text",
    text: instruction,
  });

  return messages;
}

function parseModel(modelString: string): {
  providerID: string;
  modelID: string;
} {
  const match = modelString.match(/^([^/.]+)(?:\.[^/]+)?\/(.+)$/);
  if (!match) {
    throw new CompactionTransportFatalError(
      `Invalid model format: ${modelString}. Expected format: "providerID/modelID" or "providerID.suffix/modelID"`,
    );
  }

  return {
    providerID: match[1],
    modelID: match[2],
  };
}

function extractContentText(parts: Array<{ type: string; text?: string }>): string {
  const textParts = parts
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text)
    .filter((text): text is string => text !== undefined);

  if (textParts.length === 0) {
    throw new CompactionTransportFatalError(
      `LLM response contained no text parts. Received ${parts.length} parts: ${parts.map(p => p.type).join(", ")}`,
    );
  }

  return textParts.join("\n\n");
}

function combineAbortSignals(
  signals: Array<AbortSignal | undefined>,
): AbortSignal | undefined {
  const activeSignals = signals.filter(
    (s): s is AbortSignal => s !== undefined,
  );

  if (activeSignals.length === 0) {
    return undefined;
  }

  if (activeSignals.length === 1) {
    return activeSignals[0];
  }

  const controller = new AbortController();

  for (const signal of activeSignals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }

    signal.addEventListener(
      "abort",
      () => {
        controller.abort(signal.reason);
      },
      { once: true },
    );
  }

  return controller.signal;
}

function mapApiError(error: unknown): Error {
  if (
    typeof error === "object" &&
    error !== null &&
    "error" in error &&
    typeof error.error === "object" &&
    error.error !== null
  ) {
    const apiError = error.error as {
      name?: string;
      data?: { message?: string; statusCode?: number; isRetryable?: boolean };
    };

    if (apiError.name === "APIError" && apiError.data) {
      if (apiError.data.isRetryable) {
        return new CompactionTransportRetryableError(
          apiError.data.message || "API error",
          { code: apiError.data.statusCode?.toString() },
        );
      }
    }

    if (apiError.name === "ProviderAuthError" && apiError.data?.message) {
      return new CompactionTransportFatalError(
        `Authentication error: ${apiError.data.message}`,
      );
    }

    if (
      apiError.name === "MessageAbortedError" &&
      apiError.data?.message
    ) {
      return new CompactionTransportAbortedError({
        origin: "transport",
        reason: apiError.data.message,
      });
    }
  }

  return new CompactionTransportFatalError(formatError(error));
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return String(error);
}

function formatAbortReason(reason: unknown): string | undefined {
  if (typeof reason === "string") {
    return reason;
  }
  if (reason instanceof Error) {
    return reason.message;
  }
  if (reason === undefined) {
    return undefined;
  }
  return String(reason);
}
