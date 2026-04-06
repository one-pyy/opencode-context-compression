import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import test from "node:test";

import { createHermeticE2EFixture } from "../harness/fixture.js";

const CRITICAL_MODULE_FILES = [
  "src/runtime/runtime-config-loader.ts",
  "src/runtime/prompt-resolver.ts",
  "src/history/history-replay-reader.ts",
  "src/state/result-group-repository.ts",
  "src/identity/canonical-identity.ts",
  "src/projection/policy-engine.ts",
  "src/projection/reminder-service.ts",
  "src/projection/projection-builder.ts",
  "src/compaction/input-builder.ts",
  "src/compaction/output-validation.ts",
  "src/runtime/compaction-transport.ts",
  "src/compaction/runner.ts",
  "src/runtime/send-entry-gate.ts",
  "src/runtime/chat-params-scheduler.ts",
] as const;

test(
  "critical internal module files stay acyclic and preserve the locked dependency direction",
  { concurrency: false },
  async (t) => {
    const fixture = await createHermeticE2EFixture(t, {
      suite: "interfaces",
      caseName: "no circular deps",
    });

    const absoluteFiles = CRITICAL_MODULE_FILES.map((file) =>
      resolve(fixture.repoRoot, file),
    );
    const fileSet = new Set(absoluteFiles);
    const graph = new Map<string, string[]>();

    for (const filePath of absoluteFiles) {
      const source = await readFile(filePath, "utf8");
      const imports = [...source.matchAll(/from\s+"([^"]+)"/gu)]
        .map((match) => match[1])
        .filter((specifier): specifier is string => specifier !== undefined)
        .filter((specifier) => specifier.startsWith("."))
        .map((specifier) => resolveImportPath(filePath, specifier))
        .filter((resolved): resolved is string => resolved !== null)
        .filter((resolved) => fileSet.has(resolved));

      graph.set(filePath, imports);
    }

    const cycle = findCycle(graph);
    assert.equal(cycle, null);

    const repositoryFile = resolve(
      fixture.repoRoot,
      "src/state/result-group-repository.ts",
    );
    const projectionBuilderFile = resolve(
      fixture.repoRoot,
      "src/projection/projection-builder.ts",
    );
    const reminderFile = resolve(
      fixture.repoRoot,
      "src/projection/reminder-service.ts",
    );
    const runnerFile = resolve(fixture.repoRoot, "src/compaction/runner.ts");
    const transportFile = resolve(
      fixture.repoRoot,
      "src/runtime/compaction-transport.ts",
    );
    const pluginHooksFile = resolve(
      fixture.repoRoot,
      "src/runtime/plugin-hooks.ts",
    );

    assert.ok(!(graph.get(repositoryFile) ?? []).includes(projectionBuilderFile));
    assert.ok(!(graph.get(reminderFile) ?? []).includes(runnerFile));
    assert.ok(!(graph.get(transportFile) ?? []).includes(pluginHooksFile));

    const evidencePath = await fixture.evidence.writeJson("no-circular-deps", {
      files: CRITICAL_MODULE_FILES,
      graph: Object.fromEntries(
        [...graph.entries()].map(([from, to]) => [
          from.replace(`${fixture.repoRoot}/`, ""),
          to.map((entry) => entry.replace(`${fixture.repoRoot}/`, "")),
        ]),
      ),
    });
    assert.match(evidencePath, /no-circular-deps\.json$/u);
  },
);

function resolveImportPath(fromFile: string, specifier: string): string | null {
  const resolved = resolve(dirname(fromFile), specifier);

  if (extname(resolved) === ".ts") {
    return resolved;
  }

  return `${resolved.replace(/\.js$/u, "")}.ts`;
}

function findCycle(graph: ReadonlyMap<string, readonly string[]>): string[] | null {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  for (const node of graph.keys()) {
    const cycle = visit(node);
    if (cycle !== null) {
      return cycle;
    }
  }

  return null;

  function visit(node: string): string[] | null {
    if (visited.has(node)) {
      return null;
    }
    if (visiting.has(node)) {
      const startIndex = stack.indexOf(node);
      return stack.slice(startIndex).concat(node);
    }

    visiting.add(node);
    stack.push(node);

    for (const neighbor of graph.get(node) ?? []) {
      const cycle = visit(neighbor);
      if (cycle !== null) {
        return cycle;
      }
    }

    stack.pop();
    visiting.delete(node);
    visited.add(node);
    return null;
  }
}
