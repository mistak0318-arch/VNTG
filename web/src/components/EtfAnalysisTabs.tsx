import { useState } from "react";
import { api, type EtfAnalysis, type HoldingsAnalysis } from "../api";

/**
 * ETF 분석 — **두 가지 방법을 나란히.**
 *
 * 벤티지: "하나의 방법론이니깐 개별 분석 메뉴로 두던지 해서 비교분석 해보면 더 좋겠지."
 *
 *   A. **테마 분석**   — ETF 이름을 테마·섹터 강세에 잇는다. 넓게 훑지만 근사다.
 *   B. **구성종목 분석** — ETF 가 담은 종목을 직접 본다. 정확하지만 Top10 만 보인다.
 *
 * 한쪽을 지우지 않는다 — 지우면 비교가 끝난다. 어느 기준이 맞는지는 몇 달 지켜봐야
 * 알 수 있고, 그때 판단할 재료가 두 개는 있어야 한다.
 */

const pct = (v: number | null | undefined): string =>
  v === null || v === undefined || !Number.isFinite(v) ? "-" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
const cls = (v: number | null | undefined): string =>
  v === null || v === undefined || !Number.isFinite(v) ? "" : v > 0 ? "positive" : v < 0 ? "negative" : "";

/* ══════════════════════════════════════════════════════ A. 테마 분석 */

