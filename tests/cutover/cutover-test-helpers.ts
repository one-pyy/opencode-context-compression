import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface AuditHit {
  readonly filePath: string;
  readonly line: number;
  readonly snippet: string;
  readonly reason: string;
}

export interface AuditPattern {
  readonly pattern: RegExp;
  readonly reason: string;
}

export interface LoadedPluginHooksFixture {
  readonly hooks: Record<string, unknown>;
  readonly tempDirectory: string;
  readonly seamLogPath: string;
}

type PluginModule = {
  default: (ctx: {
    directory: string;
    worktree: string;
    client: { session: Record<string, unknown> };
  }) => Promise<Record<string, unknown>>;
};

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const PLUGIN_ENTRY_PATH = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
export const PLUGIN_TYPES_PATH = fileURLToPath(
  new URL("../../node_modules/@opencode-ai/plugin/dist/index.d.ts", import.meta.url),
);
export const CANONICAL_CONTRACT_FILES = Object.freeze([
  "src/index.ts",
  "src/runtime/send-entry-gate.ts",
  "README.md",
  "readme.zh.md",
  "docs/live-verification-with-mitmproxy-and-debug-log.zh.md",
]);

export async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(join(REPO_ROOT, relativePath), "utf8");
}

export async function readInstalledPluginTypes(): Promise<string> {
  return readFile(PLUGIN_TYPES_PATH, "utf8");
}

export async function withLoadedPluginHooks<T>(
  run: (fixture: LoadedPluginHooksFixture) => Promise<T>,
): Promise<T> {
  const tempDirectory = await mkdtemp(join(tmpdir(), "opencode-context-compression-cutover-"));
  const seamLogPath = join(tempDirectory, "seam-observation.jsonl");
  const originalSeamLogPath = process.env.OPENCODE_CONTEXT_COMPRESSION_SEAM_LOG;

  process.env.OPENCODE_CONTEXT_COMPRESSION_SEAM_LOG = seamLogPath;

  try {
    const pluginModule = (await import(pathToFileURL(PLUGIN_ENTRY_PATH).href)) as PluginModule;
    const hooks = await pluginModule.default({
      directory: tempDirectory,
      worktree: tempDirectory,
      client: {
        session: {},
      },
    });

    return await run({ hooks, tempDirectory, seamLogPath });
  } finally {
    if (originalSeamLogPath === undefined) {
      delete process.env.OPENCODE_CONTEXT_COMPRESSION_SEAM_LOG;
    } else {
      process.env.OPENCODE_CONTEXT_COMPRESSION_SEAM_LOG = originalSeamLogPath;
    }

    await rm(tempDirectory, { recursive: true, force: true });
  }
}

export async function listRepoFiles(relativeDirectory: string): Promise<string[]> {
  return walkRelativeDirectory(relativeDirectory);
}

export async function findProductionCallSites(
  symbol: string,
  options: {
    readonly excludeFiles?: readonly string[];
  } = {},
): Promise<AuditHit[]> {
  const sourceFiles = await listRepoFiles("src");
  const trackedFiles = sourceFiles.filter((filePath) => filePath.endsWith(".ts"));
  const candidateFiles = trackedFiles.filter((filePath) => !options.excludeFiles?.includes(filePath));

  return collectAuditHits(candidateFiles, [
    {
      pattern: new RegExp(`\\b${escapeForRegExp(symbol)}\\s*\\(`, "u"),
      reason: `production callsite reaches ${symbol}()`,
    },
  ]);
}

export async function collectAuditHits(
  relativePaths: readonly string[],
  patterns: readonly AuditPattern[],
): Promise<AuditHit[]> {
  const hits: AuditHit[] = [];

  for (const relativePath of relativePaths) {
    const source = await readRepoFile(relativePath);
    const lines = source.split(/\r?\n/u);

    for (const [lineIndex, line] of lines.entries()) {
      for (const pattern of patterns) {
        const matcher = cloneAsGlobal(pattern.pattern);
        if (!matcher.test(line)) {
          continue;
        }

        hits.push({
          filePath: relativePath,
          line: lineIndex + 1,
          snippet: line.trim(),
          reason: pattern.reason,
        });
      }
    }
  }

  return hits;
}

export function formatAuditHits(title: string, hits: readonly AuditHit[]): string {
  if (hits.length === 0) {
    return `${title}: none`;
  }

  return [
    `${title}:`,
    ...hits.map(
      (hit) => `- ${hit.filePath}:${hit.line} — ${hit.reason}\n  ${hit.snippet || "(blank line)"}`,
    ),
  ].join("\n");
}

export function listVisibleRepoFiles(relativePaths: readonly string[]): string[] {
  return relativePaths.filter((relativePath) => {
    const name = basename(relativePath);
    return !name.startsWith(".") && name !== ".gitkeep";
  });
}

async function walkRelativeDirectory(relativeDirectory: string): Promise<string[]> {
  const absoluteDirectory = join(REPO_ROOT, relativeDirectory);

  try {
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    const discovered = await Promise.all(
      entries.map(async (entry) => {
        const childRelativePath = join(relativeDirectory, entry.name);
        if (entry.isDirectory()) {
          return walkRelativeDirectory(childRelativePath);
        }

        if (entry.isFile()) {
          return [childRelativePath];
        }

        return [];
      }),
    );

    return discovered.flat().sort();
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }

    throw error;
  }
}

function cloneAsGlobal(pattern: RegExp): RegExp {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags);
}

function escapeForRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
