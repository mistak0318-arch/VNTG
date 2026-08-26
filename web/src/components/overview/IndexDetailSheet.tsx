import { useEffect, useState } from "react";
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

export function IndexDetailSheet({ code, onClose }: { code: string; onClose: () => void }) {
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
          const main = [
            { label: "개인", v: f.individual },
            { label: "외국인", v: f.foreign },
            { label: "기관", v: f.institution },
          ];
          const subs = [
            { label: "금융투자", v: f.financialInvestment },
            { label: "투신", v: f.investmentTrust },
            { label: "연기금", v: f.pensionFund },
            { label: "사모", v: f.privateFund },
            { label: "보험", v: f.insurance },
            { label: "은행", v: f.bank },
            { label: "기타법인", v: f.otherCorp },
          ].filter((s) => s.v !== 0); // 0 은 자리만 먹는다
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
                {subs.length > 0 && (
                  <div className="ifc-sub">
                    {subs.map((s) => (
                      <span key={s.label}>
                        {s.label}{" "}
                        <b className={sign(s.v)}>
                          {s.v > 0 ? "+" : ""}
                          {fmtNum(s.v)}
                        </b>
                      </span>
                    ))}
                  </div>
                )}
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
                  <th>개인</th>
                  <th>외국인</th>
                  <th>기관</th>
                  <th>투신</th>
                  <th>연기금</th>
                </tr>
              </thead>
              <tbody>
                {[5, 10, 20, 60].map((n) => {
                  // flows 는 최신순이다. 앞에서 n 개가 최근 n 거래일
                  const win = data.flows.slice(0, n);
                  const enough = data.flows.length >= n;
                  const sum = (k: "foreign" | "institution" | "individual" | "pension" | "trust") =>
                    win.reduce((a, f) => a + (f[k] ?? 0), 0);
                  return (
                    <tr key={n} className={enough ? "" : "idx-sum-short"}>
                      <td className="sticky-col">
                        {n}일
                        {!enough && <span className="pt-n"> ({data.flows.length}일치뿐)</span>}
                      </td>
                      {(["individual", "foreign", "institution", "trust", "pension"] as const).map(
                        (k) => {
                          const v = sum(k);
                          return (
                            <td className={sign(v)} key={k}>
                              {enough ? fmtNum(v) : "-"}
                            </td>
                          );
                        },
                      )}
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
                  <th>개인</th>
                  <th>외국인</th>
                  <th>기관</th>
                  {/* 기관 속살 — 종목상세 매매동향과 같은 갈래 (2026-08-27) */}
                  <th title="금융투자(증권) — 수집을 2026-08-27 시작해 그 전 날짜는 -">금융투자</th>
                  <th>투신</th>
                  <th>연기금</th>
                  <th>사모펀드</th>
                </tr>
              </thead>
              <tbody>
                {data.flows.map((f) => (
                  <tr key={f.date}>
                    <td className="sticky-col">{f.date.slice(5)}</td>
                    <td className={sign(f.individual)}>{fmtNum(f.individual)}</td>
                    <td className={sign(f.foreign)}>{fmtNum(f.foreign)}</td>
                    <td className={sign(f.institution)}>{fmtNum(f.institution)}</td>
                    <td className={f.securities === null ? "" : sign(f.securities)}>
                      {f.securities === null ? "-" : fmtNum(f.securities)}
                    </td>
                    <td className={sign(f.trust)}>{fmtNum(f.trust)}</td>
                    <td className={sign(f.pension)}>{fmtNum(f.pension)}</td>
                    <td className={sign(f.privateFund)}>{fmtNum(f.privateFund)}</td>
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
