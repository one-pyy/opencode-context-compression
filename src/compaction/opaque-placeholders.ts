const OPAQUE_PLACEHOLDER_OPENING_TAG_PATTERN =
  /<opaque\s+slot="([A-Za-z0-9_-]+)">/gu;

export function renderOpaquePlaceholder(slot: string, contentText: string): string {
  return `<opaque slot="${normalizeOpaqueSlot(slot)}">${contentText}</opaque>`;
}

export function normalizeOpaqueSlot(slot: string): string {
  if (typeof slot !== "string") {
    throw new Error("Opaque placeholder slot must be a string.");
  }

  const trimmed = slot.trim();
  if (trimmed.length === 0) {
    throw new Error("Opaque placeholder slot must not be empty.");
  }

  if (!/^[A-Za-z0-9_-]+$/u.test(trimmed)) {
    throw new Error(
      "Opaque placeholder slot must use only letters, numbers, underscores, or hyphens.",
    );
  }

  return trimmed;
}

export function extractOpaqueSlotReferences(contentText: string): readonly string[] {
  const slots: string[] = [];

  for (const match of contentText.matchAll(OPAQUE_PLACEHOLDER_OPENING_TAG_PATTERN)) {
    const slot = match[1];
    if (slot !== undefined) {
      slots.push(slot);
    }
  }

  return Object.freeze(slots);
}

export function includesOpaquePlaceholder(
  contentText: string,
  expectedPlaceholder: string,
  fromIndex = 0,
): number {
  return contentText.indexOf(expectedPlaceholder, fromIndex);
}
