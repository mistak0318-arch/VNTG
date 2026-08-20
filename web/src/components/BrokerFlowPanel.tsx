import { useState } from "react";
import { api, fmtNum, signClass, type BrokerFlow } from "../api";
import { useLive } from "../useLive";

/**
 * 거래원 — **누가 사고 누가 파나.**
 *
 * 종목 상세와 종목분석이 같은 것을 쓴다.
 *
 * ## 「증감」이 이 화면의 값어치다
 *
 * 누적 수량만 보면 **아침에 크게 산 창구가 하루 종일 1위**로 남는다. 증감은
 * **지금 붙고 있는 창구**를 알려준다 — 누적 1위가 손을 놨고 3위가 계속 담는 날이 있다.
 *
 * ## 시간대별은 우리가 쌓는다
 *
 * 키움은 창구별 시간대별을 안 준다(누적과 증감만). 그래서 **볼 때마다 한 점씩 쌓는다.**
 * 화면을 안 열어 둔 시간은 빈다 — 「완전한 하루」가 아니라 **「내가 본 구간」**이다.
 */

function Bar({ v, mx, cls }: { v: number; mx: number; cls: string }) {
  return <span className={`bf-bar ${cls}`} style={{ width: `${mx > 0 ? (v / mx) * 100 : 0}%` }} />;
}

export function BrokerFlowPanel({ code }: { code: string }) {
  // 30초면 충분하다 — 창구 순위는 초 단위로 안 바뀐다
  const { data, loading, error } = useLive<BrokerFlow>(
    () => api.brokerFlow(code),
    [code],
    30_000,
  );
  const [picked, setPicked] = useState<string | null>(null);

  if (loading && !data) return <div className="empty">거래원 불러오는 중…</div>;
  if (error && !data) return <div className="error-banner">{error}</div>;
  if (!data) return null;
  if (data.error) return <div className="error-banner">{data.error}</div>;

  const mx = Math.max(...[...data.buy, ...data.sell].map((b) => b.qty), 1);
  const mxDelta = Math.max(...[...data.buy, ...data.sell].map((b) => b.delta), 1);

  /* 고른 창구의 시간대별 순매수 */
  const picks = picked
    ? data.series.map((p) => ({ t: p.t, v: p.net[picked] ?? 0 })).filter((p) => p.v !== 0)
    : [];
  const pmax = Math.max(...picks.map((p) => Math.abs(p.v)), 1);

  const side = (rows: BrokerFlow["buy"], kind: "buy" | "sell") => (
    <div className="bf-col">
      <div className={`bf-h ${kind === "buy" ? "positive" : "negative"}`}>
        {kind === "buy" ? "매수 상위" : "매도 상위"}
      </div>
      {rows.map((b) => (
        <button
          key={`${kind}-${b.rank}`}
          className={`bf-row${picked === b.code ? " on" : ""}`}
          onClick={() => setPicked(picked === b.code ? null : b.code)}
          title="눌러서 시간대별 보기"
        >
          <span className="bf-nm">
            {b.name}
            {b.foreign && <span className="bf-fg">외</span>}
          </span>
          <span className="bf-qty">
            <Bar v={b.qty} mx={mx} cls={kind} />
            <b>{fmtNum(b.qty)}</b>
          </span>
          {/* 증감 — 지금 붙고 있는 창구를 가른다 */}
          <span className="bf-delta">
            <Bar v={b.delta} mx={mxDelta} cls={`${kind} d`} />
            <b>+{fmtNum(b.delta)}</b>
          </span>
        </button>
      ))}
    </div>
  );

  return (
    <div className="bf">
      <div className="filter-row">
        <span className="pt-n">{data.at} 기준</span>
        <span>
          외국계 순매수{" "}
          <b className={signClass(data.foreignNet)}>
            {data.foreignNet > 0 ? "+" : ""}
            {fmtNum(data.foreignNet)}
          </b>
        </span>
      </div>

      <div className="bf-body">
        {side(data.buy, "buy")}
        {side(data.sell, "sell")}
      </div>

      {picked && (
        <section className="card">
          <h3 className="section-heading">
            {data.names[picked] ?? picked} — 시간대별 순매수
            <button className="filter-btn" onClick={() => setPicked(null)}>
              닫기
            </button>
          </h3>
          {picks.length < 2 ? (
            <div className="page-note">
              아직 점이 <b>{picks.length}개</b>뿐입니다. 이 화면을 열어 두면 30초마다 한 점씩
              쌓입니다 — 키움이 창구별 시간대별을 주지 않아 <b>직접 모으는 수밖에</b> 없습니다.
            </div>
          ) : (
            <div className="bf-series">
              {picks.map((p) => (
                <div className="bf-pt" key={p.t}>
                  <span className="bf-pt-t">{p.t}</span>
                  <span className="bf-pt-bar">
                    <span
                      className={`bf-bar ${p.v >= 0 ? "buy" : "sell"}`}
                      style={{ width: `${(Math.abs(p.v) / pmax) * 100}%` }}
                    />
                  </span>
                  <span className={`bf-pt-v ${signClass(p.v)}`}>
                    {p.v > 0 ? "+" : ""}
                    {fmtNum(p.v)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <div className="table-note">
        <b>증감</b>이 핵심입니다 — 누적만 보면 아침에 크게 산 창구가 하루 종일 1위로 남습니다.
        지금 <b>붙고 있는</b> 창구를 보려면 증감을 보세요. 창구를 누르면 시간대별이 열립니다.
        <br />
        ⚠️ 키움은 <b>상위 5개만</b> 줍니다 — 6위 밖에서 크게 산 창구는 안 보이므로 이 값을
        「그 종목 전체」로 읽으면 안 됩니다. 시간대별은 <b>이 화면을 본 구간만</b> 쌓입니다.
      </div>
    </div>
  );
}
