import { useCallback, useEffect, useState } from "react";
import { api, fmtNum, signClass, type TradeTrackResult } from "../api";

/**
 * 내 판단 추적 — **「그때 그 판단이 옳았나」.**
 *
 * 복기 노트에는 이미 매수·매도가 쌓이고 실현손익 통계도 있다. 그런데 그것만으로는
 * 답이 안 나오는 질문이 있다 —
 *
 *   "이런 이유로 팔았는데, 지나고 보니 이거 봐라?"
 *
 * 판 뒤에 20% 오른 종목은 **실현손익에 아무 흔적도 남기지 않는다.** 장부에는 얌전히
 * 수익을 낸 거래로 남고, 놓친 것은 어디에도 안 적힌다. 복기에서 봐야 하는 건 그건데.
 *
 * 그래서 매매 하나를 **그날의 판단**으로 보고 뒤를 따라간다.
 * 매수는 오르면 맞은 것, **매도는 내리면 맞은 것** — 부호가 뒤집힌다.
 */

function pct(v: number): string {
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

export function TradeTrackPanel({
  onSelectStock,
}: {
  onSelectStock?: (code: string, name: string) => void;
}) {
  const [data, setData] = useState<TradeTrackResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.journalTrack());
    } catch (e) {
      setError(e instanceof Error ? e.message : "불러오지 못했습니다");
    } finally {
      setLoading(false);
    }
  }, []);

  /*
   * 열었을 때만 부른다.
   *
   * 종목마다 일봉을 받아야 해서 **몇 초에서 몇 십 초**가 걸린다. 복기 노트를 열 때마다
   * 자동으로 돌리면 노트를 적으러 온 날에도 매번 기다리게 된다.
   */
  useEffect(() => {
    if (open && !data) void load();
  }, [open, data, load]);

  return (
    <section className="card tt">
      <h2>
        내 판단 추적
        <button className="filter-btn tt-toggle" onClick={() => setOpen((v) => !v)}>
          {open ? "접기" : "펼치기"}
        </button>
        {open && (
          <button className="filter-btn" onClick={() => void load()} disabled={loading}>
            {loading ? "…" : "↻"}
          </button>
        )}
      </h2>

      {!open ? (
        <div className="page-note">
          적어 둔 매매가 <b>그 뒤 어떻게 됐는지</b> 따라갑니다. 종목마다 일봉을 받아야 해서
          몇 십 초 걸릴 수 있어 눌렀을 때만 조회합니다.
        </div>
      ) : (
        <>
          {loading && !data && <div className="empty">일봉을 받는 중… (종목당 약 0.3초)</div>}
          {error && <div className="error-banner">{error}</div>}

          {data && data.trades.length === 0 && (
            <div className="page-note">
              추적할 매매가 없습니다. 위에서 <b>오늘의 매매</b>에 종목·가격을 적어 두면
              다음 거래일부터 결과가 채워집니다.
            </div>
          )}

          {data && data.trades.length > 0 && (
            <>
              {/* ---------- 팔고 나서 오른 것 : 이 화면의 본론 ---------- */}
              {data.soldTooEarly.length > 0 && (
                <div className="tt-early">
                  <h3>팔고 나서 오른 것</h3>
                  <p className="page-note">
                    <b>실현손익 어디에도 안 남는 값</b>입니다. 장부에는 수익을 낸 거래로 남아
                    있어서, 여기서 보지 않으면 볼 곳이 없습니다.
                  </p>
                  <ul className="tt-early-list">
                    {data.soldTooEarly.map((s) => (
                      <li key={`${s.date}-${s.name}`}>
                        <b>{s.name}</b>
                        <span className="pt-n"> {s.date} 매도</span>
                        <span className="negative"> → {s.days}거래일 뒤 {pct(s.move)}</span>
                        {s.note && <div className="tt-early-note">“{s.note}”</div>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* ---------- 판단별 성적 ---------- */}
              <div className="data-table-wrap">
                <table className="data-table num">
                  <thead>
                    <tr>
                      <th className="sticky-col">판단</th>
                      <th>기간</th>
                      <th>건수</th>
                      <th title="매수는 오른 것, 매도는 내린 것">맞은 비율</th>
                      <th title="매도는 부호를 뒤집은 값이다">평균</th>
                      <th>최고</th>
                      <th>최저</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(
                      [
                        ["매수", data.buy],
                        ["매도", data.sell],
                      ] as const
                    ).map(([label, rows]) =>
                      rows.map((h, i) => (
                        <tr key={`${label}-${h.days}`} className={h.n === 0 ? "st-empty" : ""}>
                          {i === 0 && (
                            <td className="sticky-col" rowSpan={rows.length}>
                              <b>{label}</b>
                            </td>
                          )}
                          <td>{h.days}일</td>
                          <td>{h.n}</td>
                          <td className={h.n === 0 ? "" : h.hitRate >= 50 ? "positive" : "negative"}>
                            {h.n === 0 ? "-" : `${h.hitRate.toFixed(0)}%`}
                          </td>
                          <td className={h.n === 0 ? "" : signClass(h.avgEdge)}>
                            {h.n === 0 ? "-" : pct(h.avgEdge)}
                          </td>
                          <td className="positive">{h.n === 0 ? "-" : pct(h.best)}</td>
                          <td className="negative">{h.n === 0 ? "-" : pct(h.worst)}</td>
                        </tr>
                      )),
                    )}
                  </tbody>
                </table>
              </div>
              <div className="table-note">
                <b>매도는 부호가 뒤집힙니다.</b> 팔고 나서 −10% 면 잘 판 것이라 <b>+10%</b> 로
                셉니다. 안 그러면 매수와 매도가 서로를 상쇄해 아무 말도 안 하는 숫자가 됩니다.
                건수가 적을 때 비율은 크게 흔들리므로 <b>건수를 같이</b> 보세요.
              </div>

              {/* ---------- 매매별 ---------- */}
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="sticky-col">종목</th>
                      <th>날짜</th>
                      <th>판단</th>
                      <th>체결가</th>
                      {[1, 5, 20, 60].map((d) => (
                        <th key={d} title="그 판단이 옳았던 정도">
                          {d}일
                        </th>
                      ))}
                      <th>이유</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.trades.slice(0, 200).map((t) => (
                      <tr
                        className="clickable-row"
                        key={`${t.date}-${t.id}`}
                        onClick={() => onSelectStock?.(t.code, t.name)}
                      >
                        <td className="sticky-col">{t.name}</td>
                        <td>{t.date.slice(5)}</td>
                        <td className={t.kind === "buy" ? "positive" : "negative"}>
                          {t.kind === "buy" ? "매수" : "매도"}
                        </td>
                        <td className="num">{fmtNum(t.price)}</td>
                        {[1, 5, 20, 60].map((d) => {
                          const o = t.outcomes.find((x) => x.days === d);
                          return (
                            <td className={`num ${o ? signClass(o.edge) : ""}`} key={d}>
                              {o ? pct(o.edge) : "-"}
                            </td>
                          );
                        })}
                        <td className="pt-n">{t.error ?? t.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="table-note">
                빈 칸은 <b>아직 그만큼 지나지 않은 것</b>입니다. 결과는 매매일 <b>다음</b>
                거래일부터 셉니다.
                {data.failed > 0 && ` · ${data.failed}종목은 일봉을 받지 못했습니다.`}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
