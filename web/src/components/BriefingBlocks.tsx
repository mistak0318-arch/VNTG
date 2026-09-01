import { Fragment, useCallback, useEffect, useState } from "react";
import { MarketTrendSheet } from "./MarketTrendSheet";
import {
  api,
  fmtNum,
  type BriefingTile,
  type EvaluatedTheme,
  type IndexCandle,
  type IndexCard,
  type MarketFlow,
  type ThemeRow,
  type UsWatchGroup,
} from "../api";
import { useSection } from "../useSection";
import { tileHeat, useAppearance } from "../useAppearance";
import { ConstituentSheet, type ConstituentTarget } from "./overview/ConstituentSheet";

/**
 * 마켓 브리핑의 세 조각 — **오늘 수급 · 테마 · 관심종목 히트맵.**
 *
 * 원래 BriefingPage 안에 인라인으로 있었는데, 보드 블록으로도 띄우게 되면서
 * (2026-08-27 사용자 지정: "마켓브리핑의 이 부분도 보드의 하나의 요소로")
 * 여기로 빼냈다 — 같은 값을 두 번 그리면 언젠가 반드시 갈라진다.
 * 브리핑은 제 레이아웃(좌우 기둥)에 조각을 꽂고, 보드는 한 줄(ib-row3)로 세운다.
 */

function cls(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n === 0) return "";
  return n > 0 ? "positive" : "negative";
}

