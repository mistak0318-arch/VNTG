import { useEffect, useState } from "react";
import { FlowSeries, useMinutePrices, type FlowSample, type FlowSeriesData } from "./FlowSeries";
import { api, fmtNum, signClass, type BrokerFlow, type BrokerDayRow } from "../api";
import { useLive } from "../useLive";
import { useLockPaused } from "../lockPause";
import { useProgramSeries } from "./ProgramFlowPanel";

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
  /* 잠겨 있으면(Ctrl+Q) 15초 폴링도 놓는다 (2026-09-09 재검토) — 잠금이 실시간에만 걸려 있었다 */
  const lockPaused = useLockPaused();

  useEffect(() => {
    if (!code || !broker || lockPaused) {
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
  }, [code, broker, lockPaused]);

  return s;
}

/**
 * 창구 하나의 **일별 매매** (ka10043, 2026-09-10) — 며칠째 사고 있나. 창구를 골랐을 때만 묻는다.
 */
function useBrokerDays(code: string, broker: string | null): { rows: BrokerDayRow[]; loading: boolean } {
  const [rows, setRows] = useState<BrokerDayRow[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setRows([]);
    if (!broker || !/^\d{3}$/.test(broker)) return;
    let alive = true;
    setLoading(true);
    api
      .brokerDays(code, broker, 10)
      .then((r) => alive && setRows(r.rows))
      .catch(() => undefined)
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [code, broker]);
  return { rows, loading };
}

