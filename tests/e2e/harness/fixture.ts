import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import {
  createE2EEvidenceWriter,
  type E2EEvidenceWriter,
} from "./evidence.js";
import {
  installNetworkDeny,
  type InstalledNetworkDeny,
} from "./network-deny.js";
import { buildE2ESessionID } from "./session-naming.js";

const DEFAULT_REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export interface HermeticE2EFixtureOptions {
  readonly suite: string;
  readonly caseName: string;
  readonly repoRoot?: string;
}

export interface HermeticE2EFixture {
  readonly repoRoot: string;
  readonly sessionID: string;
  readonly evidence: E2EEvidenceWriter;
  readonly networkDeny: InstalledNetworkDeny;
}

export async function createHermeticE2EFixture(
  t: TestContext,
  options: HermeticE2EFixtureOptions,
): Promise<HermeticE2EFixture> {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const sessionID = buildE2ESessionID({
    suite: options.suite,
    caseName: options.caseName,
  });
  const evidence = await createE2EEvidenceWriter({
    repoRoot,
    sessionID,
    suite: options.suite,
    caseName: options.caseName,
  });
  const networkDeny = installNetworkDeny();

  t.after(() => {
    networkDeny.restore();
  });

  return {
    repoRoot,
    sessionID,
    evidence,
    networkDeny,
  } satisfies HermeticE2EFixture;
}