export function EtfThemeTab({ onSelectStock }: { onSelectStock: (c: string, n: string) => void }) {
  const [data, setData] = useState<EtfAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [detail, setDetail] = useState(30);
  const [onlyTheme, setOnlyTheme] = useState(false);

  const run = () => {
    setLoading(true);
    setErr(null);
    api
      .etfAnalysis(detail)
      .then(setData)
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false));
  };

  const rows = (data?.rows ?? []).filter((r) => !onlyTheme || r.theme);

  return (
    <>
      <div className="filter-row">
        {[15, 30, 50].map((n) => (
          <button key={n} className={`filter-btn ${detail === n ? "active" : ""}`} onClick={() => setDetail(n)}>
            {n}종
          </button>
        ))}
        <button className="filter-btn" onClick={run} disabled={loading}>
          {loading ? "분석 중…" : data ? "다시 분석" : "분석 시작"}
        </button>
        {data && (
          <button className={`filter-btn ${onlyTheme ? "active" : ""}`} onClick={() => setOnlyTheme((v) => !v)}>
            테마 이어진 것만
          </button>
        )}
      </div>

      {err && <div className="error-banner">{err}</div>}
      {!data && !loading && (
        <div className="table-note">
          ETF 이름을 <b>테마·섹터 강세</b>에 이어 봅니다. 거기에 상대강도·추세·품질을 얹습니다.
          좁혀진 것마다 일봉을 한 번씩 받으므로 <b>몇 초 걸립니다</b> — 눌러야 돕니다.
        </div>
      )}
      {loading && <div className="empty">일봉을 받아 상대강도와 추세를 재는 중…</div>}

      {data && (
        <>
          {data.boards.length > 0 && (
            <>
              <h3 className="section-heading">지금 강한 판</h3>
              <div className="etf-boards">
                {data.boards.slice(0, 12).map((b) => (
                  <span key={b.name} className="etf-board">
                    {b.name}
                    <i className={b.rate > 0 ? "positive" : "negative"}>
                      {b.rate > 0 ? "+" : ""}
                      {b.rate.toFixed(1)}%
                    </i>
                    {b.streak >= 2 && <em>{b.streak}일</em>}
                  </span>
                ))}
              </div>
            </>
          )}

          <h3 className="section-heading">
            담을 만한 ETF
            <span className="breadth-count">{rows.length}종</span>
            {data.benchmark && (
              <i className="cis-slot-hint">
                견준 지수 {data.benchmark.name}
                {data.benchmark.r20 !== null && ` · 20일 ${data.benchmark.r20.toFixed(1)}%`}
              </i>
            )}
          </h3>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>ETF</th>
                  <th className="num">현재가</th>
                  <th className="num">등락</th>
                  <th>이어진 판</th>
                  <th className="num" title="지수 대비 초과수익. 「오르는 것」이 아니라 「남보다 오르는 것」">
                    상대강도 20일
                  </th>
                  <th className="num">60일</th>
                  <th>추세</th>
                  <th className="num">괴리</th>
                  <th className="num">점수</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.code}>
                    <td>
                      <button className="link-btn" onClick={() => onSelectStock(r.code, r.name)}>
                        {r.name}
                      </button>
                    </td>
                    <td className="num">{r.price.toLocaleString()}</td>
                    <td className={`num ${cls(r.changeRate)}`}>{pct(r.changeRate)}</td>
                    <td className="etf-theme">
                      {r.theme ? (
                        <>
                          {r.theme.name}
                          <i className={r.theme.rate > 0 ? "positive" : "negative"}>
                            {r.theme.rate > 0 ? "+" : ""}
                            {r.theme.rate.toFixed(1)}%
                          </i>
                          {r.theme.streak >= 2 && <em>{r.theme.streak}일</em>}
                          {/* 무엇으로 이어졌나 — 잘못 이어진 것은 이걸 보면 바로 안다 */}
                          <b className="etf-via" title="이 말로 이어졌습니다">
                            {r.theme.via}
                          </b>
                        </>
                      ) : (
                        <span className="cis-dim">-</span>
                      )}
                    </td>
                    <td className={`num ${cls(r.rs20)}`}>
                      {r.rs20 !== null ? `${r.rs20 > 0 ? "+" : ""}${r.rs20}%p` : "-"}
                    </td>
                    <td className={`num ${cls(r.rs60)}`}>
                      {r.rs60 !== null ? `${r.rs60 > 0 ? "+" : ""}${r.rs60}%p` : "-"}
                    </td>
                    <td className="etf-trend">
                      {r.trend ? (
                        <>
                          <span className={r.trend.aligned ? "positive" : "cis-dim"}>
                            {r.trend.aligned ? "정배열" : "역배열"}
                          </span>
                          <i className={r.trend.above20 ? "positive" : "negative"}>
                            {r.trend.above20 ? "20일선 위" : "20일선 아래"}
                          </i>
                        </>
                      ) : (
                        <span className="cis-dim">-</span>
                      )}
                    </td>
                    <td className={`num ${r.deviation !== null && Math.abs(r.deviation) > 1 ? "negative" : ""}`}>
                      {r.deviation !== null ? `${r.deviation.toFixed(2)}%` : "-"}
                    </td>
                    <td className="num">
                      <b>{r.score}</b>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="table-note">{data.note}</div>

          {data.safe.length > 0 && (
            <>
              <h3 className="section-heading">
                안전자산
                <i className="cis-slot-hint">퇴직연금 30% 몫 — 순위와 섞지 않습니다</i>
              </h3>
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>ETF</th>
                      <th className="num">현재가</th>
                      <th className="num">등락</th>
                      <th className="num">거래대금</th>
                      <th className="num">괴리</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.safe.map((r) => (
                      <tr key={r.code}>
                        <td>
                          <button className="link-btn" onClick={() => onSelectStock(r.code, r.name)}>
                            {r.name}
                          </button>
                        </td>
                        <td className="num">{r.price.toLocaleString()}</td>
                        <td className={`num ${cls(r.changeRate)}`}>{pct(r.changeRate)}</td>
                        <td className="num">{Math.round(r.tradeValue).toLocaleString()}억</td>
                        <td className="num">{r.deviation !== null ? `${r.deviation.toFixed(2)}%` : "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}

/* ══════════════════════════════════════════════════ B. 구성종목 분석 */

export function EtfHoldingsTab({ onSelectStock }: { onSelectStock: (c: string, n: string) => void }) {
  const [data, setData] = useState<HoldingsAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const run = (withSignal: boolean) => {
    setLoading(true);
    setErr(null);
    api
      .etfHoldings(withSignal, 40)
      .then(setData)
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false));
  };

  return (
    <>
      <div className="filter-row">
        <button className="filter-btn" onClick={() => run(false)} disabled={loading}>
          {loading ? "분석 중…" : data ? "다시 분석" : "분석 시작"}
        </button>
        <button className="filter-btn" onClick={() => run(true)} disabled={loading} title="구성종목마다 신호등을 잽니다 — 무겁습니다">
          신호등까지 재기
        </button>
      </div>

      {err && <div className="error-banner">{err}</div>}
      {!data && !loading && (
        <div className="table-note">
          ETF 가 <b>담은 종목</b>을 직접 봅니다 — 이름으로 잇는 「테마 분석」과 다른 방법입니다.
          구성종목의 등락률을 <b>비중 가중</b>으로 평균하고, 몇몇이 끌었는지(폭)를 함께 봅니다.
          <b>신호등까지 재기</b>를 누르면 구성종목마다 신호등을 재서 평균합니다(무겁습니다).
        </div>
      )}
      {loading && <div className="empty">구성종목 시세를 받는 중…</div>}

      {data && (
        <>
          <h3 className="section-heading">
            구성종목이 강한 ETF
            <span className="breadth-count">{data.rows.length}종</span>
            {data.builtAt && (
              <i className="cis-slot-hint">
                인덱스 {new Date(data.builtAt).toLocaleDateString("ko-KR")} 기준
              </i>
            )}
          </h3>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>ETF</th>
                  <th className="num" title="구성종목 등락률의 비중 가중평균">
                    담은 것
                  </th>
                  <th className="num" title="오른 종목 비율. 낮으면 몇몇이 끈 것입니다">
                    폭
                  </th>
                  {data.withSignal && <th className="num">신호등 평균</th>}
                  {data.withSignal && <th className="num">초록·빨강</th>}
                  <th className="num" title="Top10 이 이 ETF 를 얼마나 덮나. 낮으면 판단의 대표성이 떨어집니다">
                    비중
                  </th>
                  <th className="num">점수</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <>
                    <tr key={r.code} className="cis-row" onClick={() => setOpen(open === r.code ? null : r.code)}>
                      <td>
                        {open === r.code ? "▾" : "▸"} {r.name}
                      </td>
                      <td className={`num ${cls(r.weighted)}`}>{pct(r.weighted)}</td>
                      <td className="num">{r.breadth !== null ? `${r.breadth}%` : "-"}</td>
                      {data.withSignal && <td className="num">{r.signalAvg ?? "-"}</td>}
                      {data.withSignal && (
                        <td className="num">
                          <span className="positive">{r.green}</span>
                          <span className="cis-dim"> · </span>
                          <span className="negative">{r.red}</span>
                        </td>
                      )}
                      {/* 비중이 낮으면 흐리게 — 그 점수는 덜 믿을 값이다 */}
                      <td className={`num ${r.coverage < 50 ? "cis-thin" : ""}`}>{r.coverage}%</td>
                      <td className="num">
                        <b>{r.score}</b>
                      </td>
                    </tr>
                    {open === r.code && (
                      <tr key={`${r.code}-h`}>
                        <td colSpan={data.withSignal ? 7 : 5} className="cis-daybody">
                          <div className="etf-holdings">
                            {r.holdings.map((h) => (
                              <button
                                key={h.code}
                                className="etf-holding"
                                onClick={() => onSelectStock(h.code, h.name)}
                              >
                                <b>{h.name}</b>
                                {h.weight !== null && <i>{h.weight}%</i>}
                                <em className={cls(h.changeRate)}>{pct(h.changeRate)}</em>
                                {h.signal && (
                                  <span className={`etf-sig sig-${h.signal.level}`}>{h.signal.score}</span>
                                )}
                              </button>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
          <div className="table-note">{data.note}</div>

          {data.aside.length > 0 && (
            <>
              <h3 className="section-heading">
                순위에서 뺀 것
                <i className="cis-slot-hint">안전자산이거나 Top10 이 너무 적게 덮는 ETF</i>
              </h3>
              <div className="etf-boards">
                {data.aside.map((r) => (
                  <span key={r.code} className="etf-board">
                    {r.name}
                    <i className="cis-dim">비중 {r.coverage}%</i>
                    {r.safe && <em>안전자산</em>}
                  </span>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}
