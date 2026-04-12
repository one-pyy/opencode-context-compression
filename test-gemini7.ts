import fs from "node:fs";
import { parse } from "jsonc-parser";

const configPath = "/root/_/opencode/config/opencode.jsonc";
const content = fs.readFileSync(configPath, "utf-8");
const parsed = parse(content);

const doro = parsed.provider?.["google.doro"];

async function testThinking() {
  const url = `${doro.options.baseURL}/models/gemini-3-flash-preview:generateContent?key=${doro.options.apiKey}`;
  
  const systemPrompt = fs.readFileSync("prompts/compaction.md", "utf-8");
  const userMessage = `executionMode=compact\nallowDelete=true\n\n### 1. user host_1 (msg_1)\nCan you check the logs?\n\n### 2. assistant host_2 (msg_2)\n<opaque slot="S1">\n[Tool Use: bash]\n{\n  "command": "cat logs.txt"\n}\n</opaque>\n\n### 3. tool host_3 (msg_3)\nLog output: error on line 42`;

  const payload = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userMessage }] }],
    generationConfig: {
      temperature: 0,
      thinkingConfig: { }
    }
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  console.log(data.candidates[0].content.parts[0].text);
}

testThinking().catch(console.error);
