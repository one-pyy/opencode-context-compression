import fs from "node:fs";
import { parse } from "jsonc-parser";

const configPath = "/root/_/opencode/config/opencode.jsonc";
const content = fs.readFileSync(configPath, "utf-8");
const parsed = parse(content);

const doro = parsed.provider?.["google.doro"];

async function testThinking() {
  const url = `${doro.options.baseURL}/models/gemini-3-flash-preview:generateContent?key=${doro.options.apiKey}`;
  
  const payload = {
    contents: [{ role: "user", parts: [{ text: "What is 2+2? Give me the answer directly." }] }],
    generationConfig: {
      temperature: 0,
      thinkingConfig: { thinkingBudgetTokens: 1024 }
    }
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
}

testThinking().catch(console.error);
