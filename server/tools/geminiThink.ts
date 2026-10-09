/**
 * **제미나이 생각 예산 실측** (2026-10-09).
 *
 * 「토큰 4637/276 · 출력 상한(7,000토큰)에 걸려 뒤가 잘렸습니다」 — 숫자가 안 맞는다.
 * 2.5 세대부터 `maxOutputTokens` 가 생각+답을 합쳐 센다는 가설을 잰다.
 * 같은 길이 요구를 ① 예전 모양 ② thinkingConfig 로 생각을 묶은 모양으로 각각 보낸다.
 *
 *   npx tsx tools/geminiThink.ts
 */
import "dotenv/config";

const model = process.env.GEMINI_VISION_MODEL?.trim() || "gemini-3.5-flash";
const key = process.env.GEMINI_API_KEY!.trim();
const prompt = "아래 주제 여섯 개를 각각 세 문장짜리 한국어 문단으로 정리해 줘.\n반도체, 환율, 금리, 조선, 2차전지, 바이오";

async function go(label: string, cfg: Record<string, unknown>) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: cfg }),
  });
  const b = (await r.json()) as any;
  if (!r.ok || b.error) {
    console.log(`${label}: HTTP ${r.status} — ${b.error?.message ?? "?"}`);
    return;
  }
  const u = b.usageMetadata ?? {};
  const parts = (b.candidates?.[0]?.content?.parts ?? []).filter((p: any) => !p.thought);
  const text = parts.map((p: any) => p.text ?? "").join("");
  console.log(
    `${label}: finish=${b.candidates?.[0]?.finishReason} · 생각 ${u.thoughtsTokenCount ?? 0} · 답 ${u.candidatesTokenCount ?? 0} · 글자 ${text.length}`,
  );
}

console.log(`모델 ${model}`);
await go("① 예전 (maxOutputTokens 700)        ", { temperature: 0, maxOutputTokens: 700 });
await go("② 생각 묶음 (답 700 + 생각 2048)    ", { temperature: 0, maxOutputTokens: 700 + 2048, thinkingConfig: { thinkingBudget: 2048 } });
await go("③ 여유만 (maxOutputTokens 2748)     ", { temperature: 0, maxOutputTokens: 700 + 2048 });
process.exit(0);
