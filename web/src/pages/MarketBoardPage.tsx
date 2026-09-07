/**
 * 전광판 (2026-09-07 밤) — 시황 대시보드와 마켓 브리핑·흐름을 하나로.
 *
 * 벤티지: "시장의 흐름을 한눈에 볼 수 있는 전광판 기능을 하나 만들고 이 둘을 통합. 메뉴가 많은 건 좋은 게
 * 아니니까 결국 핵심을 집어내는 정보들이 중요한 거지. 시장의 흐름, 섹터의 흐름, 시장참여자의 흐름, 유동성,
 * 금리, 환율, 선물지수, 지수…" → 시스 프롬프트 5절대로.
 *
 * 열면 10초 안에 「오늘 시장이 어느 국면인지 · 돈이 어디로 가는지 · 내가 뭘 해야 하는지」.
 *   ① 국면 한 줄 — 있는 판정(체온계·수급·미장 신호등·VIX)만 조합. 신호등 문턱은 건드리지 않는다
 *   ② 타일 12개, 숫자 하나씩, 눌러야 상세
 *   ③ AI 브리핑 3줄
 *   ④ 깊이 보기 — 옛 두 화면이 접힌 채 그대로. 기본 접힘, 마지막에 연 것만 기억
 *
 * 새 조회는 없다. 두 화면이 쓰던 서버 섹션 캐시(useSection)를 그대로 집어 온다.
 */
import { useEffect, useMemo, useState, lazy, Suspense } from "react";
import {
  api,
  signClass,
  type GlobalQuote,
  type IndexCard,
  type MarketFlow,
  type RateRow,
  type UsMajorResult,
  type ViRow,
  type StockRow,
  type ThemeRow,
  type IndexCandle,
} from "../api";
import { useSection } from "../useSection";
import { useMarketLens } from "../components/MarketLensPanel";
import { IndexDetailSheet } from "../components/overview/IndexDetailSheet";
import { YahooChartSheet, type ChartTarget } from "../components/overview/YahooChartSheet";
import { Sparkline } from "../components/overview/Sparkline";

const OverviewPage = lazy(() => import("./OverviewPage").then((m) => ({ default: m.OverviewPage })));
const MarketFlowPage = lazy(() => import("./MarketFlowPage").then((m) => ({ default: m.MarketFlowPage })));

type Level = "green" | "yellow" | "red";
interface Regime {
  level: Level;
  name: string;
  verdict: string;
  reasons: { text: string; good: boolean | null }[];
  score: number;
}

const fmt = (n: number | null | undefined, d = 2): string => (n === null || n === undefined || !Number.isFinite(n) ? "-" : n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }));
const pct = (n: number | null | undefined, d = 2): string => (n === null || n === undefined || !Number.isFinite(n) ? "-" : `${n > 0 ? "+" : ""}${n.toFixed(d)}%`);
const eok = (n: number | null | undefined): string => {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  const a = Math.abs(n);
  const s = n < 0 ? "−" : "+";
  if (a >= 10_000) return `${s}${(a / 10_000).toFixed(1)}조`;
  return `${s}${Math.round(a).toLocaleString()}억`;
};

