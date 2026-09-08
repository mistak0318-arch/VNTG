/**
 * 전광판 (2026-09-08 다시) — **지금 시장에 무슨 일이 있나**를 한 장에.
 *
 * 벤티지 스케치(09-08 10:23, 갤럭시 노트):
 *
 *   ┌ 코스피 · 코스닥 지수정보 ─────────────────────────────┐
 *   │ 시장 이슈 (뉴스·텔레그램 키워드 버블) │ 오늘의 주도주   │
 *   │ 거래대금 상위                        │ 관심종목 현황   │
 *   │ 주요 뉴스                                              │
 *   └────────────────────────────────────────────────────────┘
 *
 * "지금 우리 전광판은 이렇게 설계하려고 만들어달라고 한 게 아니야. 실시간 시장의 정보에 집중해서
 *  보여주는 거거든. 현재 시장이 이런 분위기고, 어떻게 흘러가고 있고, 내가 관심 있는 것들은 이렇고,
 *  주요 뉴스는 이렇고, 텔레그램 뉴스의 키워드는 이렇게 해가지고 얘네가 뜨는 거구나."
 *
 * 그래서 첫 판(09-07, 타일 12개 + 국면 + 브리핑)을 접었다. 금리·원자재·섹터 타일은 시황 대시보드에 그대로
 * 있다. 여기 남긴 건 **지수 띠 하나**와 스케치의 다섯 칸. 국면 판정(`judge`)은 띠 맨 앞의 칸 하나로 줄였다.
 *
 * 조회 — 지수·수급은 섹션 캐시. 화제(topic-pulse)·거래대금 상위(ka10030 한 콜)·관심종목 시세·주요뉴스는
 * 각자 제 주기로. 주도주 스캔은 4콜쯤이라 5분에 한 번.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  api,
  normalizeStockCode,
  signClass,
  type GlobalQuote,
  type IndexCard,
  type LeaderScan,
  type MarketFlow,
  type MarketSignal,
  type NaverNewsItem,
  type TopicPulse,
  type UsMajorResult,
  type WatchItem,
} from "../api";
import { useSection } from "../useSection";
import { useMarketLens } from "../components/MarketLensPanel";
import { IndexDetailSheet } from "../components/overview/IndexDetailSheet";
import { YahooChartSheet, type ChartTarget } from "../components/overview/YahooChartSheet";
import { Sparkline } from "../components/overview/Sparkline";

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

/**
 * 시장 국면 — **시장 신호등이 기준**이다 (2026-09-07 밤). 벤티지: "시황 대시보드의 시장 신호등이랑 전광판이랑 다르네."
 * 두 화면이 서로 다른 셈을 하면 어느 쪽도 못 믿는다. 신호등(7항목·가중)이 국내 판정이고, 여기선 그 위에
 * 미장 신호등·VIX·야간선물만 얹는다. 신호등이 없을 때만 예전 셈(체온계·수급)으로 메운다.
 */