function pct(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

/**
 * 오늘 수급 — 격자판 (2026-08-26 개편).
 * 예전엔 주체마다 화면 폭을 다 쓰는 긴 막대였는데, 태블릿에서 막대가 너무 길어
 * 정작 값이 안 읽혔다. **숫자가 주인공, 막대는 밑줄**로 뒤집고 선물(계약)도 한 줄 넣는다.
 */
export function FlowBars({
  flow,
  futures,
  futPrice,
  onOpenIndex,
  onOpenFutures,
}: {
  flow: MarketFlow | null;
  futures: { individual: number; foreign: number; institution: number } | null;
  /** K200 선물 지수 — 있으면 계약을 **억원으로 환산**해 코스피·코스닥과 결을 맞춘다 (2026-08-27) */
  futPrice?: number | null;
  /**
   * 시장 이름을 누르면 상세 (2026-08-29 요청) — 시황 대시보드의 지수 타일과
   * **같은 시트**로 간다. 안 넘기면 그냥 안 눌린다(보드 블록 등 다른 자리).
   */
  onOpenIndex?: (code: string) => void;
  onOpenFutures?: () => void;
}) {
  if (!flow) return <div className="empty">수급을 아직 못 받았습니다.</div>;
  /*
   * 선물 환산: 억원 ≈ 계약 × 지수 × 25만원 ÷ 1억 = 계약 × 지수 ÷ 400.
   * 지수 카드 선물 타일과 같은 식이다. 원본 계약 수는 툴팁으로 남긴다 —
   * 평균 체결가가 아니라 현재가 기준이라 추정치다.
   */
  const conv =
    futures && futPrice && futPrice > 0
      ? {
          individual: Math.round((futures.individual * futPrice) / 400),
          foreign: Math.round((futures.foreign * futPrice) / 400),
          institution: Math.round((futures.institution * futPrice) / 400),
        }
      : null;
  type FutRaw = { individual: number; foreign: number; institution: number } | null;
  const rows = [
    { label: "코스피", f: flow.kospi, unit: "억", raw: null as FutRaw, open: () => onOpenIndex?.("001") },
    { label: "코스닥", f: flow.kosdaq, unit: "억", raw: null as FutRaw, open: () => onOpenIndex?.("101") },
    ...(futures
      ? [
          conv
            ? { label: "선물", f: conv, unit: "억", raw: futures as FutRaw, open: () => onOpenFutures?.() }
            : { label: "선물", f: futures, unit: "계약", raw: null as FutRaw, open: () => onOpenFutures?.() },
        ]
      : []),
  ];
  /* 쌍끌이 한 줄 — 코스피 기준. 외인·기관이 같이 사는 날이 개인 매수보다 훨씬 드물고 세다 */
  const k = flow.kospi;
  const twin =
    k.foreign > 0 && k.institution > 0
      ? "외국인·기관 쌍끌이 매수"
      : k.foreign < 0 && k.institution < 0
        ? "외국인·기관 동반 매도"
        : "외국인·기관 엇갈림";

  return (
    <>
      {/* ⚠️ 클래스명 bf-supply — bf-fg 는 거래원 「외국계」 뱃지가 선점(파란 배경 사고, 2026-08-26) */}
      <div className="bf-supply">
        <span className="bf-supply-corner" />
        {["개인", "외국인", "기관"].map((h) => (
          <span className="bf-supply-h" key={h}>{h}</span>
        ))}
        {rows.map(({ label, f, unit, raw, open }) => {
          /* 행별 최대로 잰다 — 행마다 판(코스피/코스닥/선물)이 달라 같이 재면 안 된다 */
          const max = Math.max(1, ...[f.individual, f.foreign, f.institution].map(Math.abs));
          const rawVals = raw ? [raw.individual, raw.foreign, raw.institution] : null;
          return (
            <Fragment key={label}>
              {/* 이름 칸을 누르면 그 시장의 상세 — 대시보드 지수 타일과 같은 시트 */}
              {onOpenIndex || onOpenFutures ? (
                <button
                  type="button"
                  className="bf-supply-m bf-supply-click"
                  onClick={open}
                  title={`${label} 상세 보기`}
                >
                  {label}
                </button>
              ) : (
                <em className="bf-supply-m">{label}</em>
              )}
              {[f.individual, f.foreign, f.institution].map((v, i) => (
                <span
                  className="bf-supply-cell"
                  key={i}
                  title={
                    rawVals
                      ? `원본 ${rawVals[i] > 0 ? "+" : ""}${fmtNum(rawVals[i])}계약 · 억원 환산은 계약 × 지수 × 25만원 (추정)`
                      : undefined
                  }
                >
                  <b className={`num ${cls(v)}`}>
                    {v > 0 ? "+" : ""}
                    {fmtNum(Math.round(v))}
                    <i>{unit}</i>
                  </b>
                  <span className="bf-supply-bar">
                    <i
                      className={v >= 0 ? "up" : "down"}
                      style={{ width: `${(Math.abs(v) / max) * 100}%` }}
                    />
                  </span>
                </span>
              ))}
            </Fragment>
          );
        })}
      </div>
      <div className="bf-note">
        {twin} · 선물은 K200 지수선물{conv ? " — 계약을 억원으로 환산(≈, 원본은 툴팁)" : "(계약)"} · 기관
        세부는 종목 화면에서 봅니다
      </div>
    </>
  );
}

/**
 * 종목등락현황 — **브리핑 압축판** (2026-08-27 "데이터만 가져오고 레이아웃은 따로").
 * 시황의 표(ov-table)를 그대로 꽂았더니 글자 크기·간격이 브리핑과 안 맞았다.
 * 수급 격자와 같은 문법으로 다시 그린다: 숫자가 주인공, **비율 밑줄**이 폭을 말한다.
 * 재료는 지수 카드에 이미 실려 온다 — 새로 받는 게 없다.
 */
export function UpDownStrip({ cards }: { cards: (IndexCard | undefined)[] }) {
  const rows = cards.filter((c): c is IndexCard => Boolean(c));
  /* 눌러서 60일 흐름 (2026-08-29) — 오늘 숫자 하나로는 많은지 적은지 모른다 */
  const [trend, setTrend] = useState<{ code: string; name: string } | null>(null);
  if (rows.length === 0) return <div className="empty">등락현황을 아직 못 받았습니다.</div>;
  return (
    <div className="bf-updown">
      {rows.map((c) => {
        const total = Math.max(1, c.rising + c.flat + c.falling);
        const w = (n: number) => `${(n / total) * 100}%`;
        return (
          <button
            type="button"
            className="bf-ud-row bf-ud-click"
            key={c.code}
            onClick={() => setTrend({ code: c.code, name: c.name })}
            title={`${c.name} 60일 흐름 보기`}
          >
            <em className="bf-ud-m">{c.name}</em>
            <span className="bf-ud-cells num">
              <b className="positive">
                ▲{fmtNum(c.rising)}
                {c.upperLimit > 0 && <i title="상한가">上{c.upperLimit}</i>}
              </b>
              <b className="bf-ud-flat">{fmtNum(c.flat)}</b>
              <b className="negative">
                ▼{fmtNum(c.falling)}
                {c.lowerLimit > 0 && <i title="하한가">下{c.lowerLimit}</i>}
              </b>
            </span>
            {/* 상승/보합/하락 비율 — 수급 격자의 밑줄과 같은 자리·같은 뜻 */}
            <span
              className="bf-ud-bar"
              title={`상승 ${c.rising} · 보합 ${c.flat} · 하락 ${c.falling}`}
            >
              <i className="u" style={{ width: w(c.rising) }} />
              <i className="f" style={{ width: w(c.flat) }} />
              <i className="d" style={{ width: w(c.falling) }} />
            </span>
          </button>
        );
      })}
      {trend && (
        <MarketTrendSheet code={trend.code} name={trend.name} onClose={() => setTrend(null)} />
      )}
    </div>
  );
}

/** 억원 → 「12.3조」/「8,400억」 */
function money(eok: number): string {
  if (eok >= 10000) return `${(eok / 10000).toFixed(1)}조`;
  return `${fmtNum(Math.round(eok))}억`;
}

/**
 * 거래대금 현황 — **브리핑 압축판.** 시황(TurnoverPanel)과 같은 재료(지수 일봉의
 * 거래대금, 서버 캐시 공유)로 한 줄씩만: 오늘 값이 주인공, 밑줄이 20일 평균 대비.
 * 추이 차트·긴 설명은 시황 탭 몫이다 — 여기는 「돈이 도나」만 답한다.
 */
export function TurnoverStrip() {
  const [rows, setRows] = useState<
    { code: string; name: string; today: number; vsPrev: number | null; vsAvg: number | null }[] | null
  >(null);
  /* 눌러서 60일 흐름 (2026-08-29) — 「8.4조」는 평소를 알아야 뜻이 생긴다 */
  const [trend, setTrend] = useState<{ code: string; name: string } | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const out: { code: string; name: string; today: number; vsPrev: number | null; vsAvg: number | null }[] = [];
      for (const m of [
        { code: "001", name: "코스피" },
        { code: "101", name: "코스닥" },
      ]) {
        try {
          const r = await api.indexDetail(m.code, "day");
          const cs: IndexCandle[] = r.candles;
          if (cs.length === 0) continue;
          const today = cs[cs.length - 1];
          const prev = cs[cs.length - 2];
          const last20 = cs.slice(-21, -1);
          const avg =
            last20.length > 0 ? last20.reduce((a, c) => a + c.tradeValue, 0) / last20.length : 0;
          out.push({
            code: m.code,
            name: m.name,
            today: today.tradeValue,
            vsPrev:
              prev && prev.tradeValue > 0
                ? ((today.tradeValue - prev.tradeValue) / prev.tradeValue) * 100
                : null,
            vsAvg: avg > 0 ? (today.tradeValue / avg) * 100 : null,
          });
        } catch {
          /* 한 시장 실패는 넘어간다 */
        }
      }
      if (alive) setRows(out);
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (rows === null) return <div className="empty">불러오는 중…</div>;
  if (rows.length === 0) return <div className="empty">거래대금을 아직 못 받았습니다.</div>;
  return (
    <div className="bf-updown">
      {rows.map((r) => (
        <button
          type="button"
          className="bf-ud-row bf-ud-click"
          key={r.name}
          onClick={() => setTrend({ code: r.code, name: r.name })}
          title={`${r.name} 거래대금 60일 흐름 보기`}
        >
          <em className="bf-ud-m">{r.name}</em>
          <span className="bf-ud-cells num">
            <b>{money(r.today)}</b>
            <b className={`bf-to-sub ${cls(r.vsPrev)}`}>
              전일 {r.vsPrev === null ? "-" : `${r.vsPrev > 0 ? "+" : ""}${r.vsPrev.toFixed(0)}%`}
            </b>
            <b
              className={`bf-to-sub ${
                r.vsAvg !== null && r.vsAvg >= 120
                  ? "positive"
                  : r.vsAvg !== null && r.vsAvg <= 70
                    ? "negative"
                    : ""
              }`}
            >
              20일比 {r.vsAvg === null ? "-" : `${r.vsAvg.toFixed(0)}%`}
            </b>
          </span>
          {/* 밑줄 = 20일 평균 대비. 눈금(평균 자리)을 넘으면 평소보다 붐빈 날이다 */}
          <span className="bf-ud-bar bf-to-bar" title="밑줄 눈금이 20일 평균(100%) 자리입니다">
            <i
              className={r.vsAvg !== null && r.vsAvg >= 100 ? "u" : "f"}
              style={{ width: `${Math.min(100, ((r.vsAvg ?? 0) / 150) * 100)}%` }}
            />
            <u className="bf-to-tick" />
          </span>
        </button>
      ))}
      {trend && (
        <MarketTrendSheet code={trend.code} name={trend.name} onClose={() => setTrend(null)} />
      )}
    </div>
  );
}

/** 테마 — 상승 5 · 하락 3. 줄 전체가 눌린다(구성종목 시트) — 보기만 하는 숫자는 죽은 숫자다 */
export function ThemeStrip({
  themes,
  onPickTheme,
}: {
  themes: { top: ThemeRow[]; bottom: ThemeRow[] } | null;
  onPickTheme: (t: ThemeRow) => void;
}) {
  if (!themes) return <div className="empty">테마를 아직 못 받았습니다.</div>;
  const row = (t: ThemeRow) => (
    <button
      type="button"
      className="bf-theme bf-theme-click"
      key={t.code}
      onClick={() => onPickTheme(t)}
      title="눌러서 구성종목 보기"
    >
      <span className="bf-theme-name">{t.name}</span>
      <i className="bf-theme-main">{t.mainStock}</i>
      <b className={`num ${cls(t.changeRate)}`}>{pct(t.changeRate)}</b>
    </button>
  );
  return (
    <div className="bf-themes">
      {themes.top.slice(0, 5).map(row)}
      <div className="bf-theme-sep" />
      {themes.bottom.slice(0, 3).map(row)}
    </div>
  );
}

/**
 * 내 테마 · 미국 테마 (2026-08-27) — **키움 테마를 걷어낸 자리.**
 *
 * 증권사가 나눠 준 테마와 실제로 시장이 도는 묶음은 다르다 — 「반도체_후공정」처럼
 * 잘게 쪼개져 있어 무엇이 도는지 읽히지 않았다. 데일리 리포트가 이미 **내 테마 ·
 * 미국 테마** 두 판으로 답을 내고 있으므로 브리핑도 같은 재료를 쓴다.
 *
 * 다만 리포트는 타일(MAP)이고 여기는 **텍스트 줄**이다 — 브리핑 가운데 기둥은
 * 좁고, 타일은 자리를 너무 먹는다. 오른 것 위·내린 것 아래, 그 사이에 실선.
 */
export function MyThemeStrip({
  onPickTheme,
}: {
  /** 테마를 누르면 구성종목 시트 — 보기만 하는 숫자는 죽은 숫자다 */
  /*
   * ⚠️ 등락률·가격을 **여기서 떨어뜨리면 안 된다** (2026-08-28).
   * 원본(customThemes·usWatch)엔 다 있는데 이 콜백이 code·name 만 넘겨서,
   * 시트가 전 종목 0.00% 로 떴다 — 이미 손에 있는 값을 버리고 있었다.
   */
  onPickTheme: (t: {
    kind: "custom" | "usGroup";
    id: string;
    name: string;
    stocks: { code: string; name: string; price: number; changeRate: number; marketCap: number | null }[];
  }) => void;
}) {
  const [kr, setKr] = useState<EvaluatedTheme[] | null>(null);
  const [us, setUs] = useState<UsWatchGroup[] | null>(null);
  const [tab, setTab] = useState<"kr" | "us">("kr");

  useEffect(() => {
    let alive = true;
    void api
      .customThemes()
      .then((r) => alive && setKr(r.themes))
      .catch(() => alive && setKr([]));
    void api
      .usWatch()
      .then((r) => alive && setUs(r.groups))
      .catch(() => alive && setUs([]));
    return () => {
      alive = false;
    };
  }, []);

  const krRows = (kr ?? [])
    .filter((t) => t.changeRate !== null && t.stocks.length > 0)
    .sort((a, b) => (b.changeRate ?? 0) - (a.changeRate ?? 0));
  const usRows = (us ?? [])
    .filter((g) => g.changeRate !== null && g.stocks.length > 0)
    .sort((a, b) => (b.changeRate ?? 0) - (a.changeRate ?? 0));

  const loading = tab === "kr" ? kr === null : us === null;
  const rows: { id: string; name: string; rate: number; sub: string; onClick: () => void }[] =
    tab === "kr"
      ? krRows.map((t) => ({
          id: t.id,
          name: t.name,
          rate: t.changeRate ?? 0,
          sub: `▲${t.risingCount}/▼${t.fallingCount}`,
          onClick: () =>
            onPickTheme({
              kind: "custom",
              id: t.id,
              name: t.name,
              stocks: t.stocks
                .filter((s) => s.found)
                .map((s) => ({
                  code: s.code,
                  name: s.name,
                  price: 0, // 내 태그 평가엔 가격이 없다 — 등락률만 있다
                  changeRate: s.changeRate,
                  marketCap: s.marketCap,
                })),
            }),
        }))
      : usRows.map((g) => ({
          id: g.id,
          name: g.name,
          rate: g.changeRate ?? 0,
          sub: `▲${g.rising}/▼${g.falling}`,
          onClick: () =>
            onPickTheme({
              kind: "usGroup",
              id: g.id,
              name: g.name,
              stocks: g.stocks.map((s) => ({
                code: s.symbol,
                name: s.name,
                price: s.price ?? 0,
                changeRate: s.changeRate ?? 0,
                marketCap: null,
              })),
            }),
        }));

  /* 오른 것 위, 내린 것 아래. 가운데를 실선으로 갈라 방향이 한눈에 보이게 */
  const upRows = rows.filter((r) => r.rate > 0).slice(0, 6);
  const downRows = rows.filter((r) => r.rate < 0).slice(-4);

  return (
    <>
      <div className="filter-row bf-theme-tabs">
        <button
          className={`filter-btn ${tab === "kr" ? "active" : ""}`}
          onClick={() => setTab("kr")}
        >
          내 태그
        </button>
        <button
          className={`filter-btn ${tab === "us" ? "active" : ""}`}
          onClick={() => setTab("us")}
        >
          미국 테마
        </button>
      </div>
      {loading ? (
        <div className="empty">불러오는 중…</div>
      ) : rows.length === 0 ? (
        <div className="empty">
          {tab === "kr"
            ? "내 태그가 비어 있습니다 — 마이페이지 > 내 태그에서 만듭니다."
            : "해외 관심종목 그룹이 비어 있습니다."}
        </div>
      ) : (
        <div className="bf-themes">
          {upRows.map((r) => (
            <button
              type="button"
              className="bf-theme bf-theme-click"
              key={r.id}
              onClick={r.onClick}
              title="눌러서 구성종목 보기"
            >
              <span className="bf-theme-name">{r.name}</span>
              <i className="bf-theme-main">{r.sub}</i>
              <b className={`num ${cls(r.rate)}`}>{pct(r.rate)}</b>
            </button>
          ))}
          {downRows.length > 0 && <div className="bf-theme-sep" />}
          {downRows.map((r) => (
            <button
              type="button"
              className="bf-theme bf-theme-click"
              key={r.id}
              onClick={r.onClick}
              title="눌러서 구성종목 보기"
            >
              <span className="bf-theme-name">{r.name}</span>
              <i className="bf-theme-main">{r.sub}</i>
              <b className={`num ${cls(r.rate)}`}>{pct(r.rate)}</b>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * 관심종목 히트맵 — 균등 격자. 순서는 서버가 정렬해 준다: 슈퍼신호등 그룹 먼저 →
 * 그룹 정렬순, 같은 그룹 안은 등락률 내림차순. 그룹 이름은 뱃지로 칸 안에.
 */
export function WatchHeatGrid({
  heat,
  onSelectStock,
}: {
  heat: { traded: boolean; tiles: BriefingTile[] } | null;
  onSelectStock: (code: string, name: string) => void;
}) {
  const appearance = useAppearance();
  if (heat === null) return <div className="empty">불러오는 중…</div>;
  if (heat.tiles.length === 0) return <div className="empty">관심종목이 비어 있습니다.</div>;
  return (
    <>
      <div className="bf-heat">
        {heat.tiles.map((t) => {
          /*
           * 색은 **공용 tileHeat** 로 (2026-08-27) — 여기서 빨강·파랑을 직접 박고 있어서
           * 엑셀 모드에서도 주식 색이 그대로 남았다. 테마 MAP·전광판과 같은 함수를 쓰면
           * 엑셀에서는 무채색 명암(+ 내림 왼줄)으로 자동으로 갈린다. ±3% 를 최대로.
           */
          return (
            <button
              key={t.code}
              className="bf-tile"
              style={tileHeat(t.rate, appearance.theme, 3)}
              onClick={() => onSelectStock(t.code, t.name)}
              title={`${t.name} ${pct(t.rate)}${t.group ? ` · ${t.group}` : ""}${t.cap ? ` · 시총 ${fmtNum(t.cap)}억` : ""}`}
            >
              {t.group && (
                <em className={`bf-tile-g${t.group === "슈퍼신호등" ? " super" : ""}`}>
                  {t.group === "슈퍼신호등" ? "🌟" : t.group}
                </em>
              )}
              <b>{t.name}</b>
              <i className="num">{pct(t.rate)}</i>
            </button>
          );
        })}
      </div>
      {!heat.traded && (
        <div className="bf-note">⚠️ 아직 오늘 거래가 반영되기 전입니다(직전 종가 기준).</div>
      )}
    </>
  );
}

/**
 * 보드 블록 — 세 조각을 한 줄로(ib-row3, 좁아지면 아래로 접힘).
 * 종목과 무관한 칸이다. 값은 브리핑과 같은 섹션·API 라 호출이 늘지 않는다.
 */
export function BriefingTrioCell({
  onSelectStock,
}: {
  onSelectStock: (code: string, name: string) => void;
}) {
  const flow = useSection<MarketFlow>("flow", 30_000);
  /* 선물 계약→억원 환산에 지수값이 필요하다 — 브리핑과 같은 섹션 캐시라 공짜 */
  const indices = useSection<IndexCard[]>("indices", 30_000);
  const futPrice = indices.data?.find((i) => i.code === "F")?.price ?? null;
  const themes = useSection<{ top: ThemeRow[]; bottom: ThemeRow[] }>("themes", 60_000);
  const [heat, setHeat] = useState<{ traded: boolean; tiles: BriefingTile[] } | null>(null);
  const [futFlow, setFutFlow] = useState<{
    individual: number;
    foreign: number;
    institution: number;
  } | null>(null);
  const [constituent, setConstituent] = useState<ConstituentTarget | null>(null);

  const loadOwn = useCallback(() => {
    void api.briefingHeat().then(setHeat).catch(() => undefined);
    void api
      .futuresFlow(1)
      .then((r) => setFutFlow(r.days[r.days.length - 1] ?? null))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    loadOwn();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") loadOwn();
    }, 60_000);
    return () => clearInterval(t);
  }, [loadOwn]);

  return (
    <div className="bf">
      <div className="ib-row3">
        <div className="ib-sec">
          <div className="ib-sec-t">오늘 수급</div>
          <FlowBars flow={flow.data ?? null} futures={futFlow} futPrice={futPrice} />
        </div>
        <div className="ib-sec">
          <div className="ib-sec-t">테마</div>
          <ThemeStrip
            themes={themes.data ?? null}
            onPickTheme={(t) => setConstituent({ kind: "theme", code: t.code, name: t.name })}
          />
        </div>
        {/* 히트맵이 제일 넓다 — 두 몫 (ib-sec-idx 는 「넓은 섹션」 클래스로 같이 쓴다) */}
        <div className="ib-sec ib-sec-idx">
          <div className="ib-sec-t">관심종목</div>
          <WatchHeatGrid heat={heat} onSelectStock={onSelectStock} />
        </div>
      </div>
      {constituent && (
        <ConstituentSheet
          target={constituent}
          onClose={() => setConstituent(null)}
          onSelectStock={(code, name) => {
            setConstituent(null);
            onSelectStock(code, name);
          }}
        />
      )}
    </div>
  );
}
