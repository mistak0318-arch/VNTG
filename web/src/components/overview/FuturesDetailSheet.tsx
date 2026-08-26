import { useEffect, useState } from "react";
import { api, fmtNum } from "../../api";
import { CandleChart } from "../CandleChart";
import { IntradayFlowChart } from "./IntradayFlowChart";

/**
 * 코스피200 선물(주간) 상세 (2026-08-26) — **코스피/코스닥 시트와 같은 골격.**
 *
 * 전에는 선물만 야후식 SVG 시트(기간 3개월/1년/3년)라 코스피를 보다 선물을 열면
 * 화면 문법이 바뀌었다(사용자 지적). 지수 시트와 똑같이 간다:
 *   일/주/월 캔들(같은 CandleChart 모듈 — 이평·자물쇠·키보드까지 동일)
 *   → 장중 수급 변화(누적 곡선) → 오늘 투자자별 수급(콤팩트)
 *   → 수급 합산 → 일별 수급 표.
 *
 * 수급 출처는 네이버(sosok=03, 계약)다 — 키움·한투에 선물 투자자별이 없다(실측).
 * 억원 환산은 계약 × 지수 × 25만원. 추정임은 툴팁에 적는다 — 값 앞 물결(≈)은
 * 「알고 있으니 지우라」는 지정으로 뺐다.
 */

export interface FuturesDetailTarget {
  /** 월물 코드 (예: A01609) */
  code: string;
  name: string;
  price: number;
  changeRate: number;
  basis: number | null;
  openInterest: number | null;
}

const RANGES: { key: "D" | "W" | "M"; label: string; days: number }[] = [
  { key: "D", label: "일", days: 130 },
  { key: "W", label: "주", days: 500 },
  { key: "M", label: "월", days: 800 },
];

function sign(v: number): string {
  return v > 0 ? "positive" : v < 0 ? "negative" : "";
}