function judge(args: {
  sig: MarketSignal | null;
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
  const { sig, kospi, above20, above20Trend, riseNow, flow, usLevel, vix, nightFut } = args;
  if (sig && sig.level !== "unknown") {
    /* 신호등 점수(0~100)를 −3~+3 로 — 70 이상 +2, 85 이상 +3, 40 미만 −2, 25 미만 −3 */
    const s = sig.score;
    const base = s >= 85 ? 3 : s >= 70 ? 2 : s >= 55 ? 1 : s >= 40 ? 0 : s >= 25 ? -2 : -3;
    score += base;
    r.push({ text: `신호등 ${sig.level === "green" ? "초록" : sig.level === "yellow" ? "노랑" : "빨강"} ${s}점`, good: sig.level === "green" ? true : sig.level === "red" ? false : null });
    for (const c of sig.checks) {
      const short = c.value.length > 22 ? `${c.value.slice(0, 22)}…` : c.value;
      r.push({ text: `${c.label} ${short}`, good: c.pass === true ? true : c.pass === false ? false : null });
    }
    if (usLevel) {
      const good = usLevel === "green" ? true : usLevel === "red" ? false : null;
      r.push({ text: `미장 ${usLevel === "green" ? "양호" : usLevel === "red" ? "경고" : "주의"}`, good });
      if (good === true) score += 1;
      if (good === false) score -= 1;
    }
    if (vix !== null) {
      r.push({ text: `VIX ${vix.toFixed(1)}`, good: vix < 18 ? true : vix >= 30 ? false : null });
      if (vix >= 30) score -= 2;
      else if (vix >= 25) score -= 1;
    }
    if (nightFut !== null) r.push({ text: `야간선물 ${pct(nightFut)}`, good: nightFut > 0.3 ? true : nightFut < -0.3 ? false : null });
    /* 국면 이름·행동은 서버 판정 그대로 — 미장·VIX 는 색만 한 단계 내린다(공포는 여기서도) */
    const rg = sig.regime;
    let level: Level = sig.level === "green" ? "green" : sig.level === "red" ? "red" : "yellow";
    let name = rg?.name ?? (sig.level === "green" ? "상승 추세" : sig.level === "red" ? "하락 추세" : "횡보");
    let verdict = rg?.action ?? "";
    if (vix !== null && vix >= 30) {
      level = "red";
      name = "공포";
      verdict = "새로 사지 말고 손절선만 지킨다";
    } else if (rg?.key === "up" && (usLevel === "red" || (vix !== null && vix >= 25))) {
      level = "yellow";
      verdict = `${verdict} · 단, 미장이 흔들린다`;
    } else if (rg?.key === "down" || rg?.key === "fear") {
      level = "red";
    } else if (rg?.key !== "up") {
      level = "yellow";
    }
    return { level, name, verdict, reasons: r, score };
  }
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

/* ------------------------------------------------------------------ */
/* 폴링 하나 — 칸마다 제 주기로 다시 묻는다. 실패하면 지난 값을 둔다        */
/* ------------------------------------------------------------------ */
function usePoll<T>(fn: () => Promise<T>, ms: number): { data: T | null; error: string | null; at: number } {
  const [st, setSt] = useState<{ data: T | null; error: string | null; at: number }>({ data: null, error: null, at: 0 });
  useEffect(() => {
    let alive = true;
    const pull = async () => {
      try {
        const d = await fn();
        if (alive) setSt({ data: d, error: null, at: Date.now() });
      } catch (e) {
        if (alive) setSt((p) => ({ ...p, error: e instanceof Error ? e.message : "실패" }));
      }
    };
    void pull();
    const t = setInterval(() => void pull(), ms);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return st;
}

/* ------------------------------------------------------------------ */
/* 시장 이슈 — 키워드 버블                                               */
/* ------------------------------------------------------------------ */
interface Bubble {
  term: string;
  r: number;
  x: number;
  y: number;
  where: "both" | "channel" | "news";
  fresh: boolean;
  n: number;
  codes: string[];
}

/**
 * 원 채우기 — 큰 것부터 가운데에, 다음 것은 **이미 놓인 원 둘레를 돌며** 겹치지 않는 자리 중
 * 가운데에 제일 가까운 곳에. d3 없이 이 정도면 열댓 개는 보기 좋게 모인다.
 */
function packBubbles(items: TopicPulse["items"], w: number, h: number): Bubble[] {
  const top = items.slice(0, 14);
  if (top.length === 0) return [];
  const max = Math.max(...top.map((i) => i.score), 1);
  const rMin = Math.min(w, h) * 0.085;
  const rMax = Math.min(w, h) * 0.2;
  const pad = 3;
  const placed: Bubble[] = [];
  const cx = w / 2;
  const cy = h / 2;
  for (const it of top) {
    const r = rMin + (rMax - rMin) * Math.sqrt(it.score / max);
    const b: Bubble = { term: it.term, r, x: cx, y: cy, where: it.where, fresh: it.fresh, n: it.buzzCount + it.newsCount, codes: it.codes };
    if (placed.length === 0) {
      placed.push(b);
      continue;
    }
    let best: { x: number; y: number; d: number } | null = null;
    for (const p of placed) {
      const dist = p.r + r + pad;
      for (let k = 0; k < 36; k++) {
        const a = (k / 36) * Math.PI * 2;
        const x = p.x + Math.cos(a) * dist;
        const y = p.y + Math.sin(a) * dist;
        if (x - r < 0 || x + r > w || y - r < 0 || y + r > h) continue;
        const hit = placed.some((q) => Math.hypot(q.x - x, q.y - y) < q.r + r + pad - 0.5);
        if (hit) continue;
        const d = Math.hypot(x - cx, y - cy);
        if (!best || d < best.d) best = { x, y, d };
      }
    }
    if (!best) continue; // 자리가 없으면 이 낱말은 뺀다 — 열네 개가 다 들어갈 필요는 없다
    b.x = best.x;
    b.y = best.y;
    placed.push(b);
  }
  return placed;
}

function IssueBubbles({ pulse, onSelectStock }: { pulse: TopicPulse | null; onSelectStock: (code: string, name: string) => void }) {
  const W = 480;
  const H = 300;
  const bubbles = useMemo(() => (pulse ? packBubbles(pulse.items, W, H) : []), [pulse]);
  if (!pulse) return <div className="bd-empty">화제를 모으는 중…</div>;
  if (bubbles.length === 0) return <div className="bd-empty">{pulse.headline || "아직 도드라진 낱말이 없습니다"}</div>;
  return (
    <svg className="bd-bubbles" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="시장 이슈 키워드">
      {bubbles.map((b) => {
        const fs = Math.max(10, Math.min(20, b.r * 0.42 - (b.term.length > 4 ? (b.term.length - 4) * 1.2 : 0)));
        const go = () => {
          if (b.codes.length > 0) onSelectStock(b.codes[0], b.term);
          else window.location.hash = "#/news";
        };
        return (
          <g key={b.term} className={`bd-bub ${b.where}${b.fresh ? " fresh" : ""}`} transform={`translate(${b.x.toFixed(1)} ${b.y.toFixed(1)})`} onClick={go} style={{ cursor: "pointer" }}>
            <title>
              {b.term} · {b.where === "both" ? "뉴스·텔레그램 둘 다" : b.where === "channel" ? "텔레그램" : "뉴스"} {b.n}건{b.fresh ? " · 처음 보는 말" : ""}
              {b.codes.length ? ` · 종목 ${b.codes.length}` : ""}
            </title>
            <circle r={b.r} />
            <text y={fs * 0.35} textAnchor="middle" fontSize={fs} fontWeight={700}>
              {b.term}
            </text>
            {b.r >= 26 && (
              <text y={fs * 0.35 + fs * 0.9} textAnchor="middle" fontSize={Math.max(8, fs * 0.55)} className="bd-bub-n">
                {b.n}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* 칸 틀                                                                */
/* ------------------------------------------------------------------ */
function Panel({ title, sub, more, moreLabel = "더 보기", cls, children }: { title: string; sub?: string; more?: string; moreLabel?: string; cls?: string; children: ReactNode }) {
  return (
    <section className={`bd-panel ${cls ?? ""}`}>
      <header className="bd-panel-h">
        <b>{title}</b>
        {sub && <small>{sub}</small>}
        {more && (
          <a href={more} className="bd-more">
            {moreLabel} ›
          </a>
        )}
      </header>
      <div className="bd-panel-b">{children}</div>
    </section>
  );
}

const hm = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

type VolRow = { code: string; name: string; price: number; changeRate: number; tv: number };
type WatchRow = { code: string; name: string; price: number; changeRate: number };

export function MarketBoardPage({ onSelectStock }: { onSelectStock: (code: string, name: string) => void }) {
  const indices = useSection<IndexCard[]>("indices", 5_000);
  const flow = useSection<MarketFlow>("flow", 20_000);
  const global = useSection<GlobalQuote[]>("global", 15_000);
  const usMajor = useSection<UsMajorResult>("usMajor", 15_000);
  const { lens } = useMarketLens();
  const [sig, setSig] = useState<MarketSignal | null>(null);
  const [indexDetail, setIndexDetail] = useState<string | null>(null);
  const [chart, setChart] = useState<ChartTarget | null>(null);

  /* 다섯 칸의 재료 — 각자 제 주기 */
  const pulse = usePoll<TopicPulse>(() => api.topicPulse("now"), 60_000);
  const leaders = usePoll<LeaderScan>(() => api.leaderScan(false), 300_000);
  const volume = usePoll<VolRow[]>(async () => {
    const raw = (await api.volumeRanking("000", "3")) as { tdy_trde_qty_upper?: Record<string, unknown>[] };
    return (raw.tdy_trde_qty_upper ?? []).slice(0, 12).map((r) => ({
      code: normalizeStockCode(String(r.stk_cd ?? "")),
      name: String(r.stk_nm ?? ""),
      price: Math.abs(Number(r.cur_prc)) || 0,
      changeRate: Number(r.flu_rt) || 0,
      /* trde_amt 는 백만원 → 억원 */
      tv: Math.round((Number(r.trde_amt) || 0) / 100),
    }));
  }, 60_000);
  const watch = usePoll<{ items: WatchItem[]; quotes: Record<string, { price: number; changeRate: number }> }>(async () => {
    const [w, q] = await Promise.all([api.watchlist(), api.watchQuotes()]);
    return { items: w.items.filter((i) => !i.divider), quotes: q.quotes };
  }, 30_000);
  const news = usePoll<{ items: NaverNewsItem[]; leads: Record<string, { code: string; name: string }[]> }>(async () => {
    const r = await api.newsNaver("main", 1);
    const items = r.items.slice(0, 10);
    const leads: Record<string, { code: string; name: string }[]> = {};
    try {
      const l = await api.newsLeads(items.map((x) => ({ link: x.link, title: x.title, summary: x.summary })));
      for (const x of l.leads) leads[x.link] = x.stocks;
    } catch {
      /* 종목 칩만 빈다 */
    }
    return { items, leads };
  }, 180_000);

  useEffect(() => {
    const pullSig = () => void api.marketSignal().then(setSig).catch(() => undefined);
    pullSig();
    const ts = setInterval(pullSig, 60_000);
    return () => clearInterval(ts);
  }, []);

  const kospi = indices.data?.find((c) => c.code === "001");
  const kosdaq = indices.data?.find((c) => c.code === "101");
  const g = (key: string) => global.data?.find((q) => q.key === key) ?? null;
  const um = (key: string) => usMajor.data?.rows.find((q) => q.key === key) ?? null;
  const vixQ = g("vix") ?? um("vix");
  const night = usMajor.data?.nightFutures ?? g("krNightFut");
  const es = g("esF");
  const usdkrw = g("usdkrw");
  const above20Series = lens?.thermo.series.above20 ?? [];
  const above20 = above20Series.length ? above20Series[above20Series.length - 1] : null;
  const above20Trend = above20Series.length > 5 ? above20Series[above20Series.length - 1] - above20Series[above20Series.length - 6] : null;
  const riseNow = lens?.thermo.riseNow ?? (kospi && kospi.rising + kospi.falling > 0 ? (kospi.rising / (kospi.rising + kospi.falling)) * 100 : null);
  const flowK = flow.data?.kospi ?? null;

  const regime = useMemo(
    () =>
      judge({
        sig,
        kospi,
        above20,
        above20Trend,
        riseNow,
        flow: flow.data,
        usLevel: usMajor.data?.boardSignal.level ?? null,
        vix: vixQ?.price ?? null,
        nightFut: night?.changeRate ?? null,
      }),
    [sig, kospi, above20, above20Trend, riseNow, flow.data, usMajor.data, vixQ, night],
  );

  const isNight = (() => {
    const h = new Date(Date.now() + 9 * 3600_000).getUTCHours();
    return h >= 16 || h < 8;
  })();

  /* ── 지수 띠 ── */
  const idxCell = (c: IndexCard | undefined, label: string, code: string) => (
    <button key={code} type="button" className={`bd-cell idx ${signClass(c?.changeRate ?? 0)}`} onClick={() => setIndexDetail(code)}>
      <span className="bd-cell-l">{label}</span>
      <b className="bd-cell-v">{c ? fmt(c.price) : "…"}</b>
      <span className="bd-cell-s">
        {c ? pct(c.changeRate) : ""}
        {c && (
          <i>
            ▲{c.rising} ▼{c.falling}
          </i>
        )}
      </span>
      {c && c.sparkline.length > 2 && (
        <span className="bd-cell-spark">
          <Sparkline values={c.sparkline} up={c.changeRate >= 0} />
        </span>
      )}
    </button>
  );
  const cell = (key: string, label: string, value: string, sub?: string, cls?: string, onClick?: () => void) => (
    <button key={key} type="button" className={`bd-cell ${cls ?? ""}${onClick ? " click" : ""}`} onClick={onClick} disabled={!onClick}>
      <span className="bd-cell-l">{label}</span>
      <b className="bd-cell-v">{value}</b>
      {sub && <span className="bd-cell-s">{sub}</span>}
    </button>
  );

  /* ── 주도주: 섹터 위주로 다섯, 그 밑에 종목 칩 ── */
  const leadSectors = (leaders.data?.sectors ?? []).slice(0, 5);

  /* ── 관심종목: 오른 것·내린 것 ── */
  const watchRows = useMemo(() => {
    if (!watch.data) return null;
    const quotes = watch.data.quotes;
    const rows: WatchRow[] = [];
    for (const i of watch.data.items) {
      const q = quotes[i.code];
      if (q) rows.push({ code: i.code, name: i.name, price: q.price, changeRate: q.changeRate });
    }
    const up = rows.filter((r) => r.changeRate > 0).sort((a, b) => b.changeRate - a.changeRate);
    const down = rows.filter((r) => r.changeRate < 0).sort((a, b) => a.changeRate - b.changeRate);
    const flat = rows.length - up.length - down.length;
    const avg = rows.length ? rows.reduce((a, r) => a + r.changeRate, 0) / rows.length : 0;
    return { total: rows.length, up, down, flat, avg };
  }, [watch.data]);

  const tvMax = Math.max(1, ...(volume.data ?? []).map((v) => v.tv));
  const newsLeads = news.data?.leads ?? {};

  return (
    <div className="page board bd2">
      {/* ① 지수 띠 — 국면 점 · 코스피 · 코스닥 · 오늘 수급 · 선물 · VIX · 환율 */}
      <div className="bd-strip">
        <div className={`bd-cell regime ${regime.level}`} title={regime.reasons.map((r) => r.text).join(" · ")}>
          <span className="bd-regime-dot" />
          <span className="bd-cell-l">국면</span>
          <b className="bd-cell-v">{regime.name}</b>
          <span className="bd-cell-s">{regime.verdict}</span>
        </div>
        {idxCell(kospi, "코스피", "001")}
        {idxCell(kosdaq, "코스닥", "101")}
        {cell(
          "flow",
          "오늘 수급 (코스피)",
          flowK ? `외인 ${eok(flowK.foreign)}` : "…",
          flowK ? `기관 ${eok(flowK.institution)} · 개인 ${eok(flowK.individual)}` : undefined,
          flowK ? (flowK.foreign > 0 && flowK.institution > 0 ? "positive" : flowK.foreign < 0 && flowK.institution < 0 ? "negative" : "") : "",
          () => {
            window.location.hash = "#/briefing";
          },
        )}
        {cell(
          "fut",
          isNight ? "미국 선물 ES" : "야간선물",
          isNight ? pct(es?.changeRate) : night ? pct(night.changeRate) : "…",
          isNight ? `야간선물 ${pct(night?.changeRate)}` : `ES ${pct(es?.changeRate)}`,
          signClass(isNight ? (es?.changeRate ?? 0) : (night?.changeRate ?? 0)),
          es ? () => setChart({ kind: "yahoo", symbol: es.symbol, label: "US 500 선물", digits: 2, hintRate: es.changeRate ?? undefined }) : undefined,
        )}
        {cell(
          "vix",
          "VIX",
          vixQ ? fmt(vixQ.price ?? null, 1) : "…",
          vixQ ? `${pct(vixQ.changeRate)} · ${(vixQ.price ?? 0) >= 30 ? "공포" : (vixQ.price ?? 0) >= 20 ? "불안" : "안정"}` : undefined,
          /* 공포지수는 오르면 나쁜 쪽 — 파랑 */
          vixQ ? ((vixQ.changeRate ?? 0) >= 5 || (vixQ.price ?? 0) >= 30 ? "negative" : (vixQ.changeRate ?? 0) <= -5 ? "positive" : "") : "",
          vixQ ? () => setChart({ kind: "yahoo", symbol: "^VIX", label: "VIX", digits: 2 }) : undefined,
        )}
        {cell(
          "fx",
          "달러/원",
          usdkrw ? fmt(usdkrw.price, 1) : "…",
          usdkrw ? `${pct(usdkrw.changeRate)} · ${(usdkrw.changeRate ?? 0) < 0 ? "원화 강세" : (usdkrw.changeRate ?? 0) > 0 ? "원화 약세" : "보합"}` : undefined,
          usdkrw ? ((usdkrw.changeRate ?? 0) < -0.2 ? "positive" : (usdkrw.changeRate ?? 0) > 0.2 ? "negative" : "") : "",
          usdkrw ? () => setChart({ kind: "yahoo", symbol: usdkrw.symbol, label: "달러/원", digits: 1, hintRate: usdkrw.changeRate ?? undefined }) : undefined,
        )}
      </div>

      {/* ② 다섯 칸 */}
      <div className="bd-grid">
        <Panel title="시장 이슈" sub={pulse.data ? `${pulse.data.hours}시간 · 뉴스 ${pulse.data.health.newsArticles}건${pulse.data.health.channelReady ? " · 텔레그램" : ""}` : undefined} more="#/news" cls="issue">
          {pulse.data?.headline && <div className={`bd-headline${pulse.data.hot ? " hot" : ""}`}>{pulse.data.headline}</div>}
          <IssueBubbles pulse={pulse.data} onSelectStock={onSelectStock} />
          <div className="bd-legend">
            <span className="both">뉴스·텔레그램 둘 다</span>
            <span className="channel">텔레그램</span>
            <span className="news">뉴스</span>
            <span className="fresh">처음 보는 말</span>
          </div>
        </Panel>

        <Panel title="오늘의 주도주" sub={leaders.data ? (leaders.data.intraday ? "장중 중간 모습" : leaders.data.date) : undefined} more="#/leaders" cls="leaders">
          {!leaders.data && !leaders.error && <div className="bd-empty">주도주를 훑는 중…</div>}
          {leaders.error && !leaders.data && <div className="bd-empty">{leaders.error}</div>}
          {leaders.data && leadSectors.length === 0 && <div className="bd-empty">{leaders.data.note}</div>}
          {leadSectors.map((s) => (
            <div key={s.name} className="bd-lead">
              <div className="bd-lead-h">
                <b>{s.name}</b>
                <span className={signClass(s.weightedRate)}>{pct(s.weightedRate, 1)}</span>
                <small>
                  {s.rising}/{s.members} 상승{s.streak && s.streak > 1 ? ` · ${s.streak}일째` : ""}
                </small>
                <i className="bd-lead-bar">
                  <i style={{ width: `${Math.max(4, Math.min(100, s.breadth))}%` }} />
                </i>
              </div>
              <div className="bd-lead-stocks">
                {s.leaders.slice(0, 4).map((l) => (
                  <button key={l.code} type="button" className={`bd-chip ${signClass(l.changeRate)}`} onClick={() => onSelectStock(l.code, l.name)} title={l.tags.join(" · ")}>
                    {l.name} <b>{pct(l.changeRate, 1)}</b>
                    {l.mark?.super && <em title="슈퍼신호등">★</em>}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </Panel>

        <Panel title="거래대금 상위" sub={volume.data ? "통합 · 억원" : undefined} more="#/volume" cls="volume">
          {!volume.data && <div className="bd-empty">{volume.error ?? "순위를 받는 중…"}</div>}
          {volume.data && (
            <ol className="bd-rank">
              {volume.data.slice(0, 10).map((v, i) => (
                <li key={v.code}>
                  <button type="button" onClick={() => onSelectStock(v.code, v.name)}>
                    <span className="bd-rank-n">{i + 1}</span>
                    <span className="bd-rank-name">{v.name}</span>
                    <span className={`bd-rank-rate ${signClass(v.changeRate)}`}>{pct(v.changeRate)}</span>
                    <span className="bd-rank-tv">{v.tv >= 10_000 ? `${(v.tv / 10_000).toFixed(2)}조` : `${v.tv.toLocaleString()}억`}</span>
                    <i className="bd-rank-bar" style={{ width: `${(v.tv / tvMax) * 100}%` }} />
                  </button>
                </li>
              ))}
            </ol>
          )}
        </Panel>

        <Panel
          title="관심종목 현황"
          sub={watchRows ? `${watchRows.total}종목 · 평균 ${pct(watchRows.avg)} · ▲${watchRows.up.length} ▼${watchRows.down.length}${watchRows.flat ? ` ·${watchRows.flat}` : ""}` : undefined}
          more="#/watchAi"
          cls="watch"
        >
          {!watchRows && <div className="bd-empty">{watch.error ?? "관심종목 시세를 받는 중…"}</div>}
          {watchRows && watchRows.total === 0 && <div className="bd-empty">관심종목이 비어 있습니다</div>}
          {watchRows && watchRows.total > 0 && (
            <div className="bd-watch">
              <div className="bd-watch-col up">
                <small>오른 것</small>
                {watchRows.up.slice(0, 7).map((r) => (
                  <button key={r.code} type="button" onClick={() => onSelectStock(r.code, r.name)}>
                    <span>{r.name}</span>
                    <b className="positive">{pct(r.changeRate)}</b>
                  </button>
                ))}
                {watchRows.up.length === 0 && <span className="bd-dim">없음</span>}
              </div>
              <div className="bd-watch-col down">
                <small>내린 것</small>
                {watchRows.down.slice(0, 7).map((r) => (
                  <button key={r.code} type="button" onClick={() => onSelectStock(r.code, r.name)}>
                    <span>{r.name}</span>
                    <b className="negative">{pct(r.changeRate)}</b>
                  </button>
                ))}
                {watchRows.down.length === 0 && <span className="bd-dim">없음</span>}
              </div>
            </div>
          )}
        </Panel>

        <Panel title="주요 뉴스" sub={news.data?.items[0] ? `마지막 ${hm(news.data.items[0].at)}` : undefined} more="#/news" cls="news">
          {!news.data && <div className="bd-empty">{news.error ?? "뉴스를 받는 중…"}</div>}
          {news.data && (
            <ul className="bd-news">
              {news.data.items.slice(0, 8).map((n) => (
                <li key={n.link}>
                  <span className="bd-news-t">{hm(n.at)}</span>
                  <a href={n.link} target="_blank" rel="noreferrer" className="bd-news-title">
                    {n.title}
                  </a>
                  <span className="bd-news-press">{n.press}</span>
                  {(newsLeads[n.link] ?? []).slice(0, 3).map((s) => (
                    <button key={s.code} type="button" className="bd-chip tiny" onClick={() => onSelectStock(s.code, s.name)}>
                      {s.name}
                    </button>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {indexDetail && <IndexDetailSheet code={indexDetail} onClose={() => setIndexDetail(null)} />}
      {chart && <YahooChartSheet target={chart} onClose={() => setChart(null)} />}
    </div>
  );
}
