import fs from "node:fs";
import path from "node:path";

const TRANSCRIPTS_DIR = "/root/_/opencode/config/claude/transcripts";
const SYSTEM_PROMPT_PATH = path.join(process.cwd(), "prompts/compaction.md");

interface MessageEntry {
  role: "user" | "assistant" | "tool";
  content: string;
}

// 1. Parse JSONL Transcripts
function loadTranscripts(): MessageEntry[][] {
  const files = fs.readdirSync(TRANSCRIPTS_DIR).filter(f => f.endsWith(".jsonl"));
  const allConversations: MessageEntry[][] = [];

  for (const file of files) {
    const content = fs.readFileSync(path.join(TRANSCRIPTS_DIR, file), "utf-8");
    const lines = content.split("\n").filter(l => l.trim().length > 0);
    const convo: MessageEntry[] = [];
    
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        let role: "user" | "assistant" | "tool" = "user";
        let text = "";

        if (obj.type === "user") {
          role = "user";
          text = obj.content;
        } else if (obj.type === "assistant") {
          role = "assistant";
          text = obj.content || "";
        } else if (obj.type === "tool_use") {
          role = "assistant";
          text = `[Tool Use: ${obj.tool_name}]\n${JSON.stringify(obj.tool_input, null, 2)}`;
        } else if (obj.type === "tool_result") {
          role = "tool";
          text = typeof obj.content === "string" ? obj.content : JSON.stringify(obj.content);
        } else {
          continue;
        }

        if (text && text.trim().length > 0) {
          convo.push({ role, content: text });
        }
      } catch (e) {
        // ignore malformed line
      }
    }
    if (convo.length > 5) {
      allConversations.push(convo);
    }
  }
  return allConversations;
}

// 2. Generate Random Evaluation Cases
function generateEvalCases(conversations: MessageEntry[][], count: number) {
  const cases = [];
  for (let i = 0; i < count; i++) {
    // Pick random conversation
    const convo = conversations[Math.floor(Math.random() * conversations.length)];
    
    // Pick random length between 20 and 80 (有长有短，增加上下文长度)
    const length = Math.floor(Math.random() * 60) + 20;
    const maxStart = Math.max(0, convo.length - length);
    const start = Math.floor(Math.random() * maxStart);
    const chunk = convo.slice(start, start + length).map(c => ({ ...c })); // deep copy
    
    // Inject opaque slots (1 to 8 messages)
    const validTargets = chunk.map((m, idx) => ({ m, idx })).filter(x => x.m.content.length > 20);
    let injectedSlotsCount = 0;
    const injectedIds: string[] = [];

    if (validTargets.length > 0) {
      // Shuffle valid targets
      for (let j = validTargets.length - 1; j > 0; j--) {
        const k = Math.floor(Math.random() * (j + 1));
        [validTargets[j], validTargets[k]] = [validTargets[k], validTargets[j]];
      }

      const targetCount = Math.floor(Math.random() * Math.min(8, validTargets.length)) + 1; // 1 to 8
      
      for (let j = 0; j < targetCount; j++) {
        const target = validTargets[j];
        const slotId = `S${j + 1}`;
        chunk[target.idx].content = `<opaque slot="${slotId}">${target.m.content}</opaque>`;
        injectedIds.push(slotId);
        injectedSlotsCount++;
      }
    }

    cases.push({
      id: `case_${i + 1}`,
      length: chunk.length,
      injectedSlotsCount,
      injectedIds,
      chunk
    });
  }
  return cases;
}

// 3. Format Prompt
function formatPrompt(chunk: MessageEntry[]) {
  let userMessage = "executionMode=compact\nallowDelete=true\n\n";
  chunk.forEach((msg, idx) => {
    const seq = idx + 1;
    const hostId = `host_${seq}`;
    const canonicalId = `msg_${seq}`;
    userMessage += `### ${seq}. ${msg.role} ${hostId} (${canonicalId})\n${msg.content}\n\n`;
  });
  userMessage += "\n\nCRITICAL REMINDER: You MUST replace every `<opaque slot=\"...\">...</opaque>` block with a self-closing `<opaque slot=\"...\"/>` tag. Do not omit any opaque slots!";
  return userMessage;
}

