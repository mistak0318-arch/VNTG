import { useEffect, useState } from "react";
import { useSheetBack } from "../../useSheetBack";
import { api, fmtNum, type IndexDetailData, type IndexRange, type MarketFlow } from "../../api";
import { CandleChart } from "../CandleChart";
import { IntradayFlowChart } from "./IntradayFlowChart";
import { useSection } from "../../useSection";

/**
 * 코스피·코스닥 상세.
 *
 * 대시보드 카드는 오늘 하루만 말해 준다. 그런데 "지금 이 자리가 어디인가"는 **추이를 봐야**
 * 답이 나온다 — 20일선을 뚫고 올라온 것과 고점에서 흘러내리는 중인 것이 같은 +1.2% 로 보인다.
 *
 * 개별 종목에는 일봉·주봉·월봉이 이미 있는데 정작 지수에는 없었다. 거꾸로였다.
 */

const RANGES: { key: IndexRange; label: string }[] = [
  { key: "day", label: "일" },
  { key: "week", label: "주" },
  { key: "month", label: "월" },
];

/** 화면에 몇 개까지 그릴지 — 600개를 다 그리면 최근 움직임이 안 보인다 */
const SHOW = { day: 120, week: 104, month: 60 } as const;

function sign(v: number): string {
  return v > 0 ? "positive" : v < 0 ? "negative" : "";
}

/**
 * 아래 두 표(합산·일별)가 쓰는 **열두 주체** (2026-08-31 — "지수 수급 전체
 * 표시하라고 했더니 위에 한줄로만 했구나 아래 표도 채워야지").
 *
 * 위쪽 한 줄은 그날 조회의 열두 주체를 다 썼는데 아래 두 표는 다섯·일곱뿐이었다 —
 * **같은 시트 안에서 위아래가 다른 주체를 보고** 있었다. 저장 스키마가 일곱뿐이라
 * 그랬고, 2026-08-31 에 다섯을 뒤에 붙였다.
 *
 * 순서는 위 한 줄과 **같다**: 큰손(개인·외국인·기관) → 기관 속살(금융투자·투신·
 * 연기금·사모·보험·은행·기타금융) → 나머지(국가·기타법인). 화면마다 순서가 다르면
 * 같은 자리를 볼 때마다 눈이 다시 맞춰야 한다.
 *
 * ⚠️ 뒤에 붙은 칸은 그 전 날짜에 **없다(null)** — "-" 로 적는다. 0 으로 채우면
 * 「안 샀다」로 읽혀 거짓이 된다.
 */
/** 표가 읽는 칸 — 숫자(또는 「모름」)인 것만 */
type FlowKey =
  | "individual"
  | "foreign"
  | "institution"
  | "securities"
  | "trust"
  | "pension"
  | "privateFund"
  | "insurance"
  | "bank"
  | "otherFinance"
  | "nation"
  | "otherCorp";

const FLOW_COLS: { key: FlowKey; label: string; hint?: string }[] = [
  { key: "individual", label: "개인" },
  { key: "foreign", label: "외국인" },
  { key: "institution", label: "기관" },
  { key: "securities", label: "금융투자", hint: "수집을 2026-08-27 시작해 그 전 날짜는 -" },
  { key: "trust", label: "투신" },
  { key: "pension", label: "연기금" },
  { key: "privateFund", label: "사모펀드" },
  { key: "insurance", label: "보험", hint: "수집을 2026-08-31 시작해 그 전 날짜는 -" },
  { key: "bank", label: "은행", hint: "수집을 2026-08-31 시작해 그 전 날짜는 -" },
  { key: "otherFinance", label: "기타금융", hint: "수집을 2026-08-31 시작해 그 전 날짜는 -" },
  { key: "nation", label: "국가", hint: "수집을 2026-08-31 시작해 그 전 날짜는 -" },
  { key: "otherCorp", label: "기타법인", hint: "수집을 2026-08-31 시작해 그 전 날짜는 -" },
];

