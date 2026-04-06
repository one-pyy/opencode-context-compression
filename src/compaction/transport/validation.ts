import {
  CompactionTransportMalformedPayloadError,
  summarizeCompactionTransportRequest,
} from "./errors.js";
import type {
  CompactionTransportRequest,
  ValidatedCompactionTransportPayload,
} from "./types.js";

export function validateCompactionTransportPayload(
  rawPayload: unknown,
  request: CompactionTransportRequest,
): ValidatedCompactionTransportPayload {
  if (!isRecord(rawPayload)) {
    throw new CompactionTransportMalformedPayloadError(
      summarizeCompactionTransportRequest(request),
      rawPayload,
      "expected an object with a non-empty 'contentText' string field.",
    );
  }

  if (typeof rawPayload.contentText !== "string") {
    throw new CompactionTransportMalformedPayloadError(
      summarizeCompactionTransportRequest(request),
      rawPayload,
      "field 'contentText' must be a string.",
    );
  }

  if (rawPayload.contentText.trim().length === 0) {
    throw new CompactionTransportMalformedPayloadError(
      summarizeCompactionTransportRequest(request),
      rawPayload,
      "field 'contentText' must not be empty.",
    );
  }

  return Object.freeze({
    contentText: rawPayload.contentText,
  } satisfies ValidatedCompactionTransportPayload);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
