import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse as parseJsonc } from "jsonc-parser";
import type { PluginInput } from "@opencode-ai/plugin";
import type { RuntimeArtifactRecorder } from "../../runtime/runtime-artifacts.js";
import {
  CompactionTransportAbortedError,
  CompactionTransportEmptyResponseError,
  CompactionTransportFatalError,
  CompactionTransportMalformedPayloadError,
  CompactionTransportRetryableError,
  CompactionTransportTimeoutError,
} from "./errors.js";
import type {
  CompactionTransport,
  CompactionTransportRequest,
  CompactionTransportTranscriptEntry,
} from "./types.js";
import { parseCompactionJsonPayload } from "./validation.js";

const OPENAI_REASONING_EFFORT = "medium";
const OPENAI_COMPATIBLE_REASONING_EFFORT = "none";
const GEMINI_THINKING_LEVEL = "medium";
const EMPTY_STREAM_FRAME_SAMPLE_LIMIT = 8;
const EMPTY_STREAM_DATA_PREVIEW_LIMIT = 600;

export function createDirectLLMCompactionTransport(
  pluginInput: PluginInput,
  options: {
    readonly runtimeArtifacts: RuntimeArtifactRecorder;
  },
): CompactionTransport {
  return {
    async invoke(request: CompactionTransportRequest): Promise<unknown> {
      if (request.signal?.aborted) {
        throw new CompactionTransportAbortedError({
          origin: "caller",
          reason: formatAbortReason(request.signal.reason),
        });
      }

      const totalTimeoutController = new AbortController();
      const totalTimeoutId = setTimeout(() => {
        totalTimeoutController.abort("total-timeout");
      }, request.timeoutMs);

      const combinedSignal = combineAbortSignals([
        request.signal,
        totalTimeoutController.signal,
      ]);

      try {
        const { providerID, modelID } = parseModel(request.model);
        
        const systemPrompt = request.promptText;
        const userMessage = buildUserMessage(request.transcript, request.executionMode, request.hint);

        const contentText = await callLLM(
          pluginInput,
          options.runtimeArtifacts,
          request.sessionID,
          providerID,
          modelID,
          systemPrompt,
          userMessage,
          request,
          combinedSignal,
        );

        clearTimeout(totalTimeoutId);

        return parseCompactionJsonPayload(contentText, request);
      } catch (error) {
        clearTimeout(totalTimeoutId);

        if (combinedSignal?.aborted) {
          if (totalTimeoutController.signal.aborted) {
            throw new CompactionTransportTimeoutError(request.timeoutMs);
          }
          throw new CompactionTransportAbortedError({
            origin: "caller",
            reason: formatAbortReason(request.signal?.reason),
          });
        }

        throw mapApiError(error);
      }
    },
  };
}

function buildUserMessage(
  transcript: readonly CompactionTransportTranscriptEntry[],
  executionMode: "compact" | "delete",
  hint?: string,
): string {
  let message = `executionMode=${executionMode}\nallowDelete=${executionMode === "delete" ? "true" : "false"}\n`;
  
  if (hint) {
    message += `\nCompression hint: ${hint}\n`;
  }
  
  message += `\n`;

  const opaqueSlots: string[] = [];

  for (const entry of transcript) {
    const role = entry.role;
    const hostId = `host_${entry.sequenceNumber}`;
    const canonicalId = entry.hostMessageID;

    message += `### ${entry.sequenceNumber}. ${role} ${hostId} (${canonicalId})\n`;
    message += `${entry.contentText}\n\n`;

    if (entry.opaquePlaceholderSlot) {
      opaqueSlots.push(entry.opaquePlaceholderSlot);
    }
  }

  if (opaqueSlots.length > 0) {
    message += `\n\nCRITICAL REMINDER: You MUST replace every \`<opaque slot="...">\` block with a self-closing \`<opaque slot="..."/>\` tag. Do not omit any opaque slots: ${opaqueSlots.join(", ")}`;
  }

  return message;
}

