import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { acquireSessionFileLock } from "../../../src/runtime/file-lock.js";
import {
  createDefaultToolExecutionGate,
  createToolExecuteBeforeHook,
} from "../../../src/runtime/send-entry-gate.js";
import { createHermeticE2EFixture } from "../harness/fixture.js";

test(
  "non-DCP tools bypass the runtime gate while compression_mark stays on the DCP lane",
  { concurrency: false },
  async (t) => {
    const fixture = await createHermeticE2EFixture(t, {
      suite: "runtime",
      caseName: "non dcp tool bypass",
    });
    const lockRoot = await mkdtemp(join(tmpdir(), "non-dcp-bypass-"));
    const lockDirectory = join(lockRoot, "locks");

    await acquireSessionFileLock({
      lockDirectory,
      sessionID: fixture.sessionID,
      startedAtMs: 10,
      now: () => 10,
    });

    const gate = createDefaultToolExecutionGate();
    const nonDcpDecision = await gate.beforeExecution({
      tool: "shell",
      sessionID: fixture.sessionID,
      callID: "call-shell-1",
    });
    assert.deepEqual(nonDcpDecision, {
      lane: "passthrough",
      blocked: false,
    });

    const dcpDecision = await gate.beforeExecution({
      tool: "compression_mark",
      sessionID: fixture.sessionID,
      callID: "call-mark-1",
    });
    assert.deepEqual(dcpDecision, {
      lane: "dcp",
      blocked: false,
    });

    const hook = createToolExecuteBeforeHook({ gate });
    const output = {
      args: {
        query: "status",
      },
    };

    await assert.doesNotReject(() =>
      hook(
        {
          tool: "shell",
          sessionID: fixture.sessionID,
          callID: "call-shell-2",
        },
        output,
      ),
    );
    assert.deepEqual(output, {
      args: {
        query: "status",
      },
    });

    const evidencePath = await fixture.evidence.writeJson("non-dcp-tool-bypass", {
      nonDcpDecision,
      dcpDecision,
      output,
    });
    assert.match(evidencePath, /non-dcp-tool-bypass\.json$/u);
  },
);
