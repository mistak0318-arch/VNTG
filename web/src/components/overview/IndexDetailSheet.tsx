import { useEffect, useState } from "react";
import { api, fmtNum, type IndexDetailData, type IndexRange } from "../../api";
import { TrendLineChart } from "../TrendLineChart";

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

        {candles.length > 1 && (
          <TrendLineChart
            height={220}
            series={[
              {
                label: data?.name ?? "지수",
                color: "#4c8dff",
                axis: "right",
                // lightweight-charts 는 {year, month, day} 형태를 받는다
                data: candles.map((c) => ({
                  time: {
                    year: Number(c.dt.slice(0, 4)),
                    month: Number(c.dt.slice(4, 6)),
                    day: Number(c.dt.slice(6, 8)),
                  },
                  value: c.close,
                })),
              },
            ]}
          />
        )}

        {/*
          일별 수급. 지수 그림 밑에 붙여야 뜻이 생긴다 —
          "이날 왜 빠졌나" 를 바로 아래에서 확인하게 된다.
        */}
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
                  <th>외국인</th>
                  <th>기관</th>
                  <th>개인</th>
                  <th>연기금</th>
                  <th>투신</th>
                </tr>
              </thead>
              <tbody>
                {data.flows.map((f) => (
                  <tr key={f.date}>
                    <td className="sticky-col">{f.date.slice(5)}</td>
                    <td className={sign(f.foreign)}>{fmtNum(f.foreign)}</td>
                    <td className={sign(f.institution)}>{fmtNum(f.institution)}</td>
                    <td className={sign(f.individual)}>{fmtNum(f.individual)}</td>
                    <td className={sign(f.pension)}>{fmtNum(f.pension)}</td>
                    <td className={sign(f.trust)}>{fmtNum(f.trust)}</td>
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
