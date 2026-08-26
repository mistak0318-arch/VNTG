import { Fragment, useCallback, useEffect, useState } from "react";
import {
  api,
  fmtNum,
  type BriefingTile,
  type IndexCandle,
  type IndexCard,
  type MarketFlow,
  type ThemeRow,
} from "../api";
import { useSection } from "../useSection";
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
}: {
  flow: MarketFlow | null;
  futures: { individual: number; foreign: number; institution: number } | null;
}) {
  if (!flow) return <div className="empty">수급을 아직 못 받았습니다.</div>;
  const rows = [
    { label: "코스피", f: flow.kospi, unit: "억" },
    { label: "코스닥", f: flow.kosdaq, unit: "억" },
    ...(futures ? [{ label: "선물", f: futures, unit: "계약" }] : []),
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
        {rows.map(({ label, f, unit }) => {
          /* 행별 최대로 잰다 — 억(현물)과 계약(선물)은 단위가 달라 같이 재면 안 된다 */
          const max = Math.max(1, ...[f.individual, f.foreign, f.institution].map(Math.abs));
          return (
            <Fragment key={label}>
              <em className="bf-supply-m">{label}</em>
              {[f.individual, f.foreign, f.institution].map((v, i) => (
                <span className="bf-supply-cell" key={i}>
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
        {twin} · 선물은 K200 지수선물(계약) · 기관 세부는 종목 화면에서 봅니다
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
  if (rows.length === 0) return <div className="empty">등락현황을 아직 못 받았습니다.</div>;
  return (
    <div className="bf-updown">
      {rows.map((c) => {
        const total = Math.max(1, c.rising + c.flat + c.falling);
        const w = (n: number) => `${(n / total) * 100}%`;
        return (
          <div className="bf-ud-row" key={c.code}>
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
          </div>
        );
      })}
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
    { name: string; today: number; vsPrev: number | null; vsAvg: number | null }[] | null
  >(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const out: { name: string; today: number; vsPrev: number | null; vsAvg: number | null }[] = [];
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
        <div className="bf-ud-row" key={r.name}>
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
        </div>
      ))}
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
  if (heat === null) return <div className="empty">불러오는 중…</div>;
  if (heat.tiles.length === 0) return <div className="empty">관심종목이 비어 있습니다.</div>;
  return (
    <>
      <div className="bf-heat">
        {heat.tiles.map((t) => {
          const r = t.rate ?? 0;
          /* 진하기 = 등락 크기. ±3% 를 최대로 — 그 위는 색으로 더 말할 게 없다 */
          const alpha = Math.min(1, Math.abs(r) / 3) * 0.55 + 0.1;
          return (
            <button
              key={t.code}
              className="bf-tile"
              style={{
                background:
                  r > 0
                    ? `rgba(255,92,92,${alpha})`
                    : r < 0
                      ? `rgba(76,141,255,${alpha})`
                      : undefined,
              }}
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
          <FlowBars flow={flow.data ?? null} futures={futFlow} />
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