async function callLLM(
  pluginInput: PluginInput,
  runtimeArtifacts: RuntimeArtifactRecorder,
  sessionID: string,
  providerID: string,
  modelID: string,
  systemPrompt: string,
  userMessage: string,
  request: CompactionTransportRequest,
  signal?: AbortSignal,
): Promise<string> {
  const provider = await getProviderConfig(
    pluginInput,
    runtimeArtifacts,
    sessionID,
    providerID,
  );

  if (provider.type === "gemini") {
    return callGemini(provider, runtimeArtifacts, modelID, systemPrompt, userMessage, request, signal);
  }

  if (provider.type === "anthropic") {
    return callAnthropic(provider, runtimeArtifacts, modelID, systemPrompt, userMessage, request, signal);
  }

  if (provider.type === "openai") {
    return callOpenAI(provider, runtimeArtifacts, providerID, modelID, systemPrompt, userMessage, request, signal);
  }

  throw new CompactionTransportFatalError(
    `Unsupported provider: ${providerID}. Only Gemini, Anthropic, and OpenAI are supported.`,
  );
}

interface LLMProviderConfig {
  type: "gemini" | "anthropic" | "openai";
  baseURL: string;
  apiKey: string;
}

async function getProviderConfig(
  _pluginInput: PluginInput,
  runtimeArtifacts: RuntimeArtifactRecorder,
  sessionID: string,
  providerID: string,
): Promise<LLMProviderConfig> {
  try {
    const configPath = path.join(os.homedir(), ".config/opencode/opencode.jsonc");

    await runtimeArtifacts.writeDiagnostic({
      sessionID,
      scope: "direct-llm",
      severity: "debug",
      message: "Reading OpenCode provider config for direct LLM transport.",
      payload: { configPath, providerID },
    });
    
    if (!fs.existsSync(configPath)) {
      throw new Error(`OpenCode config not found at ${configPath}`);
    }

    const configContent = fs.readFileSync(configPath, "utf-8");
    await runtimeArtifacts.writeDiagnostic({
      sessionID,
      scope: "direct-llm",
      severity: "debug",
      message: "Loaded OpenCode provider config file.",
      payload: { providerID, configSizeBytes: configContent.length },
    });
    
    let config: any;
    try {
      config = parseJsonc(configContent);
      await runtimeArtifacts.writeDiagnostic({
        sessionID,
        scope: "direct-llm",
        severity: "debug",
        message: "Parsed OpenCode provider config successfully.",
        payload: { providerID },
      });
    } catch (parseError) {
      await runtimeArtifacts.writeDiagnostic({
        sessionID,
        scope: "direct-llm",
        severity: "error",
        message: "Failed to parse OpenCode provider config JSONC.",
        payload: { providerID, error: formatError(parseError) },
      });
      throw parseError;
    }

    const providers = config?.provider as Record<string, any> | undefined;
    await runtimeArtifacts.writeDiagnostic({
      sessionID,
      scope: "direct-llm",
      severity: "debug",
      message: "Enumerated available providers from config.",
      payload: {
        providerID,
        availableProviders: providers ? Object.keys(providers) : [],
      },
    });
    
    const providerData = providers?.[providerID];

    if (!providerData) {
      await runtimeArtifacts.writeDiagnostic({
        sessionID,
        scope: "direct-llm",
        severity: "error",
        message: "Requested provider is missing from config.",
        payload: {
          providerID,
          availableProviders: Object.keys(providers || {}),
        },
      });
      throw new Error(`Provider ${providerID} not found in config`);
    }

    const baseURL = providerData.options?.baseURL as string | undefined;
    const apiKey = providerData.options?.apiKey as string | undefined;

    await runtimeArtifacts.writeDiagnostic({
      sessionID,
      scope: "direct-llm",
      severity: "debug",
      message: "Resolved provider configuration shape.",
      payload: {
        providerID,
        optionKeys:
          providerData !== null && typeof providerData === "object"
            ? Object.keys(providerData as Record<string, unknown>)
            : [],
        hasBaseURL: Boolean(baseURL),
        hasApiKey: Boolean(apiKey),
      },
    });

    if (!baseURL || !apiKey) {
      await runtimeArtifacts.writeDiagnostic({
        sessionID,
        scope: "direct-llm",
        severity: "error",
        message: "Provider config is missing required credentials.",
        payload: {
          providerID,
          hasBaseURL: Boolean(baseURL),
          hasApiKey: Boolean(apiKey),
        },
      });
      throw new Error(`Provider ${providerID} missing baseURL or apiKey`);
    }

    let type: "gemini" | "anthropic" | "openai";
    if (providerID.startsWith("google")) {
      type = "gemini";
    } else if (providerID.startsWith("anthropic")) {
      type = "anthropic";
    } else {
      type = "openai";
    }

    await runtimeArtifacts.writeDiagnostic({
      sessionID,
      scope: "direct-llm",
      severity: "debug",
      message: "Resolved provider type for direct LLM transport.",
      payload: { providerID, providerType: type, hasBaseURL: true },
    });
    return { type, baseURL, apiKey };
  } catch (error) {
    await runtimeArtifacts.writeDiagnostic({
      sessionID,
      scope: "direct-llm",
      severity: "error",
      message: "Failed to resolve provider config for direct LLM transport.",
      payload: { providerID, error: formatError(error) },
    });
    throw new CompactionTransportFatalError(
      `Failed to get provider config: ${formatError(error)}`,
    );
  }
}



