import Anthropic from "@anthropic-ai/sdk";
import { recordApiCall } from "./apiUsage.js";
import { getCisConfig } from "./cisConfig.js";
import { RULE_LABEL } from "./cisConfig.js";
import type { CisRules } from "./cisTrader.js";
import type { Candidate } from "./cisTrader.js";
import type { CisDay, Slot } from "./cisJournal.js";
import { SLOT_LABEL, listDays } from "./cisJournal.js";
import { personaPrompt, readState, type PersonaState } from "./cisPersona.js";

/**
 * CIS 일지의 AI 계층.
 *
 * ## 여기가 하지 않는 일
 *
 * **매매 판단을 하지 않는다.** 무엇을 살지·팔지는 `cisTrader` 의 규칙이 이미 정해
 * 놓았고, 이 파일은 그 결과에 말을 붙일 뿐이다. 이유는 재현성이다 — 같은 날을
 * 다시 돌려도 같은 답이 나와야 「어느 규칙이 나빴나」를 물을 수 있다.
 *
 * 예외가 하나 있다: 설정에서 `screenVeto` 를 켜면 `screenCandidates` 가 실제로
 * 후보를 뺀다. 그 순간 이 계좌는 재현 불가능해지므로 기본값은 꺼짐이고, 켜져
 * 있으면 일지에 그렇게 적힌다.
 *
 * ## 실패는 조용히
 *
 * API 키가 없거나 호출이 실패하면 **아무 일도 없었던 것처럼** 원래 값을 돌려준다.
 * 일지는 AI 없이도 완결이라(규칙이 만든 문장이 이미 있다) 여기서 던지면 멀쩡한
 * 하루가 통째로 안 써진다. 실패는 `error` 로 실어 보내 화면이 조용히 알린다.
 */

const DEFAULT_MODEL = "claude-sonnet-5";

function configured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

