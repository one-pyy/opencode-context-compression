const fs = require('fs');
const path = require('path');
const TRANSCRIPTS_DIR = "/root/_/opencode/config/claude/transcripts";
const files = fs.readdirSync(TRANSCRIPTS_DIR).filter(f => f.endsWith(".jsonl"));
let maxLen = 0;
let minLen = 9999;
let count = 0;
for (const file of files) {
  const content = fs.readFileSync(path.join(TRANSCRIPTS_DIR, file), "utf-8");
  const lines = content.split("\n").filter(l => l.trim().length > 0);
  maxLen = Math.max(maxLen, lines.length);
  minLen = Math.min(minLen, lines.length);
  count++;
}
console.log(`Count: ${count}, Min: ${minLen}, Max: ${maxLen}`);
