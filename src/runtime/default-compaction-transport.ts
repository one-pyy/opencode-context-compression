import type { CompactionInput } from "../compaction/input-builder.js";
import {
  CompactionTransportInvocationError,
  type CompactionRunnerTransport,
  type CompactionRunnerTransportRequest,
} from "../compaction/runner.js";
import type { RawCompactionOutput } from "../compaction/output-validation.js";

export interface CreateDefaultRuntimeCompactionTransportOptions {
  readonly modelContext: unknown;
  readonly providerContext: unknown;
  readonly timeoutMs?: number;
}

type EndpointKind = "chat-completions" | "responses";

type ResolvedModelContext = {
  readonly id?: string;
  readonly providerID?: string;
  readonly apiID?: string;
  readonly apiUrl?: string;
  readonly apiNpm?: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly supportsTemperature: boolean;
};

type ResolvedProviderContext = {
  readonly id?: string;
  readonly key?: string;
  readonly options: Readonly<Record<string, unknown>>;
  readonly headers: Readonly<Record<string, string>>;
};

type ResolvedInvocationContext = {
  readonly providerID?: string;
  readonly modelID: string;
  readonly baseUrl: string;
  readonly apiNpm?: string;
  readonly supportsTemperature: boolean;
  readonly headers: Headers;
};

const DEFAULT_RUNTIME_TRANSPORT_CANDIDATE = Object.freeze({
  id: "plugin.compaction.invoke",
  owner: "plugin",
  entrypoint: "independent-model-call",
  promptContext: "dedicated-compaction-prompt",
  sessionEffects: Object.freeze({
    createsUserMessage: false,
    reusesSharedLoop: false,
    dependsOnBusyState: false,
    mutatesPermissions: false,
  }),
  failureClassification: "deterministic",
});

export function createDefaultRuntimeCompactionTransport(
  options: CreateDefaultRuntimeCompactionTransportOptions,
): CompactionRunnerTransport {
  return {
    candidate: DEFAULT_RUNTIME_TRANSPORT_CANDIDATE,
    async invoke(
      request: CompactionRunnerTransportRequest,
    ): Promise<RawCompactionOutput> {
      return invokeRuntimeCompactionTransport(options, request);
    },
  } satisfies CompactionRunnerTransport;
}

async function invokeRuntimeCompactionTransport(
  options: CreateDefaultRuntimeCompactionTransportOptions,
  request: CompactionRunnerTransportRequest,
): Promise<RawCompactionOutput> {
  const invocation = resolveInvocationContext(options, request.model);
  const bodyText = renderCompactionRequestBody(request.input);
  const endpointOrder = resolveEndpointOrder(
    invocation.apiNpm,
    invocation.providerID,
  );
  const signal =
    typeof options.timeoutMs === "number" && options.timeoutMs > 0
      ? AbortSignal.timeout(options.timeoutMs)
      : undefined;

  let lastError: CompactionTransportInvocationError | undefined;

  // Try both OpenAI Responses and Chat Completions because the live runtime
  // model metadata can point at either official OpenAI-style endpoints or
  // OpenAI-compatible gateways, and the plugin cannot reuse the host's
  // internal provider factory from this repo.
  for (const [endpointIndex, endpoint] of endpointOrder.entries()) {
    const url = buildEndpointUrl(invocation.baseUrl, endpoint);
    const response = await fetch(url, {
      method: "POST",
      headers: invocation.headers,
      body: JSON.stringify(
        buildRequestPayload(
          endpoint,
          invocation.modelID,
          request.input,
          bodyText,
          invocation,
        ),
      ),
      signal,
    }).catch((error: unknown) => {
      throw normalizeFetchFailure(error, endpoint, url);
    });

    if (!response.ok) {
      if (
        shouldTryAlternateEndpoint(
          response.status,
          endpointIndex,
          endpointOrder.length,
        )
      ) {
        lastError = await createHttpFailure(response, endpoint, url);
        continue;
      }

      throw await createHttpFailure(response, endpoint, url);
    }

    return parseRuntimeCompactionResponse(response, endpoint, url);
  }

  throw (
    lastError ??
    new CompactionTransportInvocationError(
      "execution-error",
      `Compaction transport failed before a provider response was produced for model '${request.model}'.`,
    )
  );
}

