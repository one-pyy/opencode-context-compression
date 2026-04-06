import { assertSafeSessionIDSegment } from "../../../src/runtime/path-safety.js";

const NON_ALPHANUMERIC_RE = /[^a-z0-9]+/gu;
const TRIM_DASH_RE = /^-+|-+$/gu;

export interface E2ESessionNameInput {
  readonly suite: string;
  readonly caseName: string;
}

export function slugifyE2ENamePart(value: string, label: string): string {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(NON_ALPHANUMERIC_RE, "-")
    .replace(TRIM_DASH_RE, "");

  if (slug.length === 0) {
    throw new Error(`E2E ${label} must contain at least one ASCII letter or digit.`);
  }

  return slug;
}

export function buildE2ESessionID(input: E2ESessionNameInput): string {
  const suiteSlug = slugifyE2ENamePart(input.suite, "suite name");
  const caseSlug = slugifyE2ENamePart(input.caseName, "case name");
  const sessionID = `e2e-${suiteSlug}--${caseSlug}`;

  return assertSafeSessionIDSegment(sessionID);
}
