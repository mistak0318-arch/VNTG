import { useEffect, useState } from "react";
import { TopScrollTable } from "../TopScrollTable";
import { useSheetBack } from "../../useSheetBack";
import { api, fmtNum } from "../../api";
import { useLoadWatch } from "../../loadWatch";
import { CandleChart } from "../CandleChart";
import { IntradayFlowChart } from "./IntradayFlowChart";
import { OhlcStrip } from "./OhlcStrip";
import { IndexAnalysis, type DailyPt, type LooseFlow } from "./IndexAnalysis";

function todayIso(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

/**
 * 코스피200 선물(주간거래) 상세 (2026-08-26) — **코스피/코스닥 시트와 같은 골격.**
 *
 * ⚠️ 「주간」은 週가 아니라 **낮 장**이다(야간선물과 가르는 말). 2026-09-22 에 「주간거래」로
 * 고쳤다 — 바로 아래 일/주/월 단추 때문에 주(週) 봉으로 읽혔다.
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
  /* 뒤로가기로 닫힌다 — 폰에서 시트를 열고 뒤로 누르면 페이지가 넘어갔다 (2026-08-28) */
  useSheetBack(true, onClose);
  const [range, setRange] = useState<"D" | "W" | "M">("D");
  const [candles, setCandles] = useState<
    { t: string; open: number; high: number; low: number; close: number; volume: number }[]
  >([]);
  const [chartErr, setChartErr] = useState<string | null>(null);
  const [flow, setFlow] = useState<
    { date: string; individual: number; foreign: number; institution: number }[] | null
  >(null);
  /** 오늘 봉 (2026-09-03) — 일봉의 마지막 봉. 주·월로 바꿔도 남는다 */
  const [day, setDay] = useState<{ t: string; open: number; high: number; low: number; close: number; prevClose: number | null } | null>(null);

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
        if (range === "D" && r.candles.length >= 1) {
          const c = r.candles[r.candles.length - 1];
          const p = r.candles[r.candles.length - 2];
          setDay({ t: c.t, open: c.open, high: c.high, low: c.low, close: c.close, prevClose: p?.close ?? null });
        }
      })
      .catch((e: Error) => alive && setChartErr(e.message));
    return () => {
      alive = false;
    };
  }, [target.code, range]);

  /*
   * **실패 사유를 버리지 않는다** (2026-09-22 — 벤티지: "이거 바로 안나오면 … 왜 안나오는지
   * 로딩 걸린이유 좀 알려줄수있어?").
   *
   * 예전엔 `catch(() => setFlow([]))` 였다. 그러면 화면에는 「선물 수급을 받지 못했습니다」만
   * 남고 **왜인지가 통째로 사라진다** — 서버가 죽은 것인지, 네이버가 막은 것인지, 그냥 느린
   * 것인지 구분이 안 됐다. 사유를 들고 있다가 그 자리에 적고 토스트로도 알린다.
   */
  const [flowErr, setFlowErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setFlowErr(null);
    api
      .futuresFlow(30)
      .then((r) => alive && setFlow(r.days))
      .catch((e: Error) => {
        if (!alive) return;
        setFlowErr(e.message || "알 수 없는 까닭");
        setFlow([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  /* 느리면 그 자리에 초를 적고, 문턱을 넘기면 토스트로 한 번 알린다 */
  const chartNote = useLoadWatch("선물 차트", candles.length === 0 && !chartErr, chartErr);
  const flowNote = useLoadWatch("선물 수급", flow === null, flowErr);

  const last = flow?.[flow.length - 1];

  /*
   * **분석** 서브탭 (2026-09-07) — 코스피·미국 지수 시트와 같은 부품.
   * 분석은 늘 일봉으로 잰다(위의 일/주/월과 무관). 수급은 네이버의 세 주체(계약)라
   * 기관 속살은 없다 — 그래서 `fewSubjects`. 등락률은 일봉에서 그날 종가 대비로 센다.
   */
  const [sub, setSub] = useState<"overview" | "analysis">("overview");
  const [anaDaily, setAnaDaily] = useState<DailyPt[] | null>(null);
  useEffect(() => {
    if (sub !== "analysis") return;
    let alive = true;
    setAnaDaily(null);
    api
      .futuresChart(target.code, "D", 300, "F")
      .then((r) => alive && setAnaDaily(r.candles.map((c) => ({ d: c.t.slice(0, 10), close: c.close })).filter((c) => c.close > 0)))
      .catch(() => alive && setAnaDaily([]));
    return () => {
      alive = false;
    };
  }, [sub, target.code]);
  const anaFlows: LooseFlow[] | undefined = (() => {
    if (!flow || !anaDaily) return undefined;
    const closeAt = new Map(anaDaily.map((d, i) => [d.d, { c: d.close, p: anaDaily[i - 1]?.close ?? null }]));
    return [...flow]
      .reverse()
      .map((f) => {
        const k = closeAt.get(f.date);
        const changeRate = k && k.p ? ((k.c - k.p) / k.p) * 100 : 0;
        return { date: f.date, changeRate, individual: f.individual, foreign: f.foreign, institution: f.institution };
      });
  })();
  /* 2026-09-18 부터 수급은 네이버 새 API 의 **억원 그대로** — 옛 「계약 × 지수 × 25만원」 환산은 뺐다(키움 앱과 같은 단위) */
  const eok = (n: number) => `${n > 0 ? "+" : ""}${fmtNum(n)}`;
  const sum = (k: "individual" | "foreign" | "institution", n: number) =>
    (flow ?? []).slice(-n).reduce((a, d) => a + d[k], 0);
  /*
   * 표 칸 — **금액(억)이 주인공, 계약은 괄호** (2026-08-27 "금액(계약) 이렇게").
   * 지수 수급(억원)과 같은 눈으로 견주는 게 우선이라는 타일 결정과 같은 문법.
   * 지수값을 못 받았으면(환산 불가) 계약만 적는다.
   */
  /* 2026-09-18 단위가 억원으로 바뀌며 환산 갈래가 사라졌다 — 죽은 삼항을 지운다 (09-21 회귀 점검) */
  const amtCell = (v: number) => <>{eok(v)}</>;

  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet idx-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-header">
          <h2>
            {/*
              **「주간」이 헷갈린다** (2026-09-22 — 벤티지: "코스피 200선물 저 타이틀이 맞아?").
              뜻 자체는 맞았다 — 야간선물(`globalMarket.ts` 의 nightFutures)과 가르려고 붙인
              **주간거래(낮 장)** 다. 그런데 바로 아래 줄에 일/주/월 단추가 있어서 「주(週) 봉」으로
              읽힌다. 「거래」를 붙이면 그 오독이 사라진다 — 업계에서 쓰는 말 그대로다.
            */}
            코스피200 선물{" "}
            <span className="sheet-sub" title="주간거래(낮 장) 기준입니다. 미국장 시간대에 도는 야간선물과는 다른 값입니다">
              주간거래
            </span>
            <span className={`sheet-sub ${sign(target.changeRate)}`}>
              {fmtNum(target.price)} ({target.changeRate > 0 ? "+" : ""}
              {target.changeRate.toFixed(2)}%)
            </span>
          </h2>
          <button className="close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* 당일 시·고·저·현재가 (2026-09-03). 현재가는 목록이 준 지금 값 — 일봉 종가는 몇 분 늦다 */}
        {day && (
          <OhlcStrip
            label={day.t.slice(0, 10) === todayIso() ? "오늘" : `${day.t.slice(5, 10).replace("-", "/")} (마지막 거래일)`}
            open={day.open}
            high={day.high}
            low={day.low}
            close={day.t.slice(0, 10) === todayIso() && target.price > 0 ? target.price : day.close}
            prevClose={day.prevClose}
            closeLabel={day.t.slice(0, 10) === todayIso() ? "현재가" : "종가"}
          />
        )}

        <nav className="detail-tabs idx-sub">
          <button className={`detail-tab${sub === "overview" ? " active" : ""}`} onClick={() => setSub("overview")}>
            개요
          </button>
          <button
            className={`detail-tab${sub === "analysis" ? " active" : ""}`}
            onClick={() => setSub("analysis")}
            title="자리(이동평균·고점·연속)와 흐름, 세 주체의 누적·연속·상관 (계약)"
          >
            🔎 분석
          </button>
        </nav>

        {sub === "analysis" && (
          anaDaily === null ? (
            <div className="page-note">분석할 일봉을 받는 중…</div>
          ) : (
            <IndexAnalysis name="코스피200 선물" daily={anaDaily} flows={anaFlows} unit="" flowUnit="억원" fewSubjects />
          )
        )}

        {sub === "overview" && (
        <>
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

        {chartErr && <div className="error-banner">차트를 못 받았습니다 — {chartErr}</div>}
        {candles.length === 0 && !chartErr && (
          <div className="page-note">불러오는 중…{chartNote ? ` ${chartNote}` : ""}</div>
        )}

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

        {/* 장중 수급 변화 — 지수 시트와 같은 자리·같은 그림. 선물도 억원(네이버 새 API) */}
        <IntradayFlowChart market="03" unit="억원" />

        {/* 오늘 투자자별 수급 — 지수 시트의 콤팩트 한 덩이와 같은 모양 */}
        {last && (
          <>
            <h3 className="idx-h3">
              {last.date.slice(5).replace("-", "/")} 투자자별 순매수{" "}
              <span className="pt-n" title="네이버 투자자별 매매동향 — 키움 앱 선물 수급과 같은 억원">
                억원
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
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* 수급 합산 — 지수 시트의 5/10/20/60일과 같은 문법. 자료가 30일치라 30까지 */}
        <h3 className="idx-h3">
          수급 합산{" "}
          <span className="pt-n" title="억원 — 9/18 부터 쌓인 날만">
            억원
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
          <span className="pt-n" title="억원 — 네이버 새 API 는 오늘 값만 주므로 9/18 부터 우리가 날마다 쌓는다">
            억원 · 9/18 부터
          </span>
        </h3>
        {flow === null && <div className="empty">수급 불러오는 중…{flowNote ? ` ${flowNote}` : ""}</div>}
        {flow !== null && flow.length === 0 && (
          <div className="empty">
            선물 수급을 받지 못했습니다{flowErr ? ` — ${flowErr}` : " — 서버가 빈 목록을 줬습니다(네이버 쪽이 막혔을 수 있습니다)"}.
          </div>
        )}
        {flow !== null && flow.length > 0 && (
          <TopScrollTable>
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
          </TopScrollTable>
        )}

        <div className="table-note">
          {/* 「주간 선물」 → 「주간거래 선물」 + 월물 이름 (2026-09-22) — 위 제목과 같은 이유 */}
          차트는 한투 기간별시세(주간거래 선물 · {target.name}), 수급은 네이버 투자자별 매매동향(억원, ±10분
          지연 — 9/18 부터 날마다 쌓임)입니다. <b>베이시스</b> = 선물 − 현물: 양수(콘탱고)면 프로그램 매수,
          음수(백워데이션)면 프로그램 매도가 붙기 쉽습니다. <b>미결제약정</b>은 살아 있는
          계약 수 — 오르며 늘면 새 돈이 들어오는 추세, 오르며 줄면 숏 청산 반등입니다.
        </div>
        </>
        )}
      </div>
    </div>
  );
}
