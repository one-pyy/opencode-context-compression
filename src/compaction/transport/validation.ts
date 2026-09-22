import {
  CompactionTransportMalformedPayloadError,
  summarizeCompactionTransportRequest,
} from "./errors.js";
import { visit, type ParseError } from "jsonc-parser";
import type {
  CompactionTransportRequest,
  CompactionTransportPayload,
  ValidatedCompactionTransportPayload,
} from "./types.js";

export function parseCompactionJsonPayload(
  rawContentText: string,
  request: CompactionTransportRequest,
): CompactionTransportPayload {
  const candidates = [
    rawContentText,
    stripJsonCodeFence(rawContentText),
    extractJsonObject(rawContentText),
  ].filter((candidate, index, all): candidate is string =>
    candidate !== undefined && all.indexOf(candidate) === index,
  );

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return parseStrictCompactionJsonPayload(candidate, request, rawContentText);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

function parseStrictCompactionJsonPayload(
  candidateText: string,
  request: CompactionTransportRequest,
  originalContentText: string,
): CompactionTransportPayload {
  let envelope: unknown;
  const parseErrors: ParseError[] = [];
  const topLevelKeys: string[] = [];
  let objectDepth = 0;
  let rootWasObject = false;

  visit(
    candidateText,
    {
      onObjectBegin() {
        objectDepth += 1;
        if (objectDepth === 1) {
          rootWasObject = true;
        }
      },
      onObjectEnd() {
        objectDepth -= 1;
      },
      onObjectProperty(property, _offset, _length, _startLine, _startCharacter, pathSupplier) {
        if (pathSupplier().length === 0) {
          topLevelKeys.push(property);
        }
      },
      onError(error, offset, length) {
        parseErrors.push({ error, offset, length });
      },
    },
    { disallowComments: true, allowTrailingComma: false },
  );

  try {
    envelope = JSON.parse(candidateText) as unknown;
  } catch {
    envelope = undefined;
  }

  const actualKeys = envelope !== null && typeof envelope === "object"
    ? Object.keys(envelope)
    : [];
  const hasDuplicateTopLevelKey = new Set(topLevelKeys).size !== topLevelKeys.length;
  const hasExpectedKeyOrder =
    topLevelKeys.length === actualKeys.length &&
    topLevelKeys.every((key, index) => key === actualKeys[index]);
  const parsed = envelope as Record<string, unknown> | undefined;
  const hasValidShape =
    rootWasObject &&
    parseErrors.length === 0 &&
    parsed !== undefined &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    !hasDuplicateTopLevelKey &&
    hasExpectedKeyOrder &&
    (actualKeys.length === 2 || actualKeys.length === 3) &&
    actualKeys[0] === "plan" &&
    actualKeys[1] === "compression_output" &&
    (actualKeys.length === 2 || actualKeys[2] === "explanation") &&
    typeof parsed.plan === "string" &&
    typeof parsed.compression_output === "string" &&
    (actualKeys.length === 2 ||
      typeof parsed.explanation === "string" ||
      parsed.explanation === null);

  if (!hasValidShape) {
    throw new CompactionTransportMalformedPayloadError(
      summarizeCompactionTransportRequest(request),
      { contentText: candidateText },
      "response must be a JSON object with fields plan, compression_output, and optional explanation in that order; plan and compression_output must be non-empty strings.",
    );
  }

  const plan = parsed.plan as string;
  const compressionOutput = parsed.compression_output as string;
  if (plan.trim().length === 0 || compressionOutput.trim().length === 0) {
    throw new CompactionTransportMalformedPayloadError(
      summarizeCompactionTransportRequest(request),
      { contentText: candidateText },
      "response plan and compression_output fields must not be empty.",
    );
  }

  return Object.freeze({
    plan,
    compression_output: compressionOutput,
    ...(typeof parsed.explanation === "string"
      ? { explanation: parsed.explanation }
      : {}),
    rawContentText: originalContentText,
  });
}

function stripJsonCodeFence(value: string): string {
  const match = value.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1] ?? value;
}

function extractJsonObject(value: string): string | undefined {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return undefined;
  }
  return value.slice(start, end + 1);
}

export function validateCompactionTransportPayload(
  rawPayload: unknown,
  request: CompactionTransportRequest,
): ValidatedCompactionTransportPayload {
  if (!isRecord(rawPayload)) {
    throw new CompactionTransportMalformedPayloadError(
      summarizeCompactionTransportRequest(request),
      rawPayload,
      "expected a structured response or an object with a non-empty 'contentText' JSON string field.",
    );
  }

  if (
    typeof rawPayload.plan === "string" &&
    typeof rawPayload.compression_output === "string"
  ) {
    if (
      rawPayload.plan.trim().length === 0 ||
      rawPayload.compression_output.trim().length === 0 ||
      (rawPayload.explanation !== undefined &&
        rawPayload.explanation !== null &&
        typeof rawPayload.explanation !== "string")
    ) {
      throw new CompactionTransportMalformedPayloadError(
        summarizeCompactionTransportRequest(request),
        rawPayload,
        "structured response fields plan and compression_output must be non-empty strings; explanation must be a string or null when present.",
      );
    }

    return Object.freeze({
      contentText: rawPayload.compression_output,
      plan: rawPayload.plan,
      compression_output: rawPayload.compression_output,
      ...(typeof rawPayload.explanation === "string"
        ? { explanation: rawPayload.explanation }
        : {}),
      ...(typeof rawPayload.rawContentText === "string"
        ? { rawContentText: rawPayload.rawContentText }
        : {}),
    } satisfies ValidatedCompactionTransportPayload);
  }

  if (typeof rawPayload.contentText !== "string") {
    throw new CompactionTransportMalformedPayloadError(
      summarizeCompactionTransportRequest(request),
      rawPayload,
      "field 'contentText' must be a JSON string when structured response fields are absent.",
    );
  }

  if (rawPayload.contentText.trim().length === 0) {
    throw new CompactionTransportMalformedPayloadError(
      summarizeCompactionTransportRequest(request),
      rawPayload,
      "field 'contentText' must not be empty.",
    );
  }

  const parsed = parseCompactionJsonPayload(rawPayload.contentText, request);
  return Object.freeze({
    ...parsed,
    contentText: parsed.compression_output,
  } satisfies ValidatedCompactionTransportPayload);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
