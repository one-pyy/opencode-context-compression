import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse as parseJsonc } from "jsonc-parser";
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

export function createDirectLLMCompactionTransport(
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

      const timeoutController = new AbortController();
      const timeoutId = setTimeout(() => {
        timeoutController.abort("timeout");
      }, request.timeoutMs);

      const combinedSignal = combineAbortSignals([
        request.signal,
        timeoutController.signal,
      ]);

      try {
        const { providerID, modelID } = parseModel(request.model);
        
        const systemPrompt = request.promptText;
        const userMessage = buildUserMessage(request.transcript, request.executionMode);

        const contentText = await callLLM(
          pluginInput,
          providerID,
          modelID,
          systemPrompt,
          userMessage,
          combinedSignal,
        );

        clearTimeout(timeoutId);

        return { contentText };
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
    },
  };
}

function buildUserMessage(
  transcript: readonly CompactionTransportTranscriptEntry[],
  executionMode: "compact" | "delete",
): string {
  let message = `executionMode=${executionMode}\nallowDelete=${executionMode === "delete" ? "true" : "false"}\n\n`;

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
  providerID: string,
  modelID: string,
  systemPrompt: string,
  userMessage: string,
  signal?: AbortSignal,
): Promise<string> {
  const provider = await getProviderConfig(pluginInput, providerID);

  if (provider.type === "gemini") {
    return callGemini(provider, modelID, systemPrompt, userMessage, signal);
  }

  if (provider.type === "anthropic") {
    return callAnthropic(provider, modelID, systemPrompt, userMessage, signal);
  }

  if (provider.type === "openai") {
    return callOpenAI(provider, modelID, systemPrompt, userMessage, signal);
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
  providerID: string,
): Promise<LLMProviderConfig> {
  try {
    const configPath = path.join(os.homedir(), ".config/opencode/opencode.jsonc");
    
    console.log(`[direct-llm] Reading config from: ${configPath}`);
    
    if (!fs.existsSync(configPath)) {
      throw new Error(`OpenCode config not found at ${configPath}`);
    }

    const configContent = fs.readFileSync(configPath, "utf-8");
    console.log(`[direct-llm] Config file size: ${configContent.length} bytes`);
    
    let config: any;
    try {
      config = parseJsonc(configContent);
      console.log(`[direct-llm] Config parsed successfully`);
    } catch (parseError) {
      console.error(`[direct-llm] JSONC parse error:`, parseError);
      throw parseError;
    }

    const providers = config?.provider as Record<string, any> | undefined;
    console.log(`[direct-llm] Available providers:`, providers ? Object.keys(providers) : 'none');
    
    const providerData = providers?.[providerID];

    if (!providerData) {
      console.error(`[direct-llm] Provider ${providerID} not found. Available:`, Object.keys(providers || {}));
      throw new Error(`Provider ${providerID} not found in config`);
    }

    console.log(`[direct-llm] Provider ${providerID} data:`, JSON.stringify(providerData, null, 2));

    const baseURL = providerData.options?.baseURL as string | undefined;
    const apiKey = providerData.options?.apiKey as string | undefined;

    if (!baseURL || !apiKey) {
      console.error(`[direct-llm] Provider ${providerID} missing credentials. baseURL: ${!!baseURL}, apiKey: ${!!apiKey}`);
      throw new Error(`Provider ${providerID} missing baseURL or apiKey`);
    }

    let type: "gemini" | "anthropic" | "openai";
    if (providerID.startsWith("google")) {
      type = "gemini";
    } else if (providerID.startsWith("anthropic")) {
      type = "anthropic";
    } else if (providerID.startsWith("openai")) {
      type = "openai";
    } else {
      throw new Error(`Unknown provider type for ${providerID}`);
    }

    console.log(`[direct-llm] Provider config resolved: type=${type}, baseURL=${baseURL}`);
    return { type, baseURL, apiKey };
  } catch (error) {
    console.error(`[direct-llm] Failed to get provider config:`, error);
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
  signal?: AbortSignal,
): Promise<string> {
  const url = `${provider.baseURL}/models/${modelID}:generateContent?key=${provider.apiKey}`;

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

  const data = await response.json() as any;
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {
    throw new Error("Gemini response missing text content");
  }

  return text;
}

async function callAnthropic(
  provider: LLMProviderConfig,
  modelID: string,
  systemPrompt: string,
  userMessage: string,
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
    }),
    signal,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic API error: ${response.status} ${text}`);
  }

  const data = await response.json() as any;
  const text = data.content?.[0]?.text;

  if (!text) {
    throw new Error("Anthropic response missing text content");
  }

  return text;
}

async function callOpenAI(
  provider: LLMProviderConfig,
  modelID: string,
  systemPrompt: string,
  userMessage: string,
  signal?: AbortSignal,
): Promise<string> {
  const url = `${provider.baseURL}/v1/chat/completions`;

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
    }),
    signal,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI API error: ${response.status} ${text}`);
  }

  const data = await response.json() as any;
  const text = data.choices?.[0]?.message?.content;

  if (!text) {
    throw new Error("OpenAI response missing text content");
  }

  return text;
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
