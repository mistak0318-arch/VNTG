import { hasOnce, once } from "./dayMark.js";
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
      /*
       * **보낸 뒤에 찍는다** (2026-09-21 「조용한 건너뜀」 훑기 🟠). `once` 는 읽으면서 적는 함수라
       * 보내기 전에 부르면 발송이 실패해도 열쇠가 소모돼 그 경고는 영영 안 갔다. 먼저 `hasOnce` 로 보고,
       * 텔레그램이 닿은 뒤에 찍는다 — 실패하면 창(5분) 안의 다음 분이 다시 해 본다.
       */
      const econKey = `econ:${e.title}:${e.time}:${day}`;
      if (await hasOnce(econKey)) continue;
      const nat = e.nation === "USA" ? "미국" : e.nation === "KOR" ? "한국" : (e.nation ?? "");
      const info = e.info
        .filter((i) => i.value && i.value !== "-")
        .map((i) => `${i.label} ${i.value}`)
        .join(" · ");
      const title = `${e.time} ${nat} ${e.title} — 30분 뒤 발표`;
      const rEcon = await sendTelegram(`📊 <b>${title}</b>\n영향력 ${e.impact}${info ? ` · ${info}` : ""}\n발표 직후 지수·환율이 먼저 움직입니다 — 그 시각에 주문을 걸어 두지 않는 편이 낫습니다.`, "signal").catch(() => ({ ok: false, error: "던짐" }));
      if (!rEcon.ok) {
        console.warn(`[naverAlerts] 지표 경고 발송 실패 — 열쇠 안 찍는다. 다음 분에 다시 (${title} · ${rEcon.error ?? ""})`);
        continue;
      }
      await once(econKey);
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
  } catch (e) {
    /*
     * 캘린더를 못 받으면 이번 분은 넘긴다. **까닭은 남긴다** (2026-09-21) — 예전엔 `catch {}` 라,
     * 네이버가 하루 종일 막혀도 「오늘은 지표가 없었나 보다」와 구분이 안 됐다.
     */
    console.warn("[naverAlerts] 경제지표 캘린더 못 받음 —", e instanceof Error ? e.message : e);
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
        /*
         * 열쇠는 **`YYYY-MM-DD` 로 끝나야 한다** (2026-09-21). 네이버 `writeDate` 는 `20260921` 처럼
         * 대시가 없어서 `dayMark` 의 「날짜로 끝나면 사흘 보관」 규칙에 안 걸렸다. 맞춰 준다.
         */
        const gd = g.date.replace(/[.\/]/g, "-");
        const gDay = /^\d{4}-\d{2}-\d{2}/.test(gd)
          ? gd.slice(0, 10)
          : /^\d{8}$/.test(g.date)
            ? `${g.date.slice(0, 4)}-${g.date.slice(4, 6)}-${g.date.slice(6, 8)}`
            : day;
        const key = `goal:${g.code}:${g.broker}:${gDay}`;
        /* 위 ①과 같은 이유 — 보낸 뒤에 찍는다 (2026-09-21) */
        if (await hasOnce(key)) continue;
        const arrow = g.dir === "up" ? "▲" : "▼";
        const rate = g.diffRate === null ? "" : ` (${g.diffRate > 0 ? "+" : ""}${g.diffRate.toFixed(1)}%)`;
        const px = g.goal === null ? "" : ` → ${g.goal.toLocaleString("ko-KR")}`;
        const title = `${g.name} 목표주가 ${arrow}${px}${rate} · ${g.broker}`;
        const rGoal = await sendTelegram(`📑 <b>${stockNameHtml(g.code, g.name)}</b> 목표주가 ${arrow}${g.prevGoal !== null ? ` ${g.prevGoal.toLocaleString("ko-KR")}` : ""}${px}${rate}\n${g.broker} · ${g.title}\n(${why} — 애널리스트 의견이지 매매 근거가 아닙니다. 왜 고쳤는지가 본론)`, "signal").catch(() => ({ ok: false, error: "던짐" }));
        if (!rGoal.ok) {
          console.warn(`[naverAlerts] 목표주가 발송 실패 — 열쇠 안 찍는다. 다음 분에 다시 (${g.name} · ${rGoal.error ?? ""})`);
          continue;
        }
        await once(key);
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
  } catch (e) {
    /* 위와 같은 이유 — 조용히 죽지 않게 까닭을 남긴다 (2026-09-21) */
    console.warn("[naverAlerts] 리서치 보드 못 받음 —", e instanceof Error ? e.message : e);
  }
  return out;
}