async function callGemini(
  provider: LLMProviderConfig,
  runtimeArtifacts: RuntimeArtifactRecorder,
  modelID: string,
  systemPrompt: string,
  userMessage: string,
  request: CompactionTransportRequest,
  signal?: AbortSignal,
): Promise<string> {
  const url = `${provider.baseURL}/models/${modelID}:streamGenerateContent?alt=sse&key=${provider.apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
        thinkingConfig: {
          thinkingLevel: GEMINI_THINKING_LEVEL,
        },
      },
    }),
    signal,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini API error: ${response.status} ${text}`);
  }

  return readStreamingText(response, runtimeArtifacts, request, parseGeminiSseChunk);
}

async function callAnthropic(
  provider: LLMProviderConfig,
  runtimeArtifacts: RuntimeArtifactRecorder,
  modelID: string,
  systemPrompt: string,
  userMessage: string,
  request: CompactionTransportRequest,
  signal?: AbortSignal,
): Promise<string> {
  const url = `${provider.baseURL}/v1/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": provider.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: modelID,
      max_tokens: 4096,
      thinking: {
        type: "adaptive",
      },
      output_config: {
        effort: "medium",
      },
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      stream: true,
    }),
    signal,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic API error: ${response.status} ${text}`);
  }

  return readStreamingText(response, runtimeArtifacts, request, parseAnthropicSseChunk);
}

