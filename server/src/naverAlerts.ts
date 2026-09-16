import { once } from "./dayMark.js";
import { marketCalendar, researchBoard } from "./naverMarket.js";
import { pushNotice, stockLink } from "./notifyCenter.js";
import { sendTelegram, stockNameHtml } from "./telegram.js";
import { getActiveSuper } from "./superSignal.js";
import { listWatchlist } from "./watchlist.js";

/**
 * **네이버 자료로 만드는 알림 둘** (2026-09-16 — 벤티지가 업그레이드 방향에서 고름).
 *
 *   ① 경제지표 — 영향력 「매우 높음」 지표를 **발표 30분 전**에. 그 시각에 주문을 걸어 두지 말라는 뜻.
 *   ② 목표주가 — 리서치의 목표주가 변경이 **내 관심종목·슈퍼신호등**과 겹치면 그 자리에서.
 *
 * 둘 다 **이미 받고 있는 자료**다(캘린더 30분·리서치 15분 캐시) — 조회가 늘지 않는다. 1분 틱에서 부른다.
 * 하루 한 번 표시는 `dayMark.once` 로 파일에 — 재시작해도 또 안 운다. 네이버를 못 받으면 조용히 빠진다
 * (「못 받음」은 「없음」이 아니지만, 알림이 헛울리는 것보다 낫다).
 */

const LEAD_MIN = 30;

function kstNow(): { day: string; minute: number } {
  const k = new Date(Date.now() + 9 * 3600_000);
  return { day: k.toISOString().slice(0, 10), minute: k.getUTCHours() * 60 + k.getUTCMinutes() };
}

export async function runNaverAlerts(): Promise<{ econ: number; goal: number }> {
  const out = { econ: 0, goal: 0 };
  const { day, minute } = kstNow();

  /* ── ① 경제지표 30분 전 ── */
  try {
    const cal = await marketCalendar(day, day);
    for (const e of cal.events) {
      if (e.category !== "economicIndicators" || !e.time || !/매우 높음/.test(e.impact ?? "")) continue;
      const [hh, mm] = e.time.split(":").map(Number);
      if (!Number.isFinite(hh) || !Number.isFinite(mm)) continue;
      const at = hh * 60 + mm;
      /* 30분 전부터 25분 전 사이 한 번 — 1분 틱이라 창이 5분이면 놓치지 않는다 */
      if (minute < at - LEAD_MIN || minute > at - LEAD_MIN + 5) continue;
      if (!(await once(`econ:${e.title}:${e.time}:${day}`))) continue;
      const nat = e.nation === "USA" ? "미국" : e.nation === "KOR" ? "한국" : (e.nation ?? "");
      const info = e.info
        .filter((i) => i.value && i.value !== "-")
        .map((i) => `${i.label} ${i.value}`)
        .join(" · ");
      const title = `${e.time} ${nat} ${e.title} — 30분 뒤 발표`;
      await sendTelegram(`📊 <b>${title}</b>\n영향력 ${e.impact}${info ? ` · ${info}` : ""}\n발표 직후 지수·환율이 먼저 움직입니다 — 그 시각에 주문을 걸어 두지 않는 편이 낫습니다.`, "signal").catch(() => undefined);
      await pushNotice({
        source: "econ",
        kind: "market",
        level: "warn",
        title,
        body: `영향력 ${e.impact}${info ? ` · ${info}` : ""}`,
        link: "#/calendar",
        dedupeKey: `econ:${e.title}:${day}`,
        dedupeHours: 6,
      }).catch(() => undefined);
      out.econ += 1;
    }
  } catch {
    /* 캘린더를 못 받으면 이번 분은 넘긴다 */
  }

  /* ── ② 목표주가 변경 ∩ 내 종목 ── */
  try {
    const board = await researchBoard();
    const changes = [...board.goalUp.map((g) => ({ ...g, dir: "up" as const })), ...board.goalDown.map((g) => ({ ...g, dir: "down" as const }))];
    if (changes.length > 0) {
      const [watch, sup] = await Promise.all([listWatchlist().catch(() => []), getActiveSuper().catch(() => [])]);
      const mine = new Map<string, string>();
      for (const w of watch) mine.set(w.code, "관심종목");
      for (const s of sup) mine.set(s.code, mine.has(s.code) ? "관심·슈퍼" : "슈퍼신호등");
      for (const g of changes) {
        const why = mine.get(g.code);
        if (!why) continue;
        const key = `goal:${g.code}:${g.broker}:${g.date.slice(0, 10)}`;
        if (!(await once(key))) continue;
        const arrow = g.dir === "up" ? "▲" : "▼";
        const rate = g.diffRate === null ? "" : ` (${g.diffRate > 0 ? "+" : ""}${g.diffRate.toFixed(1)}%)`;
        const px = g.goal === null ? "" : ` → ${g.goal.toLocaleString("ko-KR")}`;
        const title = `${g.name} 목표주가 ${arrow}${px}${rate} · ${g.broker}`;
        await sendTelegram(`📑 <b>${stockNameHtml(g.code, g.name)}</b> 목표주가 ${arrow}${g.prevGoal !== null ? ` ${g.prevGoal.toLocaleString("ko-KR")}` : ""}${px}${rate}\n${g.broker} · ${g.title}\n(${why} — 애널리스트 의견이지 매매 근거가 아닙니다. 왜 고쳤는지가 본론)`, "signal").catch(() => undefined);
        await pushNotice({
          source: "research",
          kind: "stock",
          level: "info",
          title,
          body: `${g.title} — ${why}`,
          code: g.code,
          name: g.name,
          link: stockLink(g.code, g.name),
          dedupeKey: key,
          dedupeHours: 24,
        }).catch(() => undefined);
        out.goal += 1;
      }
    }
  } catch {
    /* 리서치를 못 받으면 이번 분은 넘긴다 */
  }
  return out;
}