/** 시장 국면 — 새 규칙이 아니라 있는 판정들의 합. 각 근거는 좋음(true)·나쁨(false)·중립(null) */
function judge(args: {
  kospi: IndexCard | undefined;
  above20: number | null;
  above20Trend: number | null;
  riseNow: number | null;
  flow: MarketFlow | null;
  usLevel: Level | null;
  vix: number | null;
  nightFut: number | null;
}): Regime {
  const r: Regime["reasons"] = [];
  let score = 0;
  const { kospi, above20, above20Trend, riseNow, flow, usLevel, vix, nightFut } = args;
  if (kospi) {
    const good = kospi.changeRate > 0.3 ? true : kospi.changeRate < -0.3 ? false : null;
    r.push({ text: `코스피 ${pct(kospi.changeRate)}`, good });
    if (good === true) score += 1;
    if (good === false) score -= 1;
  }
  if (above20 !== null) {
    const good = above20 >= 55 ? true : above20 < 40 ? false : null;
    r.push({ text: `20일선 위 종목 ${above20.toFixed(0)}%${above20Trend !== null ? (above20Trend > 3 ? " ↑" : above20Trend < -3 ? " ↓" : "") : ""}`, good });
    if (good === true) score += 1;
    if (good === false) score -= 1;
  }
  if (riseNow !== null) {
    const good = riseNow >= 55 ? true : riseNow < 40 ? false : null;
    r.push({ text: `상승 종목 ${riseNow.toFixed(0)}%`, good });
    if (good === true) score += 1;
    if (good === false) score -= 1;
  }
  if (flow) {
    const f = flow.kospi.foreign;
    const i = flow.kospi.institution;
    const good = f > 0 && i > 0 ? true : f < 0 && i < 0 ? false : null;
    r.push({ text: `외인 ${eok(f)} · 기관 ${eok(i)}`, good });
    if (good === true) score += 1;
    if (good === false) score -= 1;
  }
  if (usLevel) {
    const good = usLevel === "green" ? true : usLevel === "red" ? false : null;
    r.push({ text: `미장 ${usLevel === "green" ? "양호" : usLevel === "red" ? "경고" : "주의"}`, good });
    if (good === true) score += 1;
    if (good === false) score -= 1;
  }
  if (vix !== null) {
    const good = vix < 18 ? true : vix >= 30 ? false : null;
    r.push({ text: `VIX ${vix.toFixed(1)}`, good });
    if (vix >= 30) score -= 2;
    else if (vix >= 25) score -= 1;
    else if (vix < 15) score += 1;
  }
  if (nightFut !== null) {
    r.push({ text: `야간선물 ${pct(nightFut)}`, good: nightFut > 0.3 ? true : nightFut < -0.3 ? false : null });
  }
  const rebound = score >= 0 && score < 2 && above20Trend !== null && above20Trend > 3;
  let level: Level;
  let name: string;
  let verdict: string;
  if (vix !== null && vix >= 30) {
    level = "red";
    name = "공포";
    verdict = "새로 사지 말고 손절선만 지킨다";
  } else if (score >= 2) {
    level = "green";
    name = "상승 추세";
    verdict = "사도 되는 날 — 거르고, 추세를 따른다";
  } else if (score <= -2) {
    level = "red";
    name = "하락 추세";
    verdict = "새로 사지 않는다. 출구만 본다";
  } else if (rebound) {
    level = "yellow";
    name = "반등 시도";
    verdict = "소량만 — 확인되면 추종";
  } else {
    level = "yellow";
    name = "횡보";
    verdict = "관망 — 감시만 걸어 둔다";
  }
  return { level, name, verdict, reasons: r, score };
}

