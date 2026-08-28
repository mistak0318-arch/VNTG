import { useCallback, useEffect, useState } from "react";
import { api, type MarketLens, type RotationTheme } from "../api";
import { ConstituentSheet, type ConstituentTarget } from "./overview/ConstituentSheet";

/**
 * 시장 렌즈 — **체온계와 로테이션을 그리는 쪽.** (2026-08-28)
 *
 * 계산은 전부 서버(marketLens.ts)가 하고, 여기는 세 가지 모양으로 그리기만 한다:
 *   - ThermoPanel — 체온계 전체 (요약 칩 + 40일 시계열)
 *   - RotationBoard — 로테이션 판 전체 (주도 지속 / 신규 부상 / 주도 휴식 세 기둥)
 *   - RotationStrip — 한 줄 요약 (브리핑·장전·리포트에 꽂는 압축판)
 *
 * 여러 화면이 같은 렌즈를 나눠 보므로 **같은 컴포넌트**여야 한다 — 화면마다
 * 다시 그리면 문턱 하나 바꿀 때마다 세 군데가 어긋난다.
 */

export function useMarketLens(): {
  lens: MarketLens | null;
  error: string | null;
  reload: () => void;
} {
  const [lens, setLens] = useState<MarketLens | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    api
      .marketLens()
      .then((r) => {
        setLens(r);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(reload, [reload]);
  return { lens, error, reload };
}

function pct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

function cls(v: number | null | undefined): string {
  if (v === null || v === undefined || v === 0) return "";
  return v > 0 ? "positive" : "negative";
}

/* ------------------------------------------------------------------ */
/* 체온계                                                              */
/* ------------------------------------------------------------------ */

/** 비율(%) 시계열 하나 — 50% 기준선을 같이 긋는다 */
function RatioSpark({ data, mid }: { data: number[]; mid?: number }) {
  const W = 300;
  const H = 56;
  if (data.length < 2) return <span className="pt-n">아직 없음</span>;
  const min = Math.min(...data, mid ?? Infinity);
  const max = Math.max(...data, mid ?? -Infinity);
  const span = max - min || 1;
  const y = (v: number) => H - 4 - ((v - min) / span) * (H - 8);
  const x = (i: number) => (i / (data.length - 1)) * W;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="lens-spark" preserveAspectRatio="none">
      {mid !== undefined && mid >= min && mid <= max && (
        <line x1={0} y1={y(mid)} x2={W} y2={y(mid)} className="lens-mid" />
      )}
      <path
        d={data.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}
        fill="none"
        className="lens-line"
      />
    </svg>
  );
}

/**
 * 체온 요약 칩 — 판 전체 없이 **한 줄**만 필요할 때 (브리핑 상황실 머리 등).
 * ThermoPanel 도 같은 것을 쓴다 — 두 벌이면 언젠가 다른 말을 한다.
 */
export function ThermoChips({
  lens,
  showSample = false,
}: {
  lens: MarketLens | null;
  showSample?: boolean;
}) {
  if (!lens || lens.thermo.stocks === 0) return null;
  const t = lens.thermo;
  const last = (a: number[]) => (a.length > 0 ? a[a.length - 1] : null);
  const hi = last(t.series.high60);
  const lo = last(t.series.low60);
  return (
    <div className="lens-chips">
      {t.riseNow !== null && (
        <span className="lens-chip">
          지금 상승 <b className={t.riseNow >= 50 ? "positive" : "negative"}>{t.riseNow}%</b>
        </span>
      )}
      <span className="lens-chip">
        20일선 위{" "}
        <b className={(last(t.series.above20) ?? 0) >= 50 ? "positive" : "negative"}>
          {pct(last(t.series.above20), 1).replace("+", "")}
        </b>
        <i>어제 마감</i>
      </span>
      {hi !== null && lo !== null && (
        <span className="lens-chip">
          60일 신고−신저{" "}
          <b className={hi - lo > 0 ? "positive" : "negative"}>
            {hi - lo > 0 ? "+" : ""}
            {hi - lo}
          </b>
          <i>
            ▲{hi} ▼{lo}
          </i>
        </span>
      )}
      {showSample && (
        <span className="lens-chip">
          표본 <b>{t.stocks.toLocaleString("ko-KR")}종목</b>
        </span>
      )}
    </div>
  );
}

export function ThermoPanel({ lens: given }: { lens?: MarketLens | null } = {}) {
  /* 이미 받아 둔 렌즈가 있으면 그걸 쓴다 — 한 화면에서 두 번 받을 이유가 없다 */
  const own = useMarketLens();
  const lens = given !== undefined ? given : own.lens;
  const error = given !== undefined ? null : own.error;
  if (error) return <div className="error-banner">{error}</div>;
  if (!lens) return <div className="empty">불러오는 중…</div>;
  const t = lens.thermo;
  if (t.stocks === 0) {
    return (
      <div className="page-note">
        일봉 캐시가 아직 없습니다 — 서버가 하루 한 번(첫 배포 직후 포함) 전종목 일봉을 받으면
        여기부터 40일치 체온이 소급해서 나옵니다.
      </div>
    );
  }
  const last = (a: number[]) => (a.length > 0 ? a[a.length - 1] : null);
  const hi = last(t.series.high60);
  const lo = last(t.series.low60);
  return (
    <div className="lens-thermo">
      {/*
        요약 칩 셋 — 지수 없이 장의 체온을 말하는 최소 숫자.
        「지금 상승」은 스냅샷(전종목·장중), 나머지는 일봉 캐시(어제 마감) 기준이라
        기준 시점이 다르다 — 칩에 그대로 적는다. 섞어 놓고 침묵하면 거짓말이 된다.
      */}
      <ThermoChips lens={lens} showSample />

      <div className="lens-sparks">
        <div className="lens-spark-box">
          <span className="lens-spark-h">일일 상승 비율 (40일)</span>
          <RatioSpark data={t.series.rise} mid={50} />
        </div>
        <div className="lens-spark-box">
          <span className="lens-spark-h">20일선 위 비율 (40일)</span>
          <RatioSpark data={t.series.above20} mid={50} />
        </div>
      </div>
      <div className="table-note">
        지수가 아니라 <b>종목들</b>입니다 — 일봉 캐시 {t.stocks.toLocaleString("ko-KR")}종목으로
        계산합니다. 20일선 위 비율이 50%를 넘어 유지되면 장이 넓게 사는 중이고, 지수는 오르는데
        이 값이 내리면 몇몇 대형주가 끄는 좁은 장입니다. 신고−신저는 캐시가 70일이라 최근
        열흘치만 나옵니다.
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 로테이션                                                            */
/* ------------------------------------------------------------------ */

const BUCKETS = [
  {
    key: "lead" as const,
    label: "🏃 주도 지속",
    hint: "한 달을 끌어 왔고 오늘도 오른다 — 이어달리기",
  },
  {
    key: "fresh" as const,
    label: "🌱 신규 부상",
    hint: "한 달은 조용했는데 오늘 크게 튄다 — 자리바꿈의 입구",
  },
  {
    key: "rest" as const,
    label: "😮‍💨 주도 휴식",
    hint: "한 달을 끌었는데 오늘 쉰다 — 눌림인지 이탈인지 지켜볼 곳",
  },
];

function ThemeChipRow({
  t,
  onOpen,
}: {
  t: RotationTheme;
  onOpen: (t: RotationTheme) => void;
}) {
  return (
    <button className="lens-theme" onClick={() => onOpen(t)} title={`${t.name} 구성종목 보기`}>
      <span className="lens-theme-name">{t.name}</span>
      <b className={`num ${cls(t.changeRate)}`}>{pct(t.changeRate)}</b>
      <span className="lens-theme-sub">
        월간 <i className={cls(t.m1)}>{pct(t.m1, 0)}</i>
        {t.streak >= 2 && <em className="lens-streak">{t.streak}일↑</em>}
        {t.hit10.of >= 7 && t.hit10.n >= 7 && <em className="lens-streak">10일 중 {t.hit10.n}</em>}
      </span>
    </button>
  );
}

export function RotationBoard({
  onSelectStock,
}: {
  onSelectStock?: (code: string, name: string) => void;
}) {
  const { lens, error } = useMarketLens();
  const [sheet, setSheet] = useState<ConstituentTarget | null>(null);
  if (error) return <div className="error-banner">{error}</div>;
  if (!lens) return <div className="empty">불러오는 중…</div>;
  const r = lens.rotation;
  if (!r.ready) {
    return (
      <div className="page-note">
        월간 누적이 아직 없어 로테이션을 나눌 수 없습니다 — 일봉 캐시가 한 번 돌면
        (하루 1회 자동) 바로 나옵니다.
      </div>
    );
  }
  const open = (t: RotationTheme) =>
    setSheet({ kind: "theme", code: t.key, name: t.name });
  return (
    <div className="lens-rotation">
      <div className="lens-buckets">
        {BUCKETS.map((b) => (
          <section className={`lens-bucket ${b.key}`} key={b.key}>
            <div className="lens-bucket-h">
              <b>{b.label}</b>
              <small>{b.hint}</small>
            </div>
            {r[b.key].length === 0 ? (
              <div className="empty">해당 없음</div>
            ) : (
              r[b.key].map((t) => <ThemeChipRow t={t} key={t.key} onOpen={open} />)
            )}
          </section>
        ))}
      </div>
      <div className="table-note">
        거래대금 300억 이상 테마 {r.universe}개를 <b>오늘 × 한 달 누적</b>으로 나눕니다.
        읽는 법: 주도 지속이 두껍고 신규 부상이 얇으면 기존 주도가 이어지는 장, 신규 부상이
        갑자기 두꺼워지면 자리바꿈이 시작된 장입니다. 주도 휴식이 이틀을 넘기면 눌림이 아니라
        이탈을 의심하세요. 테마를 누르면 구성종목이 열립니다.
      </div>

      {sheet && (
        <ConstituentSheet
          target={sheet}
          onClose={() => setSheet(null)}
          onSelectStock={(code, name) => {
            setSheet(null);
            onSelectStock?.(code, name);
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 압축판 — 브리핑·장전·리포트에 꽂는 몇 줄                                */
/* ------------------------------------------------------------------ */

export function RotationStrip({
  lens,
  onSelectStock,
}: {
  /** 이미 받아 둔 렌즈가 있으면 넘긴다 — 없으면 스스로 받는다 */
  lens?: MarketLens | null;
  onSelectStock?: (code: string, name: string) => void;
}) {
  const own = useMarketLens();
  const use = lens !== undefined ? lens : own.lens;
  const [sheet, setSheet] = useState<ConstituentTarget | null>(null);
  if (!use || !use.rotation.ready) return null;
  const r = use.rotation;
  const row = (label: string, items: RotationTheme[]) =>
    items.length > 0 && (
      <div className="lens-strip-row">
        <i>{label}</i>
        {items.slice(0, 3).map((t) => (
          <button
            key={t.key}
            className="lens-strip-theme"
            onClick={() => setSheet({ kind: "theme", code: t.key, name: t.name })}
          >
            {t.name} <b className={cls(t.changeRate)}>{pct(t.changeRate)}</b>
          </button>
        ))}
      </div>
    );
  return (
    <div className="lens-strip">
      {row("🏃 주도", r.lead)}
      {row("🌱 부상", r.fresh)}
      {row("😮‍💨 휴식", r.rest)}
      {sheet && (
        <ConstituentSheet
          target={sheet}
          onClose={() => setSheet(null)}
          onSelectStock={(code, name) => {
            setSheet(null);
            onSelectStock?.(code, name);
          }}
        />
      )}
    </div>
  );
}
