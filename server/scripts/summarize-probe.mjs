/**
 * 리포트가 419자에서 잘린 원인을 확인한다.
 * output_tokens가 상한과 정확히 같은데 본문은 짧았다 — 텍스트가 아닌 블록이
 * 예산을 쓴 것인지, stop_reason이 무엇인지 응답 원본에서 직접 본다.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(here, "..", ".env"), "utf-8").split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

const res = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-api-key": process.env.ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
  },
  body: JSON.stringify({
    model: process.env.CLAUDE_MODEL || "claude-sonnet-5",
    max_tokens: 1200,
    messages: [{ role: "user", content: "한국 증시에서 '수급'이 무슨 뜻인지 한글 600자로 설명해줘." }],
  }),
});

const body = await res.json();
console.log("stop_reason :", body.stop_reason);
console.log("usage       :", JSON.stringify(body.usage));
console.log("block types :", (body.content ?? []).map((c) => c.type).join(", "));
for (const c of body.content ?? []) {
  const len = (c.text ?? c.thinking ?? "").length;
  console.log(`  - ${c.type}: ${len}자`);
}