function BrokerDaysTable({ rows, loading, name }: { rows: BrokerDayRow[]; loading: boolean; name: string }) {
  if (loading) return <div className="page-note">일별 매매 불러오는 중…</div>;
  if (rows.length === 0) return null;
  const streak = (() => {
    let n = 0;
    for (const r of rows) {
      if (r.net > 0) n += 1;
      else break;
    }
    return n;
  })();
  const sum = rows.reduce((a, r) => a + r.net, 0);
  return (
    <div className="bf-days">
      <div className="bf-days-h">
        <b>{name}</b> 최근 {rows.length}일
        {streak >= 2 && <i className="positive"> · {streak}일째 순매수</i>}
        <span className={`bf-days-sum ${signClass(sum)}`}>
          합 {sum > 0 ? "+" : ""}
          {fmtNum(sum)}주
        </span>
      </div>
      <div className="data-table-wrap">
        <table className="data-table bf-days-t">
          <thead>
            <tr>
              <th>날짜</th>
              <th className="num">종가</th>
              <th className="num">매수</th>
              <th className="num">매도</th>
              <th className="num">순매수</th>
              <th className="num" title="그날 거래량 중 이 창구 몫">비중</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.date}>
                <td>{`${r.date.slice(4, 6)}/${r.date.slice(6, 8)}`}</td>
                <td className={`num ${signClass(r.change)}`}>{fmtNum(r.close)}</td>
                <td className="num">{fmtNum(r.buy)}</td>
                <td className="num">{fmtNum(r.sell)}</td>
                <td className={`num ${signClass(r.net)}`}>
                  {r.net > 0 ? "+" : ""}
                  {fmtNum(r.net)}
                </td>
                <td className="num pt-n">{r.weight ? `${r.weight.toFixed(1)}%` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
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
  const series = useBrokerSeries(code, picked && !picked.startsWith("__") ? picked : null);
  const brokerDays = useBrokerDays(code, picked && !picked.startsWith("__") ? picked : null);
  /* 추정가격 칸과 주가 선 — 창구가 산 자리가 어느 가격이었나 */
  const prices = useMinutePrices(code, series.day || undefined);
  /*
   * 프로그램 순매수 — 외국계 줄 밑에 같이 (2026-09-08 — 벤티지 "외국계 순매수 밑에
   * 프로그램 순매수 현황도 넣어줘 한번에 볼 수 있게"). 종합 탭이 이미 받는 summary 에서
   * 그 숫자 하나만 꺼내 쓴다. 외국계·프로그램은 「기관 밖에서 누가 밀고 있나」를 같이
   * 읽는 짝이라 한 줄에 있어야 한다. 백만원 단위라 억으로 접는다.
   */
  const { data: summary } = useLive(() => api.stockSummary(code), [code], 60_000);
  /* 서버가 거래원 조회에 같이 실어 주면 그것, 아직 옛 서버면 summary 것 */
  const program = data?.program ?? summary?.program ?? null;

  /*
   * 외국계·프로그램도 누르면 시간별 (2026-09-08 — 벤티지 "외국계랑 프로그램 클릭하면
   * 다른 거래원들처럼 밑에 그래프 나와서 추이 볼 수 있도록").
   *
   * 창구는 실시간(0F)이 하루 종일 쌓이지만 이 둘은 REST 에만 있어서, 서버가 거래원을 조회할
   * 때(화면이 열려 있는 동안 30초마다) 시계열에 같이 찍어 둔 것을 읽는다. 그래서 창구 그래프보다
   * 점이 성글고, 화면을 안 본 시간은 빈다 — 밑에 그렇게 적는다.
   *
   * ⚠️ **프로그램은 예외다** (2026-09-09 고침 — 벤티지: "거래원의 프로그램이랑 일반 프로그램
   * 탭이랑 같은 거 아니냐고").
   *
   * 같은 값이다. 그런데 이 화면은 위 문단대로 **자기 점을 새로 찍고 있었고**, 프로그램 탭은
   * 서버가 `0w` 로 08:00 부터 쌓아 둔 것을 읽는다. 그래서 한 종목의 같은 수치가 한쪽은 온종일
   * 그려지고 한쪽은 「점이 1개뿐입니다」였다 — 없는 이유가 아니라 **안 읽은 이유**다.
   * 프로그램 탭이 쓰는 훅을 그대로 가져다 쓴다.
   */
  const progSeries = useProgramSeries(code, picked === "__prog");
  const special: FlowSeriesData | null = (() => {
    if (picked === "__prog") {
      /* 서버가 쌓아 둔 것이 먼저. 그 종목을 아직 안 물었으면 예전처럼 우리가 찍은 성근 점으로 */
      if (progSeries.pts.length >= 2) {
        return {
          ...progSeries,
          /* 이 화면의 단위는 억이다 — 백만으로 온 것을 접는다 */
          pts: progSeries.pts.map((p) => ({
            t: p.t,
            buy: Math.round(p.buy / 100),
            sell: Math.round(p.sell / 100),
            net: Math.round(p.net / 100),
          })),
        };
      }
      return {
        pts: (data?.series ?? [])
          .map((p): FlowSample | null => {
            if (p.prog === undefined) return null;
            /* 프로그램은 순매수만 있다 — 백만원을 억으로 접어 넣는다 */
            const eok = Math.round(p.prog / 100);
            return { t: p.t, buy: Math.max(0, eok), sell: Math.max(0, -eok), net: eok };
          })
          .filter((x): x is FlowSample => x !== null),
        day: "",
        stale: false,
        live: true,
      };
    }
    if (picked === "__fx") {
      return {
        pts: (data?.series ?? [])
          .map((p): FlowSample | null =>
            p.fx ? { t: p.t, buy: p.fx.buy, sell: p.fx.sell, net: p.fx.buy - p.fx.sell } : null,
          )
          .filter((x): x is FlowSample => x !== null),
        day: "",
        stale: false,
        live: true,
      };
    }
    return null;
  })();
  /* 프로그램이 서버 시계열로 그려지는가 — 밑에 적는 말이 달라진다 */
  const progFromServer = picked === "__prog" && progSeries.pts.length >= 2;

  if (loading && !data) return <div className="empty">거래원 불러오는 중…</div>;
  if (error && !data) return <div className="error-banner">{error}</div>;
  if (!data) return null;
  if (data.error) return <div className="error-banner">{data.error}</div>;

  const mx = Math.max(...[...data.buy, ...data.sell].map((b) => b.qty), 1);
  const mxDelta = Math.max(...[...data.buy, ...data.sell].map((b) => b.delta), 1);

  /* 고른 창구의 시간대별 순매수 — 서버가 실시간으로 쌓은 것 */
  const picks = series;

  /*
   * 키움 앱 거래원 화면을 따랐다 (2026-09-08 — 벤티지 "ui 도 수정 좀").
   *
   * 폰에서 매수 5줄·매도 5줄이 세로로 쌓여 열 줄이었다. 키움은 **매도 | 매수 를 좌우로**
   * 놓고 같은 순위끼리 한 줄에 둔다 — 1위 매도 창구와 1위 매수 창구가 나란히 보여서
   * 「키움이 양쪽 다 1위인 날」이 한눈에 잡힌다. 매도 쪽은 숫자를 안쪽(오른쪽)에, 매수는
   * 바깥(오른쪽)에 두어 거울처럼 만든다. 증감은 큰 숫자 밑에 작게.
   */
  const side = (rows: BrokerFlow["buy"], kind: "buy" | "sell") => (
    <div className={`bf-col ${kind}`}>
      <div className={`bf-h ${kind === "buy" ? "positive" : "negative"}`}>{kind === "buy" ? "매수 상위" : "매도 상위"}</div>
      {rows.map((b) => (
        <button
          key={`${kind}-${b.rank}`}
          className={`bf-row${picked === b.code ? " on" : ""}${b.foreign ? " fg" : ""}`}
          onClick={() => setPicked(picked === b.code ? null : b.code)}
          title="눌러서 시간대별 보기"
        >
          <Bar v={b.qty} mx={mx} cls={kind} />
          <span className="bf-nm">
            {b.name}
            {/* 외국계 — 배지 하나로는 눈에 안 띄어서 줄 전체 색을 가른다 (2026-09-08 벤티지) */}
            {b.foreign && <span className="bf-fg" title="외국계 창구">외국계</span>}
          </span>
          <span className="bf-num">
            <b>{fmtNum(b.qty)}</b>
            {/* 증감 — 지금 붙고 있는 창구를 가른다. 0 이면 안 적는다 */}
            {b.delta > 0 && <small className={b.delta >= mxDelta * 0.5 ? "hot" : ""}>+{fmtNum(b.delta)}</small>}
          </span>
        </button>
      ))}
    </div>
  );

  return (
    <div className="bf">
      <div className="filter-row bf-fx">
        <span className="pt-n">{data.at} 기준</span>
        {/*
          외국계 합계 — **키움이 주는 값** (2026-09-08). 여태 상위 5 창구 이름으로 세서
          상위 5 가 전부 국내 증권사인 날은 0 이었다. 이제 응답의 frgn_*_prsm_sum 을 그대로.
        */}
        <button
          type="button"
          className={`bf-fx-sum${picked === "__fx" ? " on" : ""}`}
          onClick={() => setPicked(picked === "__fx" ? null : "__fx")}
          title="눌러서 시간대별 보기"
        >
          <em>외국계</em>
          <span className="negative">매도 {fmtNum(data.foreignSell)}</span>
          <span className="positive">매수 {fmtNum(data.foreignBuy)}</span>
          <b className={signClass(data.foreignNet)}>
            순매수 {data.foreignNet > 0 ? "+" : ""}
            {fmtNum(data.foreignNet)}
          </b>
          <i className="bf-fx-unit">주</i>
        </button>
        {program !== null && (
          <button
            type="button"
            className={`bf-fx-sum${picked === "__prog" ? " on" : ""}`}
            onClick={() => setPicked(picked === "__prog" ? null : "__prog")}
            title="눌러서 시간대별 보기"
          >
            <em>프로그램</em>
            <b className={signClass(program)}>
              순매수 {program > 0 ? "+" : ""}
              {fmtNum(Math.round(program / 100))}
            </b>
            <i className="bf-fx-unit">억</i>
          </button>
        )}
      </div>

      <div className="bf-body">
        {side(data.sell, "sell")}
        {side(data.buy, "buy")}
      </div>

      {picked &&
        (() => {
          const isSpecial = special !== null;
          const shown = isSpecial ? special : picks;
          const label = picked === "__fx" ? "외국계 합계" : picked === "__prog" ? "프로그램" : (data.names[picked] ?? picked);
          const unit = picked === "__prog" ? "억" : "주";
          return (
            <section className="card">
              <h3 className="section-heading">
                {label} — 시간별 {picked === "__prog" ? "순매수" : "매매"}
                <button className="filter-btn" onClick={() => setPicked(null)}>
                  닫기
                </button>
              </h3>
              {shown.pts.length < 2 ? (
                <div className="page-note">
                  아직 점이 <b>{shown.pts.length}개</b>뿐입니다.{" "}
                  {picked === "__prog" ? (
                    <>
                      프로그램은 서버가 실시간(<code>0w</code>)으로 쌓습니다 — 여기가 비었다는 건
                      <b> 이 종목을 아직 안 물고 있다</b>는 뜻입니다. 화면을 연 종목은 그 자리에서
                      구독하므로 30초쯤 뒤부터 채워집니다.
                    </>
                  ) : isSpecial ? (
                    <>
                      외국계는 키움이 REST 로만 주어서 <b>이 화면이 열려 있는 동안</b> 30초마다
                      쌓입니다 — 열어 두고 조금 기다리면 채워집니다.
                    </>
                  ) : (
                    <>
                      서버가 실시간으로 30초마다 쌓으므로 <b>화면을 안 보고 있어도</b> 늘어납니다 — 장중에
                      조금 기다리면 채워집니다.
                    </>
                  )}{" "}
                  (장이 닫혀 있으면 더 안 쌓입니다)
                </div>
              ) : (
                <>
                  <FlowSeries
                    samples={shown.pts}
                    unit={unit}
                    unitLabel={`(${unit})`}
                    asOf={shown.stale ? shown.day : undefined}
                    price={prices.size > 0 ? prices : undefined}
                  />
                  {isSpecial && (
                    <p className="table-note">
                      {picked === "__prog" ? (
                        progFromServer ? (
                          <>
                            <b>프로그램 탭의 그 값과 같은 것</b>입니다 — 서버가 실시간으로 쌓은 하루치를
                            그대로 읽습니다(단위만 억). 화면을 안 보고 있어도 늘어납니다.
                          </>
                        ) : (
                          <>
                            서버가 이 종목을 아직 안 물어서, 이 화면이 열려 있는 동안 찍은 점으로 그립니다 —
                            안 본 시간은 빕니다. 프로그램 탭과 같은 값입니다.
                          </>
                        )
                      ) : (
                        <>외국계는 이 화면이 열려 있는 동안만 쌓입니다 — 안 본 시간은 빕니다.</>
                      )}
                      {picked === "__prog" && " 순매수 한 줄이라 매수·매도 막대는 부호만 가릅니다."}
                    </p>
                  )}
                </>
              )}
              {/* 일별 매매 — 시간별 점이 없어도(장 초반·장 마감 뒤) 보인다 */}
              {!isSpecial && <BrokerDaysTable rows={brokerDays.rows} loading={brokerDays.loading} name={label} />}
            </section>
          );
        })()}

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
