import { renderModelVisiblePartsText } from "../model-visible-transcript.js";
import type { ProjectedPromptMessage } from "./types.js";

export function renderProjectedVisibleText(message: ProjectedPromptMessage): string {
  let hasText = false;
  const hasContent = message.contentText.trim().length > 0;
  const parts = (message.parts ?? []).map((part) => {
    if (part.type !== "text") return part;
    const first = !hasText;
    hasText = true;
    // Match the host's first-text replacement without changing its message shape.
    return first && hasContent ? { ...part, text: message.contentText } : part;
  });
  if (!hasText && hasContent) parts.unshift({ type: "text", text: message.contentText });
  return renderModelVisiblePartsText(parts);
}