export function MarketBoardPage({ onSelectStock }: { onSelectStock: (code: string, name: string) => void }) {
  const indices = useSection<IndexCard[]>("indices", 5_000);
  const flow = useSection<MarketFlow>("flow", 20_000);
  const global = useSection<GlobalQuote[]>("global", 15_000);
  const usMajor = useSection<UsMajorResult>("usMajor", 15_000);
  const rates = useSection<RateRow[]>("rates", 30_000);
  const vi = useSection<ViRow[]>("vi", 20_000);
  const highLow = useSection<{ high: StockRow[]; low: StockRow[] }>("highLow", 120_000);
  const themes = useSection<{ top: ThemeRow[]; bottom: ThemeRow[] }>("themes", 60_000);
  const { lens } = useMarketLens();
  const [brief, setBrief] = useState<{ date: string; label: string; text: string } | null>(null);
  const [briefOpen, setBriefOpen] = useState(false);
  const [turn, setTurn] = useState<Record<string, IndexCandle[]>>({});
  const [mine, setMine] = useState<{ pnl: number; rate: number; value: number; waiting: number; today: number } | null | "none">(null);
  const [indexDetail, setIndexDetail] = useState<string | null>(null);
  const [chart, setChart] = useState<ChartTarget | null>(null);
  const [deep, setDeep] = useState<"" | "overview" | "flow">(() => {
    try {
      return (localStorage.getItem("board.deep") as "" | "overview" | "flow") ?? "";
    } catch {
      return "";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("board.deep", deep);
    } catch {
      /* 저장 못 해도 화면은 된다 */
    }
  }, [deep]);

  useEffect(() => {
    void api.briefingBrief().then((r) => setBrief(r.brief)).catch(() => undefined);
    let alive = true;
    (async () => {
      for (const code of ["001", "101"]) {
        try {
          const r = await api.indexDetail(code, "day");
          if (alive) setTurn((p) => ({ ...p, [code]: r.candles }));
        } catch {
          /* 거래대금 타일만 빈다 */
        }
      }
    })();
    const pullMine = async () => {
      try {
        const s = await api.orderStatus();
        if (!s.enabled || !s.session) {
          if (alive) setMine("none");
          return;
        }
        const v = await api.orderPositions();
        const waiting = v.entries.filter((w) => w.status === "waiting").length + v.positions.reduce((a, q) => a + q.watches.filter((w) => w.status === "waiting").length, 0);
        if (alive) setMine({ pnl: v.pnlTotal, rate: v.pnlRateTotal, value: v.valueTotal, waiting, today: v.todayLoss });
      } catch {
        if (alive) setMine("none");
      }
    };
    void pullMine();
    const t = setInterval(() => void pullMine(), 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const kospi = indices.data?.find((c) => c.code === "001");
  const kosdaq = indices.data?.find((c) => c.code === "101");
  const g = (key: string) => global.data?.find((q) => q.key === key) ?? null;
  const um = (key: string) => usMajor.data?.rows.find((q) => q.key === key) ?? null;
  const vixQ = g("vix") ?? um("vix");
  const night = usMajor.data?.nightFutures ?? g("krNightFut");
  const es = g("esF");
  const nq = g("nqF");
  const usdkrw = g("usdkrw");
  const wti = g("wti") ?? um("wti");
  const gold = g("gold") ?? um("gold");
  const copper = g("copper");
  const tnx = um("tnx");
  const kr3 = rates.data?.find((r) => r.group === "국내" && /3년/.test(r.name)) ?? rates.data?.find((r) => r.group === "국내") ?? null;
  const above20Series = lens?.thermo.series.above20 ?? [];
  const above20 = above20Series.length ? above20Series[above20Series.length - 1] : null;
  const above20Trend = above20Series.length > 5 ? above20Series[above20Series.length - 1] - above20Series[above20Series.length - 6] : null;
  const riseNow = lens?.thermo.riseNow ?? (kospi && kospi.rising + kospi.falling > 0 ? (kospi.rising / (kospi.rising + kospi.falling)) * 100 : null);

  const regime = useMemo(
    () =>
      judge({
        kospi,
        above20,
        above20Trend,
        riseNow,
        flow: flow.data,
        usLevel: usMajor.data?.boardSignal.level ?? null,
        vix: vixQ?.price ?? null,
        nightFut: night?.changeRate ?? null,
      }),
    [kospi, above20, above20Trend, riseNow, flow.data, usMajor.data, vixQ, night],
  );

  const turnOf = (code: string) => {
    const cs = turn[code];
    if (!cs || cs.length < 2) return null;
    const today = cs[cs.length - 1];
    const past = cs.slice(-21, -1);
    const avg = past.length ? past.reduce((a, c) => a + c.tradeValue, 0) / past.length : 0;
    return { today: today.tradeValue, vsAvg: avg > 0 ? (today.tradeValue / avg) * 100 : null };
  };
  const tk = turnOf("001");
  const tq = turnOf("101");
  const turnTotal = tk && tq ? tk.today + tq.today : null;
  const turnVs = tk?.vsAvg !== null && tq?.vsAvg !== null && tk && tq ? (tk.vsAvg! + tq.vsAvg!) / 2 : null;

  const lead = lens?.rotation.lead ?? [];
  const themeTop = (themes.data?.top ?? []).slice(0, 3);
  const themeBottom = (themes.data?.bottom ?? []).slice(0, 3);
  const upSectors = lead.filter((t) => t.changeRate > 0).slice(0, 3);
  const highN = highLow.data?.high.length ?? null;
  const lowN = highLow.data?.low.length ?? null;
  const viN = vi.data?.length ?? null;
  const flowK = flow.data?.kospi ?? null;
  const flowQ = flow.data?.kosdaq ?? null;

  const isNight = (() => {
    const h = new Date(Date.now() + 9 * 3600_000).getUTCHours();
    return h >= 16 || h < 8;
  })();

  const yahoo = (q: GlobalQuote | null, label: string, digits = 2): ChartTarget | null => (q ? { kind: "yahoo", symbol: q.symbol, label, digits, hintRate: q.changeRate ?? undefined } : null);

  const tiles: JSX.Element[] = [];
  const T = ({ k, label, value, sub, cls, spark, onClick, hint }: { k: string; label: string; value: string; sub?: string; cls?: string; spark?: number[]; onClick?: () => void; hint?: string }) => (
    <button key={k} type="button" className={`bd-tile ${cls ?? ""}${onClick ? " click" : ""}`} onClick={onClick} title={hint}>
      <span className="bd-tile-l">{label}</span>
      <b className="bd-tile-v">{value}</b>
      {sub && <small className="bd-tile-s">{sub}</small>}
      {spark && spark.length > 2 && (
        <span className="bd-spark">
          <Sparkline values={spark} up={spark[spark.length - 1] >= spark[0]} />
        </span>
      )}
    </button>
  );

  const idxTile = (c: IndexCard | undefined, label: string, code: string) =>
    T({
      k: code,
      label,
      value: c ? fmt(c.price) : "…",
      sub: c ? `${pct(c.changeRate)} · ↑${c.rising} ↓${c.falling}` : undefined,
      cls: signClass(c?.changeRate ?? 0),
      spark: c?.sparkline,
      onClick: () => setIndexDetail(code),
    });
  const futTile = T({
    k: "fut",
    label: isNight ? "미국 선물 (ES · NQ)" : "야간선물 · ES",
    value: isNight ? `${pct(es?.changeRate)} · ${pct(nq?.changeRate)}` : night ? pct(night.changeRate) : "…",
    sub: isNight ? `야간선물 ${pct(night?.changeRate)}` : `ES ${pct(es?.changeRate)} · NQ ${pct(nq?.changeRate)}`,
    cls: signClass(isNight ? (es?.changeRate ?? 0) : (night?.changeRate ?? 0)),
    onClick: es ? () => setChart(yahoo(es, "US 500 선물")) : undefined,
  });
  const vixTile = T({
    k: "vix",
    label: "VIX",
    value: vixQ ? fmt(vixQ.price ?? null, 1) : "…",
    sub: vixQ ? `${pct(vixQ.changeRate)} · ${(vixQ.price ?? 0) >= 30 ? "공포" : (vixQ.price ?? 0) >= 20 ? "불안" : "안정"}` : undefined,
    cls: vixQ ? ((vixQ.price ?? 0) >= 30 ? "negative" : (vixQ.price ?? 0) < 18 ? "positive" : "") : "",
    onClick: vixQ ? () => setChart({ kind: "yahoo", symbol: "^VIX", label: "VIX", digits: 2 }) : undefined,
  });
  const flowTile = T({
    k: "flow",
    label: "시장참여자 (코스피 오늘)",
    value: flowK ? `외인 ${eok(flowK.foreign)}` : "…",
    sub: flowK ? `기관 ${eok(flowK.institution)} · 개인 ${eok(flowK.individual)}${flowQ ? ` · 코스닥 외인 ${eok(flowQ.foreign)}` : ""}` : undefined,
    cls: flowK ? (flowK.foreign > 0 && flowK.institution > 0 ? "positive" : flowK.foreign < 0 && flowK.institution < 0 ? "negative" : "") : "",
    onClick: () => setDeep("flow"),
    hint: "눌러서 흐름 상세(누적·업종별)",
  });
  const breadthTile = T({
    k: "breadth",
    label: "시장 폭",
    value: kospi ? `↑${kospi.rising + (kosdaq?.rising ?? 0)} : ↓${kospi.falling + (kosdaq?.falling ?? 0)}` : "…",
    sub: `20일선 위 ${above20 !== null ? `${above20.toFixed(0)}%` : "-"} · 신고 ${highN ?? "-"} / 신저 ${lowN ?? "-"} · VI ${viN ?? "-"}`,
    cls: riseNow !== null ? (riseNow >= 55 ? "positive" : riseNow < 40 ? "negative" : "") : "",
    spark: above20Series.slice(-30),
    onClick: () => setDeep("overview"),
  });
  const turnTile = T({
    k: "turn",
    label: "유동성 (거래대금)",
    value: turnTotal !== null ? `${(turnTotal / 10_000).toFixed(1)}조` : "…",
    sub: turnVs !== null ? `20일 평균의 ${turnVs.toFixed(0)}% · 코스피 ${tk ? (tk.today / 10_000).toFixed(1) : "-"}조 / 코스닥 ${tq ? (tq.today / 10_000).toFixed(1) : "-"}조` : undefined,
    cls: turnVs !== null ? (turnVs >= 120 ? "positive" : turnVs < 80 ? "negative" : "") : "",
    onClick: () => setDeep("overview"),
  });
  const rateTile = T({
    k: "rate",
    label: "금리 (美10년 · 韓3년)",
    value: tnx ? `${fmt(tnx.price, 2)}%` : "…",
    sub: `${tnx ? `${(tnx.change ?? 0) > 0 ? "+" : ""}${((tnx.change ?? 0) * 100).toFixed(0)}bp` : "-"} · 韓3년 ${kr3 ? `${fmt(kr3.rate, 2)}% ${(kr3.change ?? 0) > 0 ? "+" : ""}${((kr3.change ?? 0) * 100).toFixed(0)}bp` : "-"}`,
    /* 금리 상승은 주식에 나쁜 쪽 — 파랑 */
    cls: tnx ? ((tnx.change ?? 0) > 0.03 ? "negative" : (tnx.change ?? 0) < -0.03 ? "positive" : "") : "",
    onClick: tnx ? () => setChart({ kind: "yahoo", symbol: "^TNX", label: "미국 10년물", digits: 3 }) : undefined,
  });
  const fxTile = T({
    k: "fx",
    label: "환율 (달러/원)",
    value: usdkrw ? fmt(usdkrw.price, 1) : "…",
    sub: usdkrw ? `${pct(usdkrw.changeRate)} · ${(usdkrw.changeRate ?? 0) < 0 ? "원화 강세(외인에 유리)" : (usdkrw.changeRate ?? 0) > 0 ? "원화 약세" : "보합"}` : undefined,
    /* 환율 하락(원화 강세)이 주식에 좋은 쪽 — 빨강 */
    cls: usdkrw ? ((usdkrw.changeRate ?? 0) < -0.2 ? "positive" : (usdkrw.changeRate ?? 0) > 0.2 ? "negative" : "") : "",
    onClick: usdkrw ? () => setChart(yahoo(usdkrw, "달러/원", 1)) : undefined,
  });
  const sectorTile = T({
    k: "sector",
    label: "섹터 흐름",
    value: themeTop.length ? `${themeTop[0].name.replace(/_/g, " ")} ${pct(themeTop[0].changeRate, 1)}` : upSectors.length ? `${upSectors[0].name} ${pct(upSectors[0].changeRate, 1)}` : "…",
    sub: `${themeTop.slice(1, 3).map((t) => `${t.name.replace(/_/g, " ")} ${pct(t.changeRate, 1)}`).join(" · ")}${themeBottom.length ? ` · ↓ ${themeBottom[0].name.replace(/_/g, " ")} ${pct(themeBottom[0].changeRate, 1)}` : ""}`,
    cls: themeTop.length ? "positive" : "",
    onClick: () => setDeep("flow"),
    hint: "눌러서 테마 로테이션·주도주",
  });
  const cmdTile = T({
    k: "cmd",
    label: "원자재 (WTI · 금 · 구리)",
    value: wti ? `$${fmt(wti.price, 1)}` : "…",
    sub: `WTI ${pct(wti?.changeRate)} · 금 ${pct(gold?.changeRate)} · 구리 ${pct(copper?.changeRate)}`,
    cls: "",
    onClick: wti ? () => setChart({ kind: "yahoo", symbol: "CL=F", label: "WTI", digits: 2 }) : undefined,
  });
  const mineTile = T({
    k: "mine",
    label: "내 것",
    value: mine === null ? "…" : mine === "none" ? "주문 세션 없음" : `${mine.pnl >= 0 ? "+" : ""}${Math.round(mine.pnl).toLocaleString()}원`,
    sub: mine && mine !== "none" ? `${pct(mine.rate)} · 평가 ${Math.round(mine.value / 10_000).toLocaleString()}만 · 감시 ${mine.waiting}건${mine.today ? ` · 오늘 실현 ${Math.round(mine.today).toLocaleString()}` : ""}` : "주문 메뉴에서 세션을 열면 보인다",
    cls: mine && mine !== "none" ? signClass(mine.pnl) : "",
    onClick: () => {
      window.location.hash = "#/order";
    },
  });

  const kospiTile = idxTile(kospi, "코스피", "001");
  const kosdaqTile = idxTile(kosdaq, "코스닥", "101");
  /* 밤엔 미국 선물·VIX·환율이 앞으로 */
  if (isNight) tiles.push(futTile, vixTile, fxTile, rateTile, kospiTile, kosdaqTile, flowTile, breadthTile, turnTile, sectorTile, cmdTile, mineTile);
  else tiles.push(kospiTile, kosdaqTile, futTile, vixTile, flowTile, breadthTile, turnTile, rateTile, fxTile, sectorTile, cmdTile, mineTile);

  /* 브리핑은 문장 단위로 — 한 문단으로 오면 「다.」에서 끊어 3줄만 보인다 */
  const briefLines = (brief?.text ?? "")
    .split(/\n+|(?<=다\.)\s+|(?<=요\.)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  return (
    <div className="page board">
      {/* ① 국면 */}
      <div className={`bd-regime ${regime.level}`}>
        <div className="bd-regime-main">
          <span className="bd-regime-dot" />
          <b>{regime.name}</b>
          <span className="bd-regime-verdict">{regime.verdict}</span>
        </div>
        <div className="bd-regime-why">
          {regime.reasons.map((r, i) => (
            <span key={i} className={r.good === true ? "good" : r.good === false ? "bad" : ""}>
              {r.text}
            </span>
          ))}
          {regime.reasons.length === 0 && <span>판정 근거를 받는 중…</span>}
        </div>
      </div>

      {/* ② 타일 */}
      <div className="bd-tiles">{tiles}</div>

      {/* ③ AI 브리핑 3줄 */}
      {brief && briefLines.length > 0 && (
        <div className="bd-brief">
          <div className="bd-brief-h">
            <b>브리핑</b> <small>{brief.label} · {brief.date}</small>
            <button type="button" className="ord-mk" onClick={() => setBriefOpen((v) => !v)}>
              {briefOpen ? "접기" : "전체"}
            </button>
          </div>
          <ul>
            {(briefOpen ? briefLines : briefLines.slice(0, 3)).map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </div>
      )}

      {/* ④ 깊이 보기 — 옛 두 화면, 접힌 채로 */}
      <div className="bd-deep-tabs">
        <button type="button" className={deep === "flow" ? "on" : ""} onClick={() => setDeep(deep === "flow" ? "" : "flow")}>
          🌊 흐름 · 맥박 · 로테이션 · 주도주 · 종가배팅 {deep === "flow" ? "▲" : "▼"}
        </button>
        <button type="button" className={deep === "overview" ? "on" : ""} onClick={() => setDeep(deep === "overview" ? "" : "overview")}>
          📊 시황 상세 (지수·수급·순위·테마·VI) {deep === "overview" ? "▲" : "▼"}
        </button>
      </div>
      {deep && (
        <div className="bd-deep">
          <Suspense fallback={<div className="page-note">불러오는 중…</div>}>
            {deep === "flow" ? <MarketFlowPage onSelectStock={onSelectStock} /> : <OverviewPage onSelectStock={onSelectStock} />}
          </Suspense>
        </div>
      )}

      {indexDetail && <IndexDetailSheet code={indexDetail} onClose={() => setIndexDetail(null)} />}
      {chart && <YahooChartSheet target={chart} onClose={() => setChart(null)} />}
    </div>
  );
}
