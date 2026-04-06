import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { resolvePathWithinDirectory } from "../../../src/runtime/path-safety.js";

import { slugifyE2ENamePart } from "./session-naming.js";

export const HERMETIC_E2E_EVIDENCE_ROOT = ".sisyphus/evidence/task-3-hermetic-e2e";

export interface E2EEvidenceManifest {
  readonly conventionVersion: 1;
  readonly sessionID: string;
  readonly suite: string;
  readonly caseName: string;
  readonly networkPolicy: "deny-by-default";
  readonly transportPolicy: "inject-safe-transport";
  readonly runner: "node-test-runner";
}

export interface E2EEvidenceWriter {
  readonly rootDirectory: string;
  readonly sessionDirectory: string;
  readonly manifestPath: string;
  writeJson(name: string, value: unknown): Promise<string>;
  writeText(name: string, text: string, extension?: string): Promise<string>;
}

export async function createE2EEvidenceWriter(input: {
  readonly repoRoot: string;
  readonly sessionID: string;
  readonly suite: string;
  readonly caseName: string;
}): Promise<E2EEvidenceWriter> {
  const rootDirectory = resolve(input.repoRoot, HERMETIC_E2E_EVIDENCE_ROOT);
  const sessionDirectory = resolvePathWithinDirectory(
    rootDirectory,
    input.sessionID,
    "hermetic e2e evidence session",
  );
  const manifestPath = resolvePathWithinDirectory(
    sessionDirectory,
    "manifest.json",
    "hermetic e2e manifest",
  );
  const manifest = {
    conventionVersion: 1,
    sessionID: input.sessionID,
    suite: input.suite,
    caseName: input.caseName,
    networkPolicy: "deny-by-default",
    transportPolicy: "inject-safe-transport",
    runner: "node-test-runner",
  } satisfies E2EEvidenceManifest;

  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  return {
    rootDirectory,
    sessionDirectory,
    manifestPath,
    async writeJson(name, value) {
      const filePath = resolvePathWithinDirectory(
        sessionDirectory,
        `${slugifyArtifactName(name)}.json`,
        "hermetic e2e JSON evidence",
      );
      await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      return filePath;
    },
    async writeText(name, text, extension = ".txt") {
      const filePath = resolvePathWithinDirectory(
        sessionDirectory,
        `${slugifyArtifactName(name)}${normalizeExtension(extension)}`,
        "hermetic e2e text evidence",
      );
      await writeFile(filePath, text.endsWith("\n") ? text : `${text}\n`, "utf8");
      return filePath;
    },
  } satisfies E2EEvidenceWriter;
}

function slugifyArtifactName(name: string): string {
  return slugifyE2ENamePart(name, "evidence artifact name");
}

function normalizeExtension(extension: string): string {
  const trimmed = extension.trim();
  if (trimmed.length === 0) {
    throw new Error("Evidence file extension must not be empty.");
  }

  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}