async function callOpenAI(
  provider: LLMProviderConfig,
  runtimeArtifacts: RuntimeArtifactRecorder,
  providerID: string,
  modelID: string,
  systemPrompt: string,
  userMessage: string,
  request: CompactionTransportRequest,
  signal?: AbortSignal,
): Promise<string> {
  const url = `${trimTrailingSlashes(provider.baseURL)}/chat/completions`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(
      buildOpenAICompatibleRequestBody(
        providerID,
        modelID,
        systemPrompt,
        userMessage,
      ),
    ),
    signal,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI API error: ${response.status} ${text}`);
  }

  return readStreamingText(response, runtimeArtifacts, request, parseOpenAISseChunk);
}

export function buildOpenAICompatibleRequestBody(
  providerID: string,
  modelID: string,
  systemPrompt: string,
  userMessage: string,
): Record<string, unknown> {
  return {
    model: modelID,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    ...buildOpenAICompatibleReasoningOptions(providerID, modelID),
    temperature: 0,
    response_format: { type: "json_object" },
    stream: true,
  };
}

export function buildOpenAICompatibleReasoningOptions(
  providerID: string,
  modelID: string,
): Record<string, unknown> {
  const normalizedProvider = providerID.toLowerCase();
  const normalizedModel = modelID.toLowerCase();
  const usesMediumEffort =
    normalizedProvider.includes("openai") ||
    normalizedProvider.includes("deepseek") ||
    normalizedModel.startsWith("gpt") ||
    normalizedModel.includes("deepseek");

  return {
    reasoning_effort: usesMediumEffort
      ? OPENAI_REASONING_EFFORT
      : OPENAI_COMPATIBLE_REASONING_EFFORT,
  };
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

async function readStreamingText(
  response: Response,
  runtimeArtifacts: RuntimeArtifactRecorder,
  request: CompactionTransportRequest,
  parseChunk: (data: string) => string,
): Promise<string> {
  if (!response.body) {
    throw new Error("Streaming response body is missing.");
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  const firstTokenTimeoutMs = request.firstTokenTimeoutMs ?? request.timeoutMs;
  const streamIdleTimeoutMs = request.streamIdleTimeoutMs ?? request.timeoutMs;
  let buffer = "";
  let aggregated = "";
  let receivedAnyToken = false;
  let frameCount = 0;
  let dataFrameCount = 0;
  let parsedDataFrameCount = 0;
  let doneFrameCount = 0;
  let textChunkCount = 0;
  const frameSamples: EmptyStreamFrameSample[] = [];
  let firstTokenTimer: ReturnType<typeof setTimeout> | undefined;
  let streamIdleTimer: ReturnType<typeof setTimeout> | undefined;

  const clearTimers = () => {
    if (firstTokenTimer) {
      clearTimeout(firstTokenTimer);
      firstTokenTimer = undefined;
    }
    if (streamIdleTimer) {
      clearTimeout(streamIdleTimer);
      streamIdleTimer = undefined;
    }
  };

  const armFirstTokenTimer = () => {
    firstTokenTimer = setTimeout(() => {
      reader.cancel("first-token-timeout").catch(() => {});
    }, firstTokenTimeoutMs);
  };

  const armStreamIdleTimer = () => {
    if (streamIdleTimer) {
      clearTimeout(streamIdleTimer);
    }
    streamIdleTimer = setTimeout(() => {
      reader.cancel("stream-idle-timeout").catch(() => {});
    }, streamIdleTimeoutMs);
  };

  armFirstTokenTimer();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\n\n/);
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        frameCount += 1;
        const parsedFrame = parseSseFrame(frame, parseChunk);
        dataFrameCount += parsedFrame.dataFrameCount;
        parsedDataFrameCount += parsedFrame.parsedDataFrameCount;
        doneFrameCount += parsedFrame.doneFrameCount;

        if (frameSamples.length < EMPTY_STREAM_FRAME_SAMPLE_LIMIT) {
          frameSamples.push(...parsedFrame.samples.slice(0, EMPTY_STREAM_FRAME_SAMPLE_LIMIT - frameSamples.length));
        }

        const chunk = parsedFrame.text;
        if (!chunk) {
          continue;
        }

        textChunkCount += 1;
        if (!receivedAnyToken) {
          receivedAnyToken = true;
          if (firstTokenTimer) {
            clearTimeout(firstTokenTimer);
            firstTokenTimer = undefined;
          }
        }

        aggregated += chunk;
        armStreamIdleTimer();
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("first-token-timeout")) {
      throw new CompactionTransportTimeoutError(firstTokenTimeoutMs);
    }
    if (message.includes("stream-idle-timeout")) {
      throw new CompactionTransportTimeoutError(streamIdleTimeoutMs);
    }
    throw error;
  } finally {
    clearTimers();
    reader.releaseLock();
  }

  if (!receivedAnyToken || aggregated.trim().length === 0) {
    const diagnosticPayload = {
      markID: request.markID,
      model: request.model,
      frameCount,
      dataFrameCount,
      parsedDataFrameCount,
      doneFrameCount,
      textChunkCount,
      remainingBufferLength: buffer.length,
      responseStatus: response.status,
      responseContentType: response.headers.get("content-type"),
      sampledFrames: frameSamples,
    };
    await runtimeArtifacts.writeDiagnostic({
      sessionID: request.sessionID,
      scope: "direct-llm",
      severity: "error",
      message: "Streaming response produced no text content; captured SSE summary.",
      payload: diagnosticPayload,
    });
    throw new CompactionTransportEmptyResponseError(diagnosticPayload);
  }

  return aggregated;
}

function parseSseFrame(
  frame: string,
  parseChunk: (data: string) => string,
): ParsedSseFrame {
  const trimmed = frame.trim();
  if (trimmed.length === 0) {
    return EMPTY_PARSED_SSE_FRAME;
  }

  const dataLines = trimmed
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());

  if (dataLines.length === 0) {
    return {
      text: "",
      dataFrameCount: 0,
      parsedDataFrameCount: 0,
      doneFrameCount: 0,
      samples: [summarizeNonDataFrame(trimmed)],
    };
  }

  const data = dataLines.join("\n");
  if (data === "[DONE]") {
    return {
      text: "",
      dataFrameCount: 1,
      parsedDataFrameCount: 0,
      doneFrameCount: 1,
      samples: [{ kind: "done", preview: "[DONE]" }],
    };
  }

  return {
    text: parseChunk(data),
    dataFrameCount: 1,
    parsedDataFrameCount: 1,
    doneFrameCount: 0,
    samples: [summarizeDataFrame(data)],
  };
}

interface ParsedSseFrame {
  readonly text: string;
  readonly dataFrameCount: number;
  readonly parsedDataFrameCount: number;
  readonly doneFrameCount: number;
  readonly samples: readonly EmptyStreamFrameSample[];
}

type EmptyStreamFrameSample =
  | {
      readonly kind: "data-json";
      readonly topLevelKeys: readonly string[];
      readonly signalKeys: readonly string[];
      readonly preview: string;
    }
  | {
      readonly kind: "data-text" | "done" | "non-data";
      readonly preview: string;
    };

const EMPTY_PARSED_SSE_FRAME: ParsedSseFrame = Object.freeze({
  text: "",
  dataFrameCount: 0,
  parsedDataFrameCount: 0,
  doneFrameCount: 0,
  samples: [],
});

function summarizeDataFrame(data: string): EmptyStreamFrameSample {
  try {
    const parsed: unknown = JSON.parse(data);
    if (isPlainRecord(parsed)) {
      return {
        kind: "data-json",
        topLevelKeys: Object.keys(parsed),
        signalKeys: collectSignalKeys(parsed),
        preview: truncateForDiagnostic(data),
      };
    }
  } catch {
    return { kind: "data-text", preview: truncateForDiagnostic(data) };
  }

  return { kind: "data-text", preview: truncateForDiagnostic(data) };
}

function summarizeNonDataFrame(frame: string): EmptyStreamFrameSample {
  return { kind: "non-data", preview: truncateForDiagnostic(frame) };
}

function collectSignalKeys(value: unknown): readonly string[] {
  const keys = new Set<string>();
  collectSignalKeysInner(value, keys, 0);
  return [...keys].sort();
}

function collectSignalKeysInner(value: unknown, keys: Set<string>, depth: number): void {
  if (depth > 5 || value === null) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value.slice(0, 4)) {
      collectSignalKeysInner(item, keys, depth + 1);
    }
    return;
  }

  if (!isPlainRecord(value)) {
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (isPotentialTextSignalKey(key)) {
      keys.add(key);
    }
    collectSignalKeysInner(nested, keys, depth + 1);
  }
}

function isPotentialTextSignalKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized.includes("content") ||
    normalized.includes("text") ||
    normalized.includes("reasoning") ||
    normalized.includes("thinking") ||
    normalized.includes("delta") ||
    normalized.includes("message")
  );
}

function truncateForDiagnostic(value: string): string {
  if (value.length <= EMPTY_STREAM_DATA_PREVIEW_LIMIT) {
    return value;
  }
  return `${value.slice(0, EMPTY_STREAM_DATA_PREVIEW_LIMIT)}...<truncated ${value.length - EMPTY_STREAM_DATA_PREVIEW_LIMIT} chars>`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseGeminiSseChunk(data: string): string {
  const parsed = JSON.parse(data) as any;
  return parsed.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

function parseAnthropicSseChunk(data: string): string {
  const parsed = JSON.parse(data) as any;
  if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta") {
    return parsed.delta.text ?? "";
  }
  return "";
}

function parseOpenAISseChunk(data: string): string {
  const parsed = JSON.parse(data) as any;
  return parsed.choices?.[0]?.delta?.content ?? "";
}

function parseModel(modelString: string): {
  providerID: string;
  modelID: string;
} {
  const match = modelString.match(/^([^/]+)\/(.+)$/);
  if (!match) {
    throw new CompactionTransportFatalError(
      `Invalid model format: ${modelString}. Expected format: "providerID/modelID"`,
    );
  }

  return {
    providerID: match[1],
    modelID: match[2],
  };
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
    if (error instanceof Error) {
    if (error instanceof CompactionTransportEmptyResponseError) {
      return error;
    }

    if (error instanceof CompactionTransportMalformedPayloadError) {
      return error;
    }

    if (error.message.includes("429") || error.message.includes("rate")) {
      return new CompactionTransportRetryableError(error.message, {
        code: "429",
      });
    }

    if (error.message.includes("401") || error.message.includes("403")) {
      return new CompactionTransportFatalError(
        `Authentication error: ${error.message}`,
      );
    }

    if (error.name === "AbortError") {
      return new CompactionTransportAbortedError({
        origin: "transport",
        reason: error.message,
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