function resolveInvocationContext(
  options: CreateDefaultRuntimeCompactionTransportOptions,
  configuredModel: string,
): ResolvedInvocationContext {
  const modelContext = resolveModelContext(options.modelContext);
  const providerContext = resolveProviderContext(options.providerContext);
  const configured = parseConfiguredModel(configuredModel);

  if (
    configured.providerID !== undefined &&
    modelContext.providerID !== undefined &&
    configured.providerID !== modelContext.providerID
  ) {
    throw new CompactionTransportInvocationError(
      "unavailable",
      `Configured compaction model '${configuredModel}' targets provider '${configured.providerID}', but the live runtime provider is '${modelContext.providerID}'. Cross-provider fallback is not available from the plugin-owned default transport.`,
    );
  }

  const modelID = configured.modelID ?? modelContext.apiID ?? modelContext.id;
  if (!modelID) {
    throw new CompactionTransportInvocationError(
      "unavailable",
      `Unable to resolve a provider model id for configured compaction model '${configuredModel}'.`,
    );
  }

  const baseUrl = resolveBaseUrl(providerContext.options, modelContext.apiUrl);
  if (!baseUrl) {
    throw new CompactionTransportInvocationError(
      "unavailable",
      `Unable to resolve a provider base URL for configured compaction model '${configuredModel}'.`,
    );
  }

  const headers = new Headers();
  headers.set("accept", "application/json");
  headers.set("content-type", "application/json");

  for (const [name, value] of Object.entries(providerContext.headers)) {
    headers.set(name, value);
  }

  for (const [name, value] of Object.entries(modelContext.headers)) {
    headers.set(name, value);
  }

  const providerKey = providerContext.key;
  if (providerKey && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${providerKey}`);
  }

  return {
    providerID:
      configured.providerID ?? modelContext.providerID ?? providerContext.id,
    modelID,
    baseUrl,
    apiNpm: modelContext.apiNpm,
    supportsTemperature: modelContext.supportsTemperature,
    headers,
  };
}

function buildRequestPayload(
  endpoint: EndpointKind,
  modelID: string,
  input: CompactionInput,
  bodyText: string,
  invocation: ResolvedInvocationContext,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: modelID,
  };

  if (invocation.supportsTemperature) {
    payload.temperature = 0;
  }

  const permissionHint = `allowDelete=${input.allowDelete ? "true" : "false"}`;
  const executionModeHint = `executionMode=${input.executionMode}`;
  const effectivePrompt = `${input.promptText}\n\n## Runtime Instructions\n\n- Delete permission: **${permissionHint}**\n- Current execution mode: **${executionModeHint}**`;

  if (endpoint === "responses") {
    payload.instructions = effectivePrompt;
    payload.input = [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: bodyText,
          },
        ],
      },
    ];
    return payload;
  }

  payload.stream = false;
  payload.messages = [
    {
      role: "system",
      content: effectivePrompt,
    },
    {
      role: "user",
      content: bodyText,
    },
  ];
  return payload;
}

async function parseRuntimeCompactionResponse(
  response: Response,
  endpoint: EndpointKind,
  url: string,
): Promise<RawCompactionOutput> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    const text = (await response.text()).trim();
    if (!text) {
      throw new CompactionTransportInvocationError(
        "invalid-response",
        `Compaction transport endpoint '${endpoint}' at '${url}' returned an empty non-JSON response.`,
      );
    }

    return { contentText: text };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new CompactionTransportInvocationError(
      "invalid-response",
      `Compaction transport endpoint '${endpoint}' at '${url}' returned malformed JSON: ${describeError(error)}.`,
    );
  }

  const contentText = extractCompactionResponseText(payload);
  if (!contentText || contentText.trim().length === 0) {
    throw new CompactionTransportInvocationError(
      "invalid-response",
      `Compaction transport endpoint '${endpoint}' at '${url}' returned JSON without a usable text result.`,
    );
  }

  return { contentText: contentText.trim() };
}

async function createHttpFailure(
  response: Response,
  endpoint: EndpointKind,
  url: string,
): Promise<CompactionTransportInvocationError> {
  const body = await response.text().catch(() => "");
  const detail = truncateForError(body);
  return new CompactionTransportInvocationError(
    "execution-error",
    `Compaction transport endpoint '${endpoint}' at '${url}' returned HTTP ${response.status}${
      detail ? `: ${detail}` : "."
    }`,
  );
}

function normalizeFetchFailure(
  error: unknown,
  endpoint: EndpointKind,
  url: string,
): CompactionTransportInvocationError {
  if (error instanceof CompactionTransportInvocationError) {
    return error;
  }

  if (isAbortError(error)) {
    return new CompactionTransportInvocationError(
      "aborted",
      `Compaction transport endpoint '${endpoint}' at '${url}' was aborted: ${describeError(error)}.`,
    );
  }

  if (error instanceof TypeError) {
    return new CompactionTransportInvocationError(
      "unavailable",
      `Compaction transport endpoint '${endpoint}' at '${url}' could not be reached: ${describeError(error)}.`,
    );
  }

  return new CompactionTransportInvocationError(
    "execution-error",
    `Compaction transport endpoint '${endpoint}' at '${url}' failed: ${describeError(error)}.`,
  );
}

function resolveEndpointOrder(
  apiNpm: string | undefined,
  providerID: string | undefined,
): readonly EndpointKind[] {
  if (
    apiNpm === "@ai-sdk/openai" ||
    providerID === "openai" ||
    providerID === "xai" ||
    providerID === "github-copilot"
  ) {
    return ["responses", "chat-completions"];
  }

  return ["chat-completions", "responses"];
}

function shouldTryAlternateEndpoint(
  status: number,
  index: number,
  total: number,
): boolean {
  return index < total - 1 && [404, 405, 501].includes(status);
}

function buildEndpointUrl(baseUrl: string, endpoint: EndpointKind): string {
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(
    endpoint === "responses" ? "responses" : "chat/completions",
    normalizedBaseUrl,
  ).toString();
}

