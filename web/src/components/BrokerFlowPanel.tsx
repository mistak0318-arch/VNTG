import { useEffect, useState } from "react";
import { DeltaChart } from "./DeltaChart";
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

/**
 * 창구 하나의 **시간대별 순매수 증감** — 실시간(`0F`)으로 서버가 쌓은 것.
 *
 * ## 예전엔 왜 쓸모없었나
 *
 * 키움 REST 는 **누적값만** 준다. 그래서 화면을 열어 둔 동안 30초마다 한 점씩
 * 찍어 두었는데, 누적값이라 장이 끝난 뒤엔 **같은 값이 계속 찍혔다** —
 * 「23:54 +19,722 / 23:55 +19,722 / 23:57 +19,722」. 시간대별이라 불렀지만
 * 시간에 따라 변하는 게 아무것도 없었다.
 *
 * ## 지금은
 *
 * 웹소켓 `0F` 가 창구별 **증감**을 준다. 서버가 하루 종일 물고 30초마다 남기므로
 * 화면을 안 보고 있어도 쌓이고, 「10시에 누가 붙었나」에 실제로 답한다.
 *
 * ## 슬롯을 찾아야 한다
 *
 * `0F` 는 창구를 **순위 다섯 칸**으로 준다(1~5위). 같은 창구가 시점마다 다른 칸에
 * 있으므로 **코드로 찾아** 그 칸의 증감을 꺼낸다. 칸 번호로 고정해 읽으면
 * 순위가 바뀌는 순간 다른 창구 값을 그 창구 것으로 그리게 된다.
 */
function useBrokerSeries(code: string, broker: string | null) {
  const [pts, setPts] = useState<{ t: string; v: number }[]>([]);

  useEffect(() => {
    if (!code || !broker) {
      setPts([]);
      return;
    }
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(
          `/api/realtime/series?type=0F&item=${encodeURIComponent(code)}`,
        );
        const j = (await r.json()) as { points: { t: string; v: Record<string, string> }[] };
        if (!alive) return;
        const out: { t: string; v: number }[] = [];
        for (const p of j.points ?? []) {
          let net = 0;
          for (let i = 1; i <= 5; i++) {
            // 매수: 코드 156~160, 증감 176~180 / 매도: 코드 146~150, 증감 166~170
            if (String(p.v[String(155 + i)] ?? "").trim() === broker) {
              net += Number(p.v[String(175 + i)]) || 0;
            }
            if (String(p.v[String(145 + i)] ?? "").trim() === broker) {
              net -= Number(p.v[String(165 + i)]) || 0;
            }
          }
          if (net !== 0) out.push({ t: p.t, v: net });
        }
        setPts(out);
      } catch {
        /* 실시간이 없으면 빈 그림 — 위 표는 REST 라 그대로 뜬다 */
      }
    };
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [code, broker]);

  return pts;
}

export function BrokerFlowPanel({ code }: { code: string }) {
  // 30초면 충분하다 — 창구 순위는 초 단위로 안 바뀐다
  const { data, loading, error } = useLive<BrokerFlow>(
    () => api.brokerFlow(code),
    [code],
    30_000,
  );
  const [picked, setPicked] = useState<string | null>(null);
  /*
   * ⚠️ 훅은 **`if` 문보다 위**에 있어야 한다.
   * 아래에 로딩·오류로 일찍 돌아가는 길이 있어서, 그 뒤에 두면 렌더마다 훅 개수가
   * 달라져 React 가 터진다.
   */
  const series = useBrokerSeries(code, picked);

  if (loading && !data) return <div className="empty">거래원 불러오는 중…</div>;
  if (error && !data) return <div className="error-banner">{error}</div>;
  if (!data) return null;
  if (data.error) return <div className="error-banner">{data.error}</div>;

  const mx = Math.max(...[...data.buy, ...data.sell].map((b) => b.qty), 1);
  const mxDelta = Math.max(...[...data.buy, ...data.sell].map((b) => b.delta), 1);

  /* 고른 창구의 시간대별 순매수 — 서버가 실시간으로 쌓은 것 */
  const picks = series;
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
            {data.names[picked] ?? picked} — 시간대별 순매수 증감
            <button className="filter-btn" onClick={() => setPicked(null)}>
              닫기
            </button>
          </h3>
          {picks.length < 2 ? (
            <div className="page-note">
              아직 점이 <b>{picks.length}개</b>뿐입니다. 서버가 실시간으로 30초마다 쌓으므로
              <b>화면을 안 보고 있어도</b> 늘어납니다 — 장중에 조금 기다리면 채워집니다.
              (장이 닫혀 있으면 더 안 쌓입니다)
            </div>
          ) : (
            <DeltaChart points={picks} unit="주" />
          )}
        </section>
      )}

      <div className="table-note">
        <b>증감</b>이 핵심입니다 — 누적만 보면 아침에 크게 산 창구가 하루 종일 1위로 남습니다.
        지금 <b>붙고 있는</b> 창구를 보려면 증감을 보세요. 창구를 누르면 시간대별이 열립니다.
        <br />
        ⚠️ 키움은 <b>상위 5개만</b> 줍니다 — 6위 밖에서 크게 산 창구는 안 보이므로 이 값을
        「그 종목 전체」로 읽으면 안 됩니다.
        <br />
        시간대별은 <b>그 구간에 붙은 양(증감)</b>입니다 — 누적이 아니라서 0 이면 그때는
        그 창구가 쉬었다는 뜻입니다.
      </div>
    </div>
  );
}