export function FuturesDetailSheet({
  target,
  onClose,
}: {
  target: FuturesDetailTarget;
  onClose: () => void;
}) {
  const [range, setRange] = useState<"D" | "W" | "M">("D");
  const [candles, setCandles] = useState<
    { t: string; open: number; high: number; low: number; close: number; volume: number }[]
  >([]);
  const [chartErr, setChartErr] = useState<string | null>(null);
  const [flow, setFlow] = useState<
    { date: string; individual: number; foreign: number; institution: number }[] | null
  >(null);

  useEffect(() => {
    let alive = true;
    setCandles([]);
    setChartErr(null);
    const spec = RANGES.find((r) => r.key === range) ?? RANGES[0];
    api
      .futuresChart(target.code, range, spec.days, "F")
      .then((r) => {
        if (!alive) return;
        setCandles(r.candles);
        setChartErr(r.error);
      })
      .catch((e: Error) => alive && setChartErr(e.message));
    return () => {
      alive = false;
    };
  }, [target.code, range]);

  useEffect(() => {
    let alive = true;
    api
      .futuresFlow(30)
      .then((r) => alive && setFlow(r.days))
      .catch(() => alive && setFlow([]));
    return () => {
      alive = false;
    };
  }, []);

  const last = flow?.[flow.length - 1];
  /** 계약 → 억원 환산 (지수 × 25만원). 평균 체결가가 아니라 현재가라 추정치다 */
  const eok = (n: number) =>
    target.price > 0 ? `${n > 0 ? "+" : ""}${fmtNum(Math.round((n * target.price) / 400))}` : "-";
  const sum = (k: "individual" | "foreign" | "institution", n: number) =>
    (flow ?? []).slice(-n).reduce((a, d) => a + d[k], 0);
  /*
   * 표 칸 — **금액(억)이 주인공, 계약은 괄호** (2026-08-27 "금액(계약) 이렇게").
   * 지수 수급(억원)과 같은 눈으로 견주는 게 우선이라는 타일 결정과 같은 문법.
   * 지수값을 못 받았으면(환산 불가) 계약만 적는다.
   */
  const amtCell = (v: number) =>
    target.price > 0 ? (
      <>
        {eok(v)}
        <i className="fut-ct">({fmtNum(v)})</i>
      </>
    ) : (
      <>{fmtNum(v)}</>
    );

  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet idx-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-header">
          <h2>
            코스피200 선물 (주간)
            <span className={`sheet-sub ${sign(target.changeRate)}`}>
              {fmtNum(target.price)} ({target.changeRate > 0 ? "+" : ""}
              {target.changeRate.toFixed(2)}%)
            </span>
          </h2>
          <button className="close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="filter-row">
          {RANGES.map((r) => (
            <button
              key={r.key}
              className={`filter-btn ${range === r.key ? "active" : ""}`}
              onClick={() => setRange(r.key)}
            >
              {r.label}
            </button>
          ))}
          <span className="pt-n">{target.name}</span>
          {/* 베이시스·미결제 — 지수엔 없는 선물만의 값이라 기간 줄 옆에 붙인다 */}
          {target.basis != null && (
            <span
              className={`ov-basis ${target.basis < 0 ? "negative" : "positive"}`}
              title="선물 − 코스피200. 음수(백워데이션)면 선물이 현물보다 싸다 — 약세 심리"
            >
              베이시스 {target.basis > 0 ? "+" : ""}
              {target.basis.toFixed(2)}
            </span>
          )}
          {target.openInterest != null && (
            <span className="pt-n">미결제 {fmtNum(target.openInterest)}계약</span>
          )}
        </div>

        {chartErr && <div className="error-banner">{chartErr}</div>}
        {candles.length === 0 && !chartErr && <div className="page-note">불러오는 중…</div>}

        {/* 지수 시트와 같은 캔들 모듈 — 이평·자물쇠·키보드(+/−·←/→)가 그대로 따라온다 */}
        {candles.length > 1 && (
          <CandleChart
            name="코스피200 선물"
            showExtremes
            candles={candles.map((c) => ({
              time: {
                year: Number(c.t.slice(0, 4)),
                month: Number(c.t.slice(5, 7)),
                day: Number(c.t.slice(8, 10)),
              },
              open: c.open,
              high: c.high,
              low: c.low,
              close: c.close,
              volume: c.volume,
            }))}
          />
        )}

        {/* 장중 수급 변화 — 지수 시트와 같은 자리·같은 그림. 선물은 계약 단위 */}
        <IntradayFlowChart market="03" unit="계약" />

        {/* 오늘 투자자별 수급 — 지수 시트의 콤팩트 한 덩이와 같은 모양 */}
        {last && (
          <>
            <h3 className="idx-h3">
              {last.date.slice(5).replace("-", "/")} 투자자별 순매수{" "}
              <span className="pt-n" title="큰 값은 억원 환산(계약 × 지수 × 25만원, 추정) · 작은 값이 원본 계약">
                억원 환산 · 아래 계약
              </span>
            </h3>
            <div className="ifc num">
              <div className="ifc-main">
                {(
                  [
                    { label: "개인", v: last.individual },
                    { label: "외국인", v: last.foreign },
                    { label: "기관", v: last.institution },
                  ] as const
                ).map((m) => (
                  <div className="ifc-cell" key={m.label}>
                    <span className="ifc-lbl">{m.label}</span>
                    <b className={sign(m.v)}>{eok(m.v)}</b>
                    <span className="ifc-sub-line">
                      {m.v > 0 ? "+" : ""}
                      {fmtNum(m.v)}계약
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* 수급 합산 — 지수 시트의 5/10/20/60일과 같은 문법. 자료가 30일치라 30까지 */}
        <h3 className="idx-h3">
          수급 합산{" "}
          <span className="pt-n" title="큰 값은 억원 환산(계약 × 지수 × 25만원, 추정) · 괄호가 원본 계약">
            억원 환산 · (계약)
          </span>
        </h3>
        {flow && flow.length > 0 && (
          <div className="data-table-wrap">
            <table className="data-table num idx-sum">
              <thead>
                <tr>
                  <th className="sticky-col">기간</th>
                  <th>개인</th>
                  <th>외국인</th>
                  <th>기관</th>
                </tr>
              </thead>
              <tbody>
                {[5, 10, 20, 30].map((n) => {
                  const enough = (flow?.length ?? 0) >= n;
                  return (
                    <tr key={n} className={enough ? "" : "idx-sum-short"}>
                      <td className="sticky-col">
                        {n}일
                        {!enough && <span className="pt-n"> ({flow.length}일치뿐)</span>}
                      </td>
                      {(["individual", "foreign", "institution"] as const).map((k) => {
                        const v = sum(k, n);
                        return (
                          <td className={sign(v)} key={k}>
                            {enough ? amtCell(v) : "-"}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <h3 className="idx-h3">
          일별 수급{" "}
          <span className="pt-n" title="큰 값은 억원 환산(계약 × 지수 × 25만원, 추정) · 괄호가 원본 계약">
            억원 환산 · (계약)
          </span>
        </h3>
        {flow === null && <div className="empty">수급 불러오는 중…</div>}
        {flow !== null && flow.length === 0 && (
          <div className="empty">선물 수급을 받지 못했습니다.</div>
        )}
        {flow !== null && flow.length > 0 && (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="sticky-col">일자</th>
                  <th>개인</th>
                  <th>외국인</th>
                  <th>기관</th>
                </tr>
              </thead>
              <tbody>
                {[...flow].reverse().map((d) => (
                  <tr key={d.date}>
                    <td className="sticky-col">{d.date.slice(5)}</td>
                    <td className={sign(d.individual)}>{amtCell(d.individual)}</td>
                    <td className={sign(d.foreign)}>{amtCell(d.foreign)}</td>
                    <td className={sign(d.institution)}>{amtCell(d.institution)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="table-note">
          차트는 한투 기간별시세(주간 선물), 수급은 네이버 투자자별 매매동향(계약, ±10분
          지연)입니다. <b>베이시스</b> = 선물 − 현물: 양수(콘탱고)면 프로그램 매수,
          음수(백워데이션)면 프로그램 매도가 붙기 쉽습니다. <b>미결제약정</b>은 살아 있는
          계약 수 — 오르며 늘면 새 돈이 들어오는 추세, 오르며 줄면 숏 청산 반등입니다.
        </div>
      </div>
    </div>
  );
}