import { parse } from "jsonc-parser";

// 4. LLM Invocation
function parseJsonc(source: string): any {
  return parse(source);
}

let apiConfigs: { url: string; key: string }[] = [];

function loadApiConfigs() {
  try {
    const configPath = "/root/_/opencode/config/opencode.jsonc";
    const content = fs.readFileSync(configPath, "utf-8");
    const parsed = parseJsonc(content);

    const doro = parsed.provider?.["google.doro"];
    if (doro) {
      apiConfigs.push({
        url: `${doro.options.baseURL}/models/gemini-3-flash-preview:generateContent`,
        key: doro.options.apiKey
      });
    }

    const right = parsed.provider?.["google.right"];
    if (right) {
      apiConfigs.push({
        url: `${right.options.baseURL}/models/gemini-3-flash-preview:generateContent`,
        key: right.options.apiKey
      });
    }
  } catch (e) {
    console.warn("Could not load API configs from opencode.jsonc:", e);
  }
}

async function callLLM(systemPrompt: string, userMessage: string, attempt = 0) {
  if (apiConfigs.length === 0) {
    loadApiConfigs();
  }

  if (apiConfigs.length === 0) {
    throw new Error("No valid Gemini configs found in opencode.jsonc");
  }

  for (let i = 0; i < 3; i++) {
    const config = apiConfigs[Math.floor(Math.random() * apiConfigs.length)];
    try {
    const res = await fetch(`${config.url}?key=${config.key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: userMessage }] }],
        generationConfig: { 
          temperature: 0,
          thinkingConfig: { }
        }
      })
    });
      if (!res.ok) throw new Error(`Gemini API Error: ${await res.text()}`);
      const data = await res.json();
      return data.candidates[0].content.parts[0].text;
    } catch (e: any) {
      if (i === 2) throw e;
      await new Promise(r => setTimeout(r, 2000)); // wait and retry
    }
  }
}

// 5. Main Execution
async function runEval() {
  console.log("Loading transcripts...");
  const conversations = loadTranscripts();
  console.log(`Loaded ${conversations.length} valid conversations.`);

  const cases = generateEvalCases(conversations, 50); // 50 samples
  cases.sort((a, b) => a.length - b.length); // 先做短的再做长的
  const systemPrompt = fs.readFileSync(SYSTEM_PROMPT_PATH, "utf-8");

  let success = 0;
  let skipped = 0;
  let processed = 0;
  const failures: any[] = [];
  let aborted = false;
  let activeCount = 0;

  // Concurrency from env or default to 10
  let concurrency = parseInt(process.env.EVAL_CONCURRENCY || "10", 10);
  console.log(`\nStarting LLM Evaluation (50 Cases, Concurrency: ${concurrency})...\n`);

  async function processItem(c: any) {
    if (aborted) return;
    
    // 如果失败数超过限制，立即取消
    if (failures.length >= 10) {
      if (!aborted) {
        console.log("\n⚠️ Reached 10 failures. Aborting early to save time...");
        aborted = true;
      }
      return;
    }

    if (c.injectedSlotsCount === 0) {
      skipped++;
      return;
    }

    activeCount++;
    processed++;
    const userMessage = formatPrompt(c.chunk);
    try {
      const output = await callLLM(systemPrompt, userMessage);
      
      let analysisMatch = output.match(/<analysis>([\s\S]*?)<\/analysis>/i);
      let analysisText = analysisMatch ? analysisMatch[1].trim() : "NO ANALYSIS BLOCK FOUND";
      let cleanOutput = output.replace(/<analysis>[\s\S]*?<\/analysis>\n*/gi, '').trim();

      let allSlotsRetained = true;
      const missingSlots = [];
      let searchStart = 0;

      for (const slotId of c.injectedIds) {
        // Look for self-closing tag first, then fallback to open tag
        const selfClosingTag = `<opaque slot="${slotId}"/>`;
        const selfClosingTagWithSpace = `<opaque slot="${slotId}" />`;
        const openTag = `<opaque slot="${slotId}">`;

        let placeholderIndex = cleanOutput.indexOf(selfClosingTag, searchStart);
        let matchLength = selfClosingTag.length;

        if (placeholderIndex < 0) {
          placeholderIndex = cleanOutput.indexOf(selfClosingTagWithSpace, searchStart);
          if (placeholderIndex >= 0) {
            matchLength = selfClosingTagWithSpace.length;
          }
        }

        if (placeholderIndex < 0) {
          placeholderIndex = cleanOutput.indexOf(openTag, searchStart);
          if (placeholderIndex >= 0) {
            const closeTag = "</opaque>";
            const closeIndex = cleanOutput.indexOf(closeTag, placeholderIndex + openTag.length);
            if (closeIndex >= 0) {
              matchLength = closeIndex + closeTag.length - placeholderIndex;
            } else {
              matchLength = openTag.length;
            }
          }
        }

        if (placeholderIndex < 0) {
          allSlotsRetained = false;
          missingSlots.push(slotId);
        } else {
          searchStart = placeholderIndex + matchLength;
        }
      }

      if (allSlotsRetained) {
        console.log(`[${c.id}] ✅ Success (Length: ${c.length} msgs, Slots: ${c.injectedSlotsCount})`);
        success++;
      } else {
        console.log(`[${c.id}] ❌ Failed (Lost slots: ${missingSlots.join(", ")})`);
        failures.push({
          id: c.id,
          missingSlots,
          input: userMessage,
          analysis: analysisText,
          output: cleanOutput
        });
        const failureLogPath = path.join(process.cwd(), "logs/eval-failures.json");
        fs.mkdirSync(path.join(process.cwd(), "logs"), { recursive: true });
        fs.writeFileSync(failureLogPath, JSON.stringify(failures, null, 2));
      }
    } catch (e: any) {
      console.log(`[${c.id}] ⚠️ Error: ${e.message}`);
      failures.push({
        id: c.id,
        input: userMessage,
        output: `API Error: ${e.message}`
      });
    } finally {
      activeCount--;
      // 一旦有失败，降低并发以防浪费 token，但最低为 1
      if (failures.length > 0 && concurrency > 1) {
        concurrency = Math.max(1, 10 - failures.length);
      }
    }
  }

  let index = 0;
  const workers = Array.from({ length: 10 }, async (_, workerId) => {
    while (index < cases.length && !aborted) {
      // 如果当前活跃的任务数已经达到了动态调整后的并发限制，则稍作等待
      if (activeCount >= concurrency) {
        await new Promise(r => setTimeout(r, 100));
        continue;
      }
      const item = cases[index++];
      if (item) {
        await processItem(item);
      }
    }
  });
  await Promise.all(workers);

  const totalEvaluated = processed;
  console.log("\n==============================");
  console.log(`Evaluation Complete ${aborted ? "(Aborted Early)" : ""}`);
  console.log(`Total Cases Evaluated: ${totalEvaluated}`);
  console.log(`Success Rate: ${Math.round((success / totalEvaluated) * 100)}% (${success}/${totalEvaluated})`);
  
  if (failures.length > 0) {
    const failureLogPath = path.join(process.cwd(), "logs/eval-failures.json");
    fs.mkdirSync(path.join(process.cwd(), "logs"), { recursive: true });
    fs.writeFileSync(failureLogPath, JSON.stringify(failures, null, 2));
    console.log(`\nFailed cases have been saved to: ${failureLogPath} for analysis.`);
  }
}

runEval().catch(console.error);
