/**
 * 표식 근거 — 「이 종목은 왜 🌟⚡🌈·신호등·★·🔥⏳ 가 붙었나」 (2026-09-08).
 *
 * 벤티지: "번개·신호등·무지개 여러 마크가 달리잖아. 마우스 올렸을 때 왜 그랬는지 알려 주고, 모바일에선
 * 종목 상세 머리에 마크랑 간단한 설명."
 *
 * 여태 툴팁은 종목과 상관없는 일반 설명이었다("교차 — 슈퍼신호등이면서 주도주 태그도 달린 종목").
 * 근거는 원장에 다 있다 — 어느 목록 몇 개의 교집합인지, 며칠째인지, 주도주 태그가 뭔지, 편입 뒤 얼마나 갔는지.
 * 여기서 표식마다 **사실 한 줄**을 만든다. 「좋다·사라」는 안 쓴다.
 *
 * 조회: 원장·관심종목은 파일. 신호등만 `evaluateSignal`(15분 캐시) — 상세를 열면 어차피 부르는 것.
 */
import type { KiwoomClient } from "./kiwoomClient.js";
import { superEntryOf } from "./superSignal.js";
import { AUTO_GROUPS, CROSS_GROUP, listWatchlist } from "./watchlist.js";
import { evaluateSignal } from "./signalLight.js";
import { universeLabel } from "./signalScreen.js";
import { flowTwinOf } from "./dailyStore.js";

export interface MarkWhy {
  key: "super" | "cross" | "rainbow" | "signal" | "twin" | "hot" | "late" | "watch" | "exited";
  icon: string;
  label: string;
  /** 한 줄 근거 — 툴팁·칩 펼침에 그대로 */
  why: string;
  /** 신호등 색 (signal 만) */
  level?: "green" | "yellow" | "red" | "unknown";
}

