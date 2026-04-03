import { mkdirSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tmpConfigDir = join(root, ".tmp", "opencode-config");
const logPath = join(root, "logs", "seam-observation.jsonl");
const opencodeBin = "/root/.opencode/bin/opencode";
const pluginUrl = pathToFileURL(join(root, "src", "index.ts")).href;

const prompt = process.argv.slice(2).join(" ").trim() || 'Use the read tool on README.md, then reply with exactly OK.';

mkdirSync(tmpConfigDir, { recursive: true });
mkdirSync(dirname(logPath), { recursive: true });
rmSync(logPath, { force: true });

await writeFile(
  join(tmpConfigDir, "opencode.json"),
  JSON.stringify({ plugin: [pluginUrl], model: "openai.doro/gpt-5.4-mini" }, null, 2) + "\n",
  "utf8",
);

await runProbe(prompt);

console.log(logPath);

function runProbe(promptText) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      opencodeBin,
      ["run", "--model", "openai.doro/gpt-5.4-mini", promptText],
      {
        cwd: root,
        stdio: "inherit",
        env: {
          ...process.env,
          OPENCODE_CONFIG_DIR: tmpConfigDir,
          OPENCODE_DISABLE_PROJECT_CONFIG: "1",
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
      reject(new Error(`Probe failed with exit code ${code}`));
    });
  });
}