export function IndexDetailSheet({ code, onClose }: { code: string; onClose: () => void }) {
  /* 뒤로가기로 닫힌다 — 폰에서 시트를 열고 뒤로 누르면 페이지가 넘어갔다 (2026-08-28) */
  useSheetBack(true, onClose);
  const [range, setRange] = useState<IndexRange>("day");
  const [data, setData] = useState<IndexDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  /*
   * 오늘 투자자별 수급 (2026-08-26) — 시황의 「수급」 탭을 숨기면서 그 막대가
   * 여기로 왔다. 대시보드와 같은 섹션(서버 캐시 공유)이라 추가 호출이 없다.
   */
  const flow = useSection<MarketFlow>("flow", 30_000);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    api
      .indexDetail(code, range)
      .then((d) => alive && setData(d))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [code, range]);

  const candles = (data?.candles ?? []).slice(-SHOW[range]);
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const diff = last && prev ? last.close - prev.close : 0;
  const rate = last && prev && prev.close > 0 ? (diff / prev.close) * 100 : 0;

  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet idx-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-header">
          <h2>
            {data?.name ?? (code === "101" ? "코스닥" : "코스피")}
            {last && (
              <span className={`sheet-sub ${sign(diff)}`}>
                {last.close.toFixed(2)} ({diff > 0 ? "+" : ""}
                {rate.toFixed(2)}%)
              </span>
            )}
          </h2>
          <button className="close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        {error && <div className="error-banner">{error}</div>}

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
          {data && <span className="pt-n">{candles.length}개</span>}
        </div>

        {!data && !error && <div className="page-note">불러오는 중…</div>}

        {/*
          **봉차트**다. 종가만 이으면 흐름은 보여도 **꼬리가 안 보인다** —
          아래로 길게 찔렀다 올라온 날과 그냥 오른 날은 완전히 다른 뜻인데
          선차트에서는 똑같이 생긴다. 개별 종목과 같은 컴포넌트를 쓴다.

          지수엔 거래량이 없어 0 을 넣는다 — 거래량 막대는 그려지지 않는다.
        */}
        {candles.length > 1 && (
          <CandleChart
            name={data?.name}
            showExtremes
            candles={candles.map((c) => ({
              time: {
                year: Number(c.dt.slice(0, 4)),
                month: Number(c.dt.slice(4, 6)),
                day: Number(c.dt.slice(6, 8)),
              },
              open: c.open,
              high: c.high,
              low: c.low,
              close: c.close,
              /* 거래대금(억원)을 막대로 — 지수가 오르는 날과 돈이 들어오는 날은 다르다 */
              volume: c.tradeValue,
            }))}
          />
        )}

        {/*
          일별 수급. 지수 그림 밑에 붙여야 뜻이 생긴다 —
          "이날 왜 빠졌나" 를 바로 아래에서 확인하게 된다.
        */}
        {/*
          **합산을 먼저 둔다.**

          일별만 늘어놓으면 "요즘 외국인이 사고 있나"를 사람이 눈으로 더해야 한다.
          개별종목 화면이 5·10·20·60일 합산을 주는데 지수에는 없어서, 같은 걸 보려면
          종목 화면으로 건너가야 했다. 여기서도 같은 잣대로 본다.

          쌓인 날이 모자라면 그 칸은 비운다 — 3일치로 낸 「20일 합산」은 거짓말이다.
        */}
        {/*
          장중 수급 변화 (2026-08-26 요청) — 일별 표 **위에**. 오늘 안에서 누가
          돌아섰는지는 일별 합계로는 안 보인다. 네이버 Time 누적 곡선.
        */}
        <IntradayFlowChart market={code === "101" ? "02" : "01"} unit="억원" />

        {/*
          오늘 투자자별 수급 — 장중 변화 곡선 **바로 밑**(2026-08-26 요청).
          곡선이 「어떻게 왔나」, 이건 「지금 누가 얼마나」다.
          가로 막대 열 줄은 시트에서 자리를 너무 먹었다(사용자 지적) — 큰 세 주체는
          세 칸 한 줄(값 + 미니 바), 기관 세부·기타는 칩 한 줄로 접는다.
        */}
        {(() => {
          const f = code === "101" ? flow.data?.kosdaq : flow.data?.kospi;
          if (!f) return null;
          /*
           * **종목 상세와 같은 묶음·같은 순서** (2026-08-31 — "수급주체가 얼마
           * 안보이니깐 답답하네 다 나열해서 보는걸로 하자. 국가, 기타법인, 이런거
           * 빠졌잖아 보험 이런거").
           *
           * 예전엔 일곱만 있었고 **기타금융·국가가 아예 빠져 있었다** — 서버는
           * 열한 주체를 다 주는데 화면이 안 쓰고 있었다. 같은 값을 두 화면이
           * 다르게 보여 주면 「어디 값이 맞나」가 된다.
           *
           * 묶음은 InvestorTrendTable 과 같다: 큰손(개인·외국인·기관계) →
           * 기관 속살(금융투자·투신·연기금·사모·보험·은행·기타금융) →
           * 나머지(국가·기타법인). 순서를 맞춰야 두 화면을 오갈 때 눈이 안 헤맨다.
           */
          const main = [
            { label: "개인", v: f.individual },
            { label: "외국인", v: f.foreign },
            { label: "기관", v: f.institution },
          ];
          /*
           * 기관 속살 — 종목 상세의 「기관 속살」 묶음과 같은 순서.
           * ⚠️ **0 이라고 빼지 않는다** (2026-08-31). 예전엔 걸러 냈는데, 그러면
           * 「국가가 0이다」와 「국가 칸이 없다」가 화면에서 안 갈린다 —
           * 0 도 답이다. 대신 흐리게 그린다.
           */
          const orgn = [
            { label: "금융투자", v: f.financialInvestment },
            { label: "투신", v: f.investmentTrust },
            { label: "연기금", v: f.pensionFund },
            { label: "사모펀드", v: f.privateFund },
            { label: "보험", v: f.insurance },
            { label: "은행", v: f.bank },
            { label: "기타금융", v: f.otherFinance },
          ];
          /* 나머지 — 국가·기타법인. 빠져 있던 국가를 여기서 되살린다 */
          const etc = [
            { label: "국가", v: f.nation },
            { label: "기타법인", v: f.otherCorp },
          ];
          const maxAbs = Math.max(...main.map((m) => Math.abs(m.v)), 1);
          return (
            <>
              <h3 className="idx-h3">오늘 투자자별 수급 (억원)</h3>
              <div className="ifc num">
                <div className="ifc-main">
                  {main.map((m) => (
                    <div className="ifc-cell" key={m.label}>
                      <span className="ifc-lbl">{m.label}</span>
                      <b className={sign(m.v)}>
                        {m.v > 0 ? "+" : ""}
                        {fmtNum(m.v)}
                      </b>
                      {/* 중앙 기준 미니 바 — 방향과 크기만, 높이는 4px 면 된다 */}
                      <span className="ifc-bar">
                        <i
                          className={m.v >= 0 ? "up" : "down"}
                          style={{
                            width: `${(Math.abs(m.v) / maxAbs) * 50}%`,
                            ...(m.v >= 0 ? { left: "50%" } : { right: "50%" }),
                          }}
                        />
                      </span>
                    </div>
                  ))}
                </div>
                {/* 기관 속살 — 종목 상세와 같은 일곱 */}
                <div className="ifc-sub">
                  <i className="ifc-sub-lbl">기관 속살</i>
                  {orgn.map((s) => (
                    <span key={s.label} className={s.v === 0 ? "ifc-zero" : undefined}>
                      {s.label}{" "}
                      <b className={sign(s.v)}>
                        {s.v > 0 ? "+" : ""}
                        {fmtNum(s.v)}
                      </b>
                    </span>
                  ))}
                </div>
                {/* 나머지 — 국가·기타법인 */}
                <div className="ifc-sub">
                  <i className="ifc-sub-lbl">나머지</i>
                  {etc.map((s) => (
                    <span key={s.label} className={s.v === 0 ? "ifc-zero" : undefined}>
                      {s.label}{" "}
                      <b className={sign(s.v)}>
                        {s.v > 0 ? "+" : ""}
                        {fmtNum(s.v)}
                      </b>
                    </span>
                  ))}
                </div>
              </div>
            </>
          );
        })()}

        <h3 className="idx-h3">수급 합산 (억원)</h3>
        {data && data.flows.length > 0 && (
          <div className="data-table-wrap">
            <table className="data-table num idx-sum">
              <thead>
                <tr>
                  {/*
                    ⚠️ 순서는 **개인·외국인·기관** 이다.
                    개별종목 수급표와 시황 막대가 그 순서인데 여기만 외국인이 먼저였다.
                    화면마다 열 순서가 다르면 같은 자리를 볼 때마다 머리로 다시 맞춰야 한다 —
                    수급은 세 주체를 **견주면서** 읽는 값이라 그 비용이 특히 크다.
                  */}
                  <th className="sticky-col">기간</th>
                  {FLOW_COLS.map((c) => (
                    <th key={c.key} title={c.hint}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[5, 10, 20, 60].map((n) => {
                  // flows 는 최신순이다. 앞에서 n 개가 최근 n 거래일
                  const win = data.flows.slice(0, n);
                  const enough = data.flows.length >= n;
                  return (
                    <tr key={n} className={enough ? "" : "idx-sum-short"}>
                      <td className="sticky-col">
                        {n}일
                        {!enough && <span className="pt-n"> ({data.flows.length}일치뿐)</span>}
                      </td>
                      {FLOW_COLS.map((c) => {
                        /*
                         * **한 날이라도 모르면 합계를 안 낸다.** 아는 날만 더하면
                         * 「5일 합」이라 적힌 값이 실제로는 이틀 합일 수 있다 —
                         * 그건 숫자가 조용히 거짓말하는 것이다.
                         */
                        const vals = win.map((f) => f[c.key] as number | null);
                        const unknown = vals.some((x) => x === null || x === undefined);
                        const v = unknown ? null : vals.reduce((a: number, b) => a + (b ?? 0), 0);
                        return (
                          <td className={v === null ? "" : sign(v)} key={c.key}>
                            {!enough || v === null ? "-" : fmtNum(v)}
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

        <h3 className="idx-h3">일별 수급 (억원)</h3>
        {data && data.flows.length === 0 && (
          <div className="empty">아직 쌓인 일별 수급이 없습니다.</div>
        )}
        {data && data.flows.length > 0 && (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="sticky-col">일자</th>
                  {FLOW_COLS.map((c) => (
                    <th key={c.key} title={c.hint}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.flows.map((f) => (
                  <tr key={f.date}>
                    <td className="sticky-col">{f.date.slice(5)}</td>
                    {FLOW_COLS.map((c) => {
                      const v = f[c.key] as number | null;
                      return (
                        <td className={v === null ? "" : sign(v)} key={c.key}>
                          {v === null ? "-" : fmtNum(v)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="table-note">
          지수는 키움 업종일봉입니다. 주·월은 일봉을 묶어 만듭니다 — 키움이 업종 주봉·월봉을
          따로 주지 않습니다. 일별 수급은 이미 쌓아 둔 것에서 꺼내므로 <b>추가 호출이
          없습니다</b>.
        </div>
      </div>
    </div>
  );
}