function renderCompactionRequestBody(input: CompactionInput): string {
  const sourceSections = input.sourceMessages.map((message, index) => {
    return [
      `### ${index + 1}. ${message.role} ${message.hostMessageID} (${message.canonicalMessageID})`,
      message.content,
    ].join("\n");
  });

  return [
    `Delete permission: ${input.allowDelete ? "true" : "false"}`,
    `Execution mode: ${input.executionMode}`,
    `Source snapshot id: ${input.sourceSnapshotID}`,
    `Source fingerprint: ${input.sourceFingerprint}`,
    input.canonicalRevision
      ? `Canonical revision: ${input.canonicalRevision}`
      : undefined,
    "",
    "Canonical source messages:",
    ...sourceSections,
    "",
    "Canonical transcript:",
    input.transcript,
    "",
    "Return only the final committed replacement text. Do not return JSON, markdown fences, labels, or commentary.",
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
}

function extractCompactionResponseText(payload: unknown): string | undefined {
  const payloadRecord = asRecord(payload);
  if (!payloadRecord) {
    return undefined;
  }

  if (
    typeof payloadRecord.output_text === "string" &&
    payloadRecord.output_text.trim().length > 0
  ) {
    return payloadRecord.output_text;
  }

  const directContent = extractTextContent(payloadRecord.content);
  if (directContent) {
    return directContent;
  }

  const choices = Array.isArray(payloadRecord.choices)
    ? payloadRecord.choices
    : [];
  for (const choice of choices) {
    const choiceRecord = asRecord(choice);
    const messageRecord = asRecord(choiceRecord?.message);
    const content = extractTextContent(messageRecord?.content);
    if (content) {
      return content;
    }
  }

  const output = Array.isArray(payloadRecord.output)
    ? payloadRecord.output
    : [];
  for (const item of output) {
    const itemRecord = asRecord(item);
    const content = extractTextContent(itemRecord?.content);
    if (content) {
      return content;
    }
  }

  return undefined;
}

function extractTextContent(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const chunks = value
    .flatMap((entry) => {
      if (typeof entry === "string") {
        return [entry];
      }

      const record = asRecord(entry);
      if (!record) {
        return [];
      }

      const text = record.text;
      if (typeof text === "string") {
        return [text];
      }

      const nested = record.content;
      const nestedText = extractTextContent(nested);
      return nestedText ? [nestedText] : [];
    })
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);

  return chunks.length > 0 ? chunks.join("\n") : undefined;
}

function parseConfiguredModel(value: string): {
  readonly providerID?: string;
  readonly modelID?: string;
} {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return {};
  }

  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
    return { modelID: trimmed };
  }

  return {
    providerID: trimmed.slice(0, slashIndex),
    modelID: trimmed.slice(slashIndex + 1),
  };
}

function resolveModelContext(value: unknown): ResolvedModelContext {
  const record = asRecord(value);
  const api = asRecord(record?.api);
  const capabilities = asRecord(record?.capabilities);

  return {
    id: readString(record, "id"),
    providerID: readString(record, "providerID"),
    apiID: readString(api, "id"),
    apiUrl: readString(api, "url"),
    apiNpm: readString(api, "npm"),
    headers: readStringMap(record?.headers),
    supportsTemperature: capabilities?.temperature === true,
  };
}

function resolveProviderContext(value: unknown): ResolvedProviderContext {
  const record = asRecord(value);
  const info = asRecord(record?.info);
  const directOptions = asRecord(record?.options);
  const infoOptions = asRecord(info?.options);
  const options = {
    ...(infoOptions ?? {}),
    ...(directOptions ?? {}),
  };

  return {
    id: readString(record, "id") ?? readString(info, "id"),
    key:
      readString(record, "key") ??
      readString(info, "key") ??
      readString(options, "apiKey"),
    options,
    headers: {
      ...readStringMap(info?.headers),
      ...readStringMap(record?.headers),
      ...readStringMap(asRecord(options.headers)),
    },
  };
}

function resolveBaseUrl(
  options: Readonly<Record<string, unknown>>,
  fallbackUrl: string | undefined,
): string | undefined {
  const configured =
    readString(options, "baseURL") ??
    readString(options, "baseUrl") ??
    fallbackUrl;
  if (!configured) {
    return undefined;
  }

  const resolved = configured
    .replace(
      /\$\{([^}]+)\}/g,
      (match, key: string) => process.env[key] ?? match,
    )
    .trim();
  return resolved.length > 0 ? resolved : undefined;
}

function readString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function readStringMap(value: unknown): Readonly<Record<string, string>> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const entries = Object.entries(value as Record<string, unknown>).flatMap(
    ([key, entryValue]) => {
      return typeof entryValue === "string" ? [[key, entryValue]] : [];
    },
  );

  return Object.fromEntries(entries);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === "AbortError";
  }

  return error instanceof Error && error.name === "AbortError";
}

function truncateForError(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 300) {
    return trimmed;
  }

  return `${trimmed.slice(0, 297)}...`;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
