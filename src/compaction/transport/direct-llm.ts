import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse as parseJsonc } from "jsonc-parser";
import type { PluginInput } from "@opencode-ai/plugin";
import type { RuntimeArtifactRecorder } from "../../runtime/runtime-artifacts.js";
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

        return { contentText };
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
    return callGemini(provider, modelID, systemPrompt, userMessage, request, signal);
  }

  if (provider.type === "anthropic") {
    return callAnthropic(provider, modelID, systemPrompt, userMessage, request, signal);
  }

  if (provider.type === "openai") {
    return callOpenAI(provider, modelID, systemPrompt, userMessage, request, signal);
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
        thinkingConfig: {},
      },
    }),
    signal,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini API error: ${response.status} ${text}`);
  }

  return readStreamingText(response, request, parseGeminiSseChunk);
}

async function callAnthropic(
  provider: LLMProviderConfig,
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
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      temperature: 0,
      stream: true,
    }),
    signal,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic API error: ${response.status} ${text}`);
  }

  return readStreamingText(response, request, parseAnthropicSseChunk);
}

async function callOpenAI(
  provider: LLMProviderConfig,
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
    body: JSON.stringify({
      model: modelID,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      temperature: 0,
      stream: true,
    }),
    signal,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI API error: ${response.status} ${text}`);
  }

  return readStreamingText(response, request, parseOpenAISseChunk);
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

async function readStreamingText(
  response: Response,
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
        const chunk = parseSseFrame(frame, parseChunk);
        if (!chunk) {
          continue;
        }

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
    throw new Error("Streaming response produced no text content.");
  }

  return aggregated;
}

function parseSseFrame(
  frame: string,
  parseChunk: (data: string) => string,
): string {
  const trimmed = frame.trim();
  if (trimmed.length === 0) {
    return "";
  }

  const dataLines = trimmed
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());

  if (dataLines.length === 0) {
    return "";
  }

  const data = dataLines.join("\n");
  if (data === "[DONE]") {
    return "";
  }

  return parseChunk(data);
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