async function ask(
  purpose: string,
  system: string,
  user: string,
  maxTokens: number,
): Promise<{ text: string | null; error?: string }> {
  if (!configured()) return { text: null, error: "ANTHROPIC_API_KEY 미설정" };
  const cfg = await getCisConfig();
  const model = cfg.ai.model?.model || process.env.CLAUDE_MODEL?.trim() || DEFAULT_MODEL;
  try {
    const res = await new Anthropic().messages.create({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    });
    await recordApiCall("anthropic", model, "ok", {
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
      feature: "cis",
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    return { text: text || null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await recordApiCall("anthropic", model, "failed", undefined, `cis:${purpose} ${msg}`.slice(0, 80));
    return { text: null, error: msg };
  }
}

/* ------------------------------------------------------------------ 성격 */

/**
 * 시스가 누구인가 — `cisPersona` 한 곳에서 가져온다.
 *
 * ⚠️ **여기서 성격을 다시 쓰지 않는다.** 예전엔 이 파일이 자기 프롬프트를 들고
 * 있었는데, 그러면 규칙이 쓰는 글과 AI 가 쓰는 글의 사람이 갈린다. 성격은 한 곳에.
 *
 * 최근 며칠을 읽어 **지금 상태**까지 넣는다 — 사흘 잃고 난 사람과 사흘 번 사람은
 * 같은 날을 다르게 적는다. 그게 이 일지가 사람의 글로 읽히는 이유다.
 */
async function persona(rules: CisRules): Promise<{ text: string; state: PersonaState }> {
  const days = await listDays(14).catch(() => [] as CisDay[]);
  const state = readState(days);
  return { text: personaPrompt(rules, state), state };
}

/* ------------------------------------------------------------------ ① 일지 */

/**
 * 규칙이 만든 뼈대를 **다듬는다**. 새 사실을 넣지 못하게 원문을 그대로 주고
 * 「이 안에서만」이라고 못 박는다 — 안 그러면 있지도 않은 종목이 등장한다.
 */
export async function polishJournal(
  slot: Slot,
  draft: string,
  rules: CisRules,
): Promise<{ text: string; ai: boolean; error?: string }> {
  const cfg = await getCisConfig();
  if (!cfg.ai.narrate) return { text: draft, ai: false };

  const { text: sys } = await persona(rules);
  const { text, error } = await ask(
    "narrate",
    sys,
    [
      `아래는 ${SLOT_LABEL[slot]} 일지의 뼈대다. 이것을 네 목소리로 다듬어라.`,
      "",
      "⚠️ **여기 없는 사실을 넣지 마라.** 종목·숫자·판단을 새로 만들지 말고,",
      "있는 것을 읽기 좋게 잇고 왜 그렇게 했는지를 한두 문장 덧붙이는 데까지만.",
      "마크다운 제목 구조(##, ###)는 그대로 두어라.",
      "",
      "---",
      draft,
    ].join("\n"),
    1500,
  );
  if (!text) return { text: draft, ai: false, error };
  return { text, ai: true };
}

/* ------------------------------------------------------------------ ② 후보 */

export interface ScreenNote {
  code: string;
  name: string;
  /** "ok" | "caution" | "avoid" */
  verdict: string;
  note: string;
}

/**
 * 후보에 경고를 단다.
 *
 * 규칙은 숫자만 본다 — 거래대금이 크고 신호등이 초록이면 통과다. 그런데 숫자로는
 * 안 잡히는 것이 있다: 급등 후 첫 음봉, 테마가 하루짜리였던 것, 이미 두 배 오른 자리.
 * **그런 것만** 짚게 한다.
 *
 * 기본은 말만 한다. `screenVeto` 가 켜져 있을 때만 `avoid` 가 실제로 후보를 뺀다.
 */
export async function screenCandidates(
  cands: Candidate[],
  rules: CisRules,
): Promise<{ notes: ScreenNote[]; vetoed: string[]; ai: boolean; error?: string }> {
  const cfg = await getCisConfig();
  if (!cfg.ai.screen || cands.length === 0) return { notes: [], vetoed: [], ai: false };

  const rows = cands.map((c) =>
    [
      `${c.name}(${c.code})`,
      `등락 ${c.changeRate.toFixed(1)}%`,
      `대금 ${c.tradeValue.toLocaleString()}억`,
      `업종 ${c.sector}`,
      c.signalLevel ? `신호등 ${c.signalLevel} ${c.signalScore}점` : "신호등 없음",
      `근거: ${c.why}`,
    ].join(" | "),
  );

  const { text: sys } = await persona(rules);
  const { text, error } = await ask(
    "screen",
    sys,
    [
      "아래는 규칙이 뽑은 오늘의 매수 후보다. 각각에 대해 **피할 이유가 있는지만** 보라.",
      "",
      "살 이유는 이미 규칙이 봤다. 네가 볼 것은 숫자로 안 잡히는 것들이다:",
      "급등 뒤 힘이 빠진 자리, 하루짜리 테마, 이미 크게 오른 뒤, 업종 하나에 쏠린 후보.",
      "",
      "각 줄을 이 형식으로만 답하라 (다른 말 금지):",
      "종목코드|ok 또는 caution 또는 avoid|한 문장 이유",
      "",
      "특별히 걸리는 게 없으면 ok 로 두어라. **ok 가 대부분인 것이 정상이다.**",
      "",
      "---",
      ...rows,
    ].join("\n"),
    900,
  );
  if (!text) return { notes: [], vetoed: [], ai: false, error };

  const notes: ScreenNote[] = [];
  for (const line of text.split("\n")) {
    const parts = line.split("|").map((s) => s.trim());
    if (parts.length < 3) continue;
    const c = cands.find((x) => x.code === parts[0] || x.name === parts[0]);
    if (!c) continue;
    const verdict = /avoid/i.test(parts[1]) ? "avoid" : /caution/i.test(parts[1]) ? "caution" : "ok";
    notes.push({ code: c.code, name: c.name, verdict, note: parts.slice(2).join(" | ") });
  }
  const vetoed = cfg.ai.screenVeto
    ? notes.filter((n) => n.verdict === "avoid").map((n) => n.code)
    : [];
  return { notes, vetoed, ai: true };
}

/* ------------------------------------------------------------------ ③ 복기 */

/**
 * 며칠치를 놓고 **어느 규칙이 나빴나**를 짚는다.
 *
 * 하루만 보면 운과 실력이 안 갈린다. 열흘쯤 쌓여야 「손절이 좁아서 털린 게 몇
 * 번인가」 같은 것이 보인다. 사람이 읽고 설정을 고치는 것이 목적이라
 * **고칠 값을 지목하게** 한다 — 「조심하자」 같은 말은 아무것도 안 바꾼다.
 */
export async function weeklyReview(
  days: CisDay[],
  rules: CisRules,
): Promise<{ text: string | null; ai: boolean; error?: string }> {
  const cfg = await getCisConfig();
  if (!cfg.ai.weekly) return { text: null, ai: false };
  const withData = days.filter((d) => d.review);
  if (withData.length < 3) {
    return { text: null, ai: false, error: "복기할 날이 3일보다 적다" };
  }

  const rows = withData.map((d) => {
    const r = d.review!;
    const fills = [d.morning, d.noon, d.evening]
      .flatMap((s) => s?.actions ?? [])
      .map(
        (a) =>
          `${a.side === "buy" ? "매수" : "매도"} ${a.name}` +
          (typeof a.pnl === "number" ? `(${a.pnl >= 0 ? "+" : ""}${a.pnl.toLocaleString()})` : ""),
      )
      .join(", ");
    return [
      d.date,
      `계획 ${r.planned} → 체결 ${r.executed}`,
      `실현 ${r.realized.toLocaleString()}원`,
      `평가액 변화 ${r.equityChange.toLocaleString()}원`,
      r.violations.length ? `위반: ${r.violations.join("; ")}` : "위반 없음",
      fills || "체결 없음",
    ].join(" | ");
  });

  const names = (Object.keys(RULE_LABEL) as (keyof CisRules)[])
    .map((k) => `${k}(${RULE_LABEL[k].label}) = ${rules[k]}${RULE_LABEL[k].unit}`)
    .join(", ");

  return {
    ...(await ask(
      "weekly",
      (await persona(rules)).text,
      [
        `아래는 최근 ${withData.length}일의 성적이다. **어느 규칙이 발목을 잡았는지** 짚어라.`,
        "",
        "지켜야 할 것:",
        "- 날마다 감상을 쓰지 마라. 여러 날에 **반복된 것**만 본다.",
        "- 고칠 값을 **지목하라**. 「손절이 좁다」가 아니라 「stopPct 를 -7 → -9 로」처럼.",
        "- 근거가 3일치보다 적으면 「아직 모르겠다」고 적어라. 그게 정직한 답이다.",
        "- 다섯 줄을 넘기지 마라.",
        "",
        `조절할 수 있는 값: ${names}`,
        "",
        "---",
        ...rows,
      ].join("\n"),
      800,
    )),
    ai: true,
  };
}

/** 화면이 「AI 를 쓸 수 있나」를 물을 때 */
export function cisAiReady(): boolean {
  return configured();
}
