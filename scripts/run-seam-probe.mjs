import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const logPath = join(root, "logs", "seam-observation.jsonl");
const pluginUrl = pathToFileURL(join(root, "src", "index.ts")).href;

mkdirSync(dirname(logPath), { recursive: true });
rmSync(logPath, { force: true });

await runProbe();
const observations = await readProbeObservations(logPath);
assertProbeObservations(observations);

console.log(logPath);

function runProbe() {
  const probeScript = `
    import assert from "node:assert/strict";
    import plugin from ${JSON.stringify(pluginUrl)};

    const sessionID = "seam-probe-session";
    const userMessage = {
      id: "msg-user-probe",
      sessionID,
      role: "user",
      time: { created: 1 },
      agent: "atlas",
      model: { providerID: "probe", modelID: "probe" },
    };
    const assistantMessage = {
      id: "msg-assistant-probe",
      sessionID,
      role: "assistant",
      time: { created: 2 },
      agent: "atlas",
      model: { providerID: "probe", modelID: "probe" },
    };
    const sessionMessages = [
      {
        info: userMessage,
        parts: [
          {
            id: "part-user-probe",
            sessionID,
            messageID: "msg-user-probe",
            type: "text",
            text: "Please summarize the diagnostic thread.",
          },
        ],
      },
      {
        info: assistantMessage,
        parts: [
          {
            id: "part-assistant-probe",
            sessionID,
            messageID: "msg-assistant-probe",
            type: "text",
            text: "Assistant investigates the diagnostics in the probe harness.",
          },
        ],
      },
    ];

    const hooks = await plugin({
      client: {
        session: {
          messages: async () => ({ data: sessionMessages }),
        },
      },
      project: {},
      directory: ${JSON.stringify(root)},
      worktree: ${JSON.stringify(root)},
      serverUrl: new URL("http://localhost:3900"),
      $: {},
    });

    assert.equal(typeof hooks["chat.params"], "function");
    assert.equal(typeof hooks["experimental.chat.messages.transform"], "function");
    assert.equal(typeof hooks["tool.execute.before"], "function");

    const chatParamsOutput = {
      temperature: 0,
      topP: 1,
      topK: 1,
      options: {},
    };
    await hooks["chat.params"](
      {
        sessionID,
        agent: "atlas",
        model: { id: "probe-model", name: "probe-model", provider: "probe" },
        provider: {
          source: "custom",
          info: {},
          options: {},
        },
        message: userMessage,
      },
      chatParamsOutput,
    );

    const transformOutput = {
      messages: structuredClone(sessionMessages),
    };
    await hooks["experimental.chat.messages.transform"]({}, transformOutput);

    await hooks["tool.execute.before"](
      {
        tool: "shell",
        sessionID,
        callID: "call-probe-1",
      },
      {
        args: { command: "pwd" },
      },
    );
  `;

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "-e", probeScript],
      {
        cwd: root,
        stdio: "inherit",
        env: {
          ...process.env,
          OPENCODE_CONTEXT_COMPRESSION_SEAM_LOG: logPath,
        },
      },
    );

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Seam probe failed with exit code ${code}`));
    });
  });
}

async function readProbeObservations(filePath) {
  const serialized = await readFile(filePath, "utf8");
  return serialized
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function assertProbeObservations(observations) {
  assert.ok(
    observations.length > 0,
    "Seam probe did not record any seam observations, so plugin load/logging could not be verified.",
  );

  const seamNames = new Set(observations.map((entry) => entry.seam));
  assert.ok(
    seamNames.size >= 1,
    "Seam probe must record at least one seam observation to prove seam logging is active.",
  );
  assert.ok(
    seamNames.has("chat.params"),
    "Seam probe must observe chat.params to prove the scheduler seam loaded and logged.",
  );
  assert.ok(
    seamNames.has("experimental.chat.messages.transform"),
    "Seam probe must observe experimental.chat.messages.transform to prove projection seam logging is active.",
  );
  assert.ok(
    seamNames.has("tool.execute.before"),
    "Seam probe must observe tool.execute.before to prove tool seam logging is active.",
  );
}
