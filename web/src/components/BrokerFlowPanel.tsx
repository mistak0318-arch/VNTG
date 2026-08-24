import { useEffect, useState } from "react";
import { FlowSeries, useMinutePrices, type FlowSample, type FlowSeriesData } from "./FlowSeries";
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
 * 웹소켓 `0F` 를 **서버가 하루 종일 물고** 30초마다 남긴다. 값 자체는 여전히 누적이지만
 * 이제 **시각이 다른 여러 점**이 있으므로 「10시에 누가 붙었나」에 답한다 —
 * 증감은 앞 점과의 차이로 낸다.
 *
 * ## 슬롯을 찾아야 한다
 *
 * `0F` 는 창구를 **순위 다섯 칸**으로 준다(1~5위). 같은 창구가 시점마다 다른 칸에
 * 있으므로 **코드로 찾아** 그 칸의 증감을 꺼낸다. 칸 번호로 고정해 읽으면
 * 순위가 바뀌는 순간 다른 창구 값을 그 창구 것으로 그리게 된다.
 */
function useBrokerSeries(code: string, broker: string | null): FlowSeriesData {
  const [s, setS] = useState<FlowSeriesData>({ pts: [], day: "", stale: false });

  useEffect(() => {
    if (!code || !broker) {
      setS({ pts: [], day: "", stale: false });
      return;
    }
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(
          `/api/realtime/series?type=0F&item=${encodeURIComponent(code)}`,
        );
        const j = (await r.json()) as {
          points: { t: string; v: Record<string, string> }[];
          day?: string;
          stale?: boolean;
          live?: boolean;
        };
        if (!alive) return;
        const out: FlowSample[] = [];
        /*
         * ⚠️ **한쪽에서 빠진 시점을 0으로 읽으면 안 된다.**
         *
         * `0F` 는 매도 상위 5칸과 매수 상위 5칸을 따로 준다. 어떤 창구가 매도 5위 안에는
         * 있는데 매수 5위 밖으로 밀리면 그 시점 「매수 누적」이 안 온다. 그걸 0으로 두면
         * 순매수가 `-매도` 로 뚝 떨어졌다가 다음 점에서 되돌아오는 **가짜 톱니**가 생긴다.
         *
         * 누적은 줄지 않으므로 **마지막으로 본 값을 이어 쓴다.** 그 사이에 더 샀을 수는
         * 있어도 덜 사지는 않는다 — 아래로만 틀리는(보수적인) 값이다.
         */
        let lastBuy = 0;
        let lastSell = 0;
        for (const p of j.points ?? []) {
          let buy: number | null = null;
          let sell: number | null = null;
          for (let i = 1; i <= 5; i++) {
            // 매수: 코드 156~160, 누적수량 171~175
            if (String(p.v[String(155 + i)] ?? "").trim() === broker) {
              buy = (buy ?? 0) + (Number(p.v[String(170 + i)]) || 0);
            }
            // 매도: 코드 146~150, 누적수량 161~165
            if (String(p.v[String(145 + i)] ?? "").trim() === broker) {
              sell = (sell ?? 0) + (Number(p.v[String(160 + i)]) || 0);
            }
          }
          if (buy === null && sell === null) continue;
          lastBuy = Math.max(lastBuy, buy ?? 0);
          lastSell = Math.max(lastSell, sell ?? 0);
          // 한 창구가 매수·매도 양쪽에 다 오르는 일이 흔하다 — 그래서 빼서 순매수를 낸다
          out.push({ t: p.t, buy: lastBuy, sell: lastSell, net: lastBuy - lastSell });
        }
        setS({ pts: out, day: j.day ?? "", stale: Boolean(j.stale), live: Boolean(j.live) });
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

  return s;
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
  /* 추정가격 칸과 주가 선 — 창구가 산 자리가 어느 가격이었나 */
  const prices = useMinutePrices(code, series.day || undefined);

  if (loading && !data) return <div className="empty">거래원 불러오는 중…</div>;
  if (error && !data) return <div className="error-banner">{error}</div>;
  if (!data) return null;
  if (data.error) return <div className="error-banner">{data.error}</div>;

  const mx = Math.max(...[...data.buy, ...data.sell].map((b) => b.qty), 1);
  const mxDelta = Math.max(...[...data.buy, ...data.sell].map((b) => b.delta), 1);

  /* 고른 창구의 시간대별 순매수 — 서버가 실시간으로 쌓은 것 */
  const picks = series;

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
            {data.names[picked] ?? picked} — 시간별 매매
            <button className="filter-btn" onClick={() => setPicked(null)}>
              닫기
            </button>
          </h3>
          {picks.pts.length < 2 ? (
            <div className="page-note">
              아직 점이 <b>{picks.pts.length}개</b>뿐입니다. 서버가 실시간으로 30초마다 쌓으므로
              <b>화면을 안 보고 있어도</b> 늘어납니다 — 장중에 조금 기다리면 채워집니다.
              (장이 닫혀 있으면 더 안 쌓입니다)
            </div>
          ) : (
            <FlowSeries
              samples={picks.pts}
              unit="주"
              unitLabel="(주)"
              asOf={picks.stale ? picks.day : undefined}
              price={prices.size > 0 ? prices : undefined}
            />
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
        창구를 누르면 <b>시간별 매도·매수·누적 순매수</b>가 줄줄이 나옵니다(HTS 거래원 상세와
        같은 모양). 순매수 옆 작은 글씨가 <b>앞 줄 대비 증감</b>이라 「그 사이에 얼마나
        붙었나」는 거기서 읽습니다. 단위는 <b>주</b>입니다.
      </div>
    </div>
  );
}