const pct = (v: number | null | undefined) => (v === null || v === undefined ? null : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`);

export async function markWhy(client: KiwoomClient, code: string): Promise<{ code: string; marks: MarkWhy[]; at: string }> {
  const marks: MarkWhy[] = [];
  const { entry: e, rainbowDays } = await superEntryOf(code).catch(() => ({ entry: null, rainbowDays: 2 }));
  const watch = await listWatchlist().catch(() => []);
  const w = watch.find((x) => x.code === code);
  const active = !!e && e.active !== false;

  if (e && active) {
    const lists = e.lists ?? [];
    const since = pct(e.excess?.d5 ?? null);
    marks.push({
      key: "super",
      icon: "🌟",
      label: "슈퍼신호등",
      why:
        `${lists.length}개 목록 교집합(${lists.map(universeLabel).join("·") || "목록 이름 없음"}) · 편입 때 신호등 ${e.score}점 · ${e.addedDate} 편입(${e.addedPrice.toLocaleString()}원)` +
        (e.returns?.d5 !== null && e.returns?.d5 !== undefined ? ` · 편입 5일 뒤 ${pct(e.returns.d5)}` : "") +
        (since ? ` (시장 대비 ${since})` : ""),
    });
  }
  const inCross = !!w && w.groups.includes(CROSS_GROUP);
  if (inCross || (e && active && e.leader?.was)) {
    const tags = e?.leader?.tags ?? [];
    marks.push({
      key: "cross",
      icon: "⚡",
      label: "교차",
      why:
        tags.length > 0
          ? `주도주 탐색 태그 ${tags.join("·")}${e?.leader?.sector ? ` (섹터 ${e.leader.sector})` : ""} ∩ 슈퍼신호등 — 주도주에서 빠지면 그날부터 안 붙는다`
          : "관심 그룹 「슈퍼신호등+교차」에 있다 — 슈퍼신호등이면서 그날 주도주 탐색에도 걸렸던 종목",
    });
  }
  if (e && active && e.seenCount >= rainbowDays) {
    marks.push({
      key: "rainbow",
      icon: "🌈",
      label: "무지개",
      why: `${e.seenCount}일째 계속 교집합에 걸린다(문턱 ${rainbowDays}일, 마지막 ${e.lastSeenDate}) — 지속성이 성적을 가른 축`,
    });
  }
  if (e && !active) {
    const last = e.exits?.[e.exits.length - 1];
    marks.push({
      key: "exited",
      icon: "⤴",
      label: "이탈",
      why: `${last?.date ?? "?"} 슈퍼신호등에서 이탈${last?.note ? ` — ${last.note}` : ""}. 지금은 표식 없음` + (e.afterExit?.d5 !== null && e.afterExit?.d5 !== undefined ? ` · 이탈 5일 뒤 ${pct(e.afterExit.d5)}` : ""),
    });
  }

  /* 신호등 — 색·점수·이유 상위 셋(통과한 것과 걸린 것) */
  try {
    const sig = await evaluateSignal(client, code);
    /* 값 문장에 라벨이 이미 들어 있는 경우가 많다 — 짧게: 라벨 + 값 앞 38자 */
    const brief = (c: { label: string; value: string }) => {
      const v = c.value.replace(/\s+/g, " ").trim();
      const cut = v.length > 38 ? `${v.slice(0, 38)}…` : v;
      return v.startsWith(c.label) ? cut : `${c.label}: ${cut}`;
    };
    const passed = sig.checks.filter((c) => c.pass === true).slice(0, 3).map(brief);
    const failed = sig.checks.filter((c) => c.pass === false).slice(0, 2).map(brief);
    const lv = sig.level === "green" ? "초록" : sig.level === "yellow" ? "노랑" : sig.level === "red" ? "빨강" : "판단 보류";
    marks.push({
      key: "signal",
      icon: "●",
      label: `신호등 ${lv}`,
      level: sig.level,
      why:
        `${sig.score}점` +
        (sig.vetoedBy && sig.vetoedBy.length > 0 ? ` · 탈락: ${sig.vetoedBy.join("·")}` : "") +
        (passed.length > 0 ? ` · 통과: ${passed.join(", ")}` : "") +
        (failed.length > 0 ? ` · 걸림: ${failed.join(", ")}` : "") +
        (sig.tooThin ? " · 거래대금이 얇아 초록을 막음" : "") +
        (sig.tooSmall ? " · 시총이 작아 초록을 막음" : ""),
    });
    const hot = sig.alerts?.hot ?? [];
    const late = sig.alerts?.late ?? [];
    if (hot.length > 0) marks.push({ key: "hot", icon: "🔥", label: "쏠림", why: `${hot.map((a) => a.label).join(" · ")} — 몰린 자리는 고점이었던 계절(신조 ①체)` });
    if (late.length > 0) marks.push({ key: "late", icon: "⏳", label: "늦음", why: `${late.map((a) => a.label).join(" · ")} — 이미 많이 온 자리` });
  } catch {
    /* 신호등을 못 읽으면 그 칸만 빈다 */
  }

  /*
   * **쌍끌이** (2026-09-11 — 벤티지: "마크도 종목 무지개 마크 옆에 넣어주면 좋지 않을까?").
   *
   * 외국인과 주포(투신+연기금+사모)가 **5·10·20일 여섯 칸 전부** 순매수. 시세분석 표의 그
   * 칸(`isTwin`)과 같은 정의다 — 화면마다 다른 뜻이면 표식이 아니다.
   *
   * ⚠️ **점수는 안 건드린다.** 신호등의 문턱·무게는 동결이고, 이게 값을 하는지는 아직 실측
   * 중이다. 지금은 「보이게만」 한다 — 표식과 채점은 다른 얘기다.
   *
   * 하나라도 모르면(원장이 얕음) 아니다. 「모른다」를 「샀다」로 치지 않는다.
   */
  try {
    const { fgn3, twin, rows } = await flowTwinOf(code);
    const eok = (v: number | null) => (v === null ? "?" : `${v > 0 ? "+" : ""}${v.toLocaleString("ko-KR")}억`);
    if (fgn3) {
      /*
       * (2026-09-11 실측) 표본 29,570관측에서 **초록 ∩ 외국인 세 칸**이 20일 +3.2%p/59% 로
       * 가장 크고 넓었다(하루 17.3개). 쌍끌이(여섯 칸)는 +3.1 인데 하루 6.2개뿐이고 5일은 음수다.
       * 그래서 **외국인 세 칸이 본체**이고 쌍끌이는 그중 더 좁은 갈래로 적는다.
       * 빨강 안에서는 −0.1 이라 단독 신호가 아니다 — 그 말도 근거에 적는다.
       */
      marks.push({
        key: "twin",
        icon: "🧲",
        label: twin ? "쌍끌이" : "외인 3칸",
        why:
          (twin
            ? "외국인·주포가 5·10·20일 여섯 칸 전부 순매수 — "
            : "외국인이 5·10·20일 세 칸 전부 순매수 — ") +
          rows.map((r) => `${r.d}일 외인 ${eok(r.fgn)}${twin ? `·주포 ${eok(r.smart)}` : ""}`).join(" · ") +
          (twin ? " (주포 = 투신+연기금+사모)" : "") +
          " · 실측(29,570관측): 신호등 초록과 겹칠 때만 값이 있다(20일 +3.2%p·승률 59%). 빨강이면 −0.1 로 힘이 없다. 점수에는 안 들어간다 — 표식만",
      });
    }
  } catch {
    /* 원장을 못 읽으면 이 칸만 빈다 */
  }

  if (w) {
    const mine = w.groups.filter((g) => !AUTO_GROUPS.includes(g));
    marks.push({
      key: "watch",
      icon: "★",
      label: "관심종목",
      why:
        (mine.length > 0 ? `네가 ${w.addedAt.slice(0, 10)}에 찍음(${mine.join("·")})` : `자동 그룹에만 있음(${w.groups.join("·")})`) +
        (w.addedPrice > 0 ? ` · 편입가 ${w.addedPrice.toLocaleString()}원` : "") +
        (w.memo ? ` · 메모: ${w.memo}` : ""),
    });
  }
  return { code, marks, at: new Date().toISOString() };
}
