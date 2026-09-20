const LEADING_VISIBLE_ID_PREFIX_PATTERN =
  /^\[(?:protected|compressible|referable)_\d{6}_[0-9A-Za-z]{2}\]\s?/u;

export interface RenderModelVisiblePartsTextOptions {
  readonly stripLeadingVisibleIdPrefix?: boolean;
}

export function renderModelVisiblePartsText(
  parts: readonly unknown[],
  options: RenderModelVisiblePartsTextOptions = {},
): string {
  const content = parts
    .flatMap((part) => renderModelVisiblePart(part))
    .join("\n")
    .trim();

  return options.stripLeadingVisibleIdPrefix === true
    ? content.replace(LEADING_VISIBLE_ID_PREFIX_PATTERN, "").trim()
    : content;
}

function renderModelVisiblePart(part: unknown): readonly string[] {
  if (!isRecord(part)) {
    return [];
  }

  const type = part.type;
  if (type === "text") {
    return typeof part.text === "string" ? [part.text] : [];
  }

  if (type === "tool") {
    return [renderToolPart(part)];
  }

  return [];
}

function renderToolPart(part: Readonly<Record<string, unknown>>): string {
  const toolName = typeof part.tool === "string" && part.tool.trim().length > 0
    ? part.tool
    : "unknown_tool";
  const state = isRecord(part.state) ? part.state : {};
  const blocks = [`[tool call]\nname: ${toolName}`];

  if (Object.hasOwn(state, "input")) {
    const input = serializeModelVisibleField(state.input);
    if (input.length > 0) {
      blocks.push(`input: ${input}`);
    }
  }

  const resultLines = ["[tool result]"];
  if (typeof state.status === "string" && state.status.trim().length > 0) {
    resultLines.push(`status: ${state.status}`);
  }

  if (Object.hasOwn(state, "output")) {
    const output = serializeModelVisibleField(state.output);
    if (output.length > 0) {
      resultLines.push(`output: ${output}`);
    }
  }

  blocks.push(resultLines.join("\n"));
  return blocks.join("\n");
}

function serializeModelVisibleField(value: unknown): string {
  return typeof value === "string" ? value : stringifyCompactJson(value);
}

function stringifyCompactJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object";
}
