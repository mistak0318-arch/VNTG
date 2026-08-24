import { api, fmtNum, signClass } from "../api";
import { useEffect, useState } from "react";
import { FlowSeries, useMinutePrices, type FlowSeriesData } from "./FlowSeries";
import { useLive } from "../useLive";

/**
 * 종목별 프로그램 매매 — **오늘 계속 샀나, 샀다 팔았나.**
 *
 * 종목 상세와 종목분석이 같은 것을 쓴다.
 *
 * ## 왜 「일자별」인가
 *
 * 키움이 주는 종목별 프로그램매매(`ka90013`)는 **일자별**이다. 시장 전체는 분 단위
 * (`ka90005`)가 있지만 **종목별 장중은 확인된 TR 이 없다.**
 *
 * 그래서 두 가지를 같이 본다.
 *   · **최근 며칠 추이** — 실제 일자별 데이터. 프로그램이 이 종목에 며칠째 붙고 있나
 *   · **오늘 막대** — 오늘 하루의 매수·매도를 갈라서
 *
 * ## 「오늘 시간대별」이 생겼다
 *
 * 예전엔 여기 「못 만든다」고 적혀 있었다. REST 로는 일자별뿐이었기 때문이다.
 * 웹소켓 `0w`(종목프로그램매매)가 **순매수 증감**을 주고 서버가 하루 종일 쌓으므로,
 * 이제 「11시에 프로그램이 붙었나」에 답할 수 있다.
 *
 * ⚠️ 금액 단위는 **백만원**이다(`amt_qty_tp: "1"`). 억으로 보려면 100 으로 나눈다.
 */

interface Row {
  dt: string;
  cur_prc: string;
  flu_rt: string;
  trde_qty: string;
  prm_sell_amt: string;
  prm_buy_amt: string;
}

function n(v: unknown): number {
  const x = Number(String(v ?? "").replace(/[+,\s]/g, ""));
  return Number.isFinite(x) ? x : 0;
}

/** 백만원 → 억원 */
function toEok(v: number): number {
  return Math.round(v / 100);
}

/**
 * 오늘 장중 프로그램 매매 — 서버가 실시간(`0w`)으로 쌓은 것.
 *
 * FID `204` 매도금액 · `208` 매수금액 · `212` 순매수금액. **셋 다 누적**이다 —
 * HTS [프로그램-종목별추이] 가 적어 주는 세 칸이 정확히 이것이다.
 *
 * 증감(`213`)은 안 쓴다. 앞 줄과의 차이로 화면에서 직접 내는데, 그래야 1분·5분으로
 * 묶었을 때도 **묶은 구간의 증감**이 나온다(213 은 30초 구간 증감이라 묶으면 틀린다).
 */
function useProgramSeries(code: string): FlowSeriesData {
  const [s, setS] = useState<FlowSeriesData>({ pts: [], day: "", stale: false });

  useEffect(() => {
    if (!code) {
      setS({ pts: [], day: "", stale: false });
      return;
    }
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`/api/realtime/series?type=0w&item=${encodeURIComponent(code)}`);
        const j = (await r.json()) as {
          points: { t: string; v: Record<string, string> }[];
          day?: string;
          stale?: boolean;
          live?: boolean;
        };
        if (!alive) return;
        setS({
          pts: (j.points ?? [])
            .map((p) => ({
              t: p.t,
              buy: Number(p.v["208"]) || 0,
              sell: Number(p.v["204"]) || 0,
              net: Number(p.v["212"]) || 0,
            }))
            .filter((p) => p.buy !== 0 || p.sell !== 0 || p.net !== 0),
          day: j.day ?? "",
          stale: Boolean(j.stale),
          live: Boolean(j.live),
        });
      } catch {
        /* 실시간이 없으면 빈 그림 — 아래 일자별은 REST 라 그대로 뜬다 */
      }
    };
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [code]);

  return s;
}

function IntradayProgram({ code }: { code: string }) {
  const { pts, day, stale, live } = useProgramSeries(code);
  /* 주가를 같이 그린다 — 프로그램이 붙는데 주가가 안 가면 그것도 정보다 */
  const prices = useMinutePrices(code, day || undefined);

  /*
   * ⚠️ **없으면 없다고 적는다.**
   *
   * 예전엔 점이 모자라면 `null` 을 돌려 통째로 안 그렸다. 그러면 아래 일자별 막대만
   * 남아서 **화면이 안 바뀐 것처럼 보인다** — 「빌드가 안 됐나」와 「이 종목은 데이터가
   * 없나」가 구별이 안 된다. 조용한 빈 칸은 늘 이 문제를 낳는다.
   */
  if (pts.length < 2) {
    return (
      <section className="card">
        <h3 className="section-heading">
          {live ? "오늘 장중 — 시간별 프로그램 매매" : "시간별 프로그램 매매"}
        </h3>
        {/*
          ⚠️ **장중과 마감 후는 다른 말을 해야 한다.**

          장중에 오늘 것이 없는 건 「지금부터 쌓으면 되는 일」이다. 그런데 예전엔 그때
          **지난 장으로 되짚어** 「8월 21일(금) 장 기준」을 띄웠다 — 12시에 지난 금요일
          수급을 보여준 셈이라 「왜 전거래일 기준이냐」가 나왔다.
        */}
        <div className="page-note">
          {live ? (
            <>
              이 종목은 <b>방금 물기 시작했습니다.</b> 화면을 연 종목은 그 자리에서 구독하므로
              <b> 30초쯤 뒤부터</b> 한 점씩 쌓입니다 — 조금 기다리면 채워집니다.
              지나간 시간은 되살릴 수 없습니다(실시간은 놓치면 끝입니다).
            </>
          ) : (
            <>
              이 종목은 <b>쌓인 게 없습니다</b>
              {pts.length === 1 ? " (점 1개)" : ""}. 실시간은 장중에만 쌓이고, 그날 한 번도
              안 물었던 종목은 지난 장 것도 없습니다.
            </>
          )}{" "}
          아래 일자별은 조회(REST)라 항상 나옵니다.
        </div>
      </section>
    );
  }

  return (
    <section className="card">
      <h3 className="section-heading">
        {stale ? "지난 장 — 시간별 프로그램 매매" : "오늘 장중 — 시간별 프로그램 매매"}
      </h3>
      <FlowSeries
        samples={pts}
        unit="백만"
        unitLabel="(백만)"
        asOf={stale ? day : undefined}
        price={prices.size > 0 ? prices : undefined}
      />
      <div className="table-note">
        금액 단위는 <b>백만원</b>이고 세 칸 모두 <b>그 시점까지의 누적</b>입니다 — 순매수 옆
        작은 글씨가 앞 줄 대비 증감이라 <b>「지금 붙고 있나」</b>는 거기서 읽습니다. 서버가
        30초마다 쌓으므로 <b>화면을 안 보고 있어도</b> 늘어납니다.
      </div>
    </section>
  );
}

export function ProgramFlowPanel({ code }: { code: string }) {
  const { data, loading, error } = useLive<{ stk_daly_prm_trde_trnsn?: Row[]; error?: string }>(
    () => api.programTradesByStock(code),
    [code],
    60_000,
  );

  if (loading && !data) return <div className="empty">프로그램 매매 불러오는 중…</div>;
  if (error && !data) return <div className="error-banner">{error}</div>;
  if (!data) return null;
  if (data.error) return <div className="error-banner">{data.error}</div>;

  // 키움은 최신순으로 준다. 왼쪽이 과거가 되게 뒤집는다
  const rows = [...(data.stk_daly_prm_trde_trnsn ?? [])].slice(0, 20).reverse();
  if (rows.length === 0) return <div className="empty">프로그램 매매 데이터가 없습니다.</div>;

  const points = rows.map((r) => {
    const buy = toEok(n(r.prm_buy_amt));
    const sell = toEok(n(r.prm_sell_amt));
    return {
      dt: r.dt,
      buy,
      sell,
      net: buy - sell,
      rate: Number(String(r.flu_rt ?? "").replace(/[+,\s]/g, "")) || 0,
    };
  });
  const mx = Math.max(...points.map((p) => Math.abs(p.net)), 1);
  const today = points[points.length - 1];
  /* 며칠 연속 같은 방향인가 — 프로그램이 붙었다 떨어졌다 하는지 보는 값 */
  let streak = 0;
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i].net === 0 || (streak > 0 && points[i].net > 0 !== today.net > 0)) break;
    streak += 1;
  }

  return (
    <div className="pf">
      {/* 오늘 장중이 먼저다 — 일자별은 그 뒤에 「며칠째인가」를 본다 */}
      <IntradayProgram code={code} />
      <div className="filter-row">
        <span>
          오늘 순매수{" "}
          <b className={signClass(today.net)}>
            {today.net > 0 ? "+" : ""}
            {fmtNum(today.net)}억
          </b>
        </span>
        <span className="pt-n">
          매수 {fmtNum(today.buy)}억 · 매도 {fmtNum(today.sell)}억
        </span>
        <span className="pt-n">
          {/* 하루만 보면 우연이고 며칠 이어지면 뜻이 생긴다 */}
          {streak >= 2 ? `${streak}일 연속 ${today.net > 0 ? "순매수" : "순매도"}` : ""}
        </span>
      </div>

      {/* 0을 가운데 두고 위아래로 — 붙었다 떨어졌다 하는 게 한눈에 보여야 한다 */}
      <div className="pf-chart">
        {points.map((p) => (
          <div className="pf-col" key={p.dt} title={`${p.dt} 순매수 ${p.net}억 (${p.rate}%)`}>
            <div className="pf-up">
              {p.net > 0 && (
                <span className="pf-bar buy" style={{ height: `${(p.net / mx) * 100}%` }} />
              )}
            </div>
            <div className="pf-zero" />
            <div className="pf-dn">
              {p.net < 0 && (
                <span className="pf-bar sell" style={{ height: `${(-p.net / mx) * 100}%` }} />
              )}
            </div>
            <span className="pf-x">{p.dt.slice(4, 6)}/{p.dt.slice(6, 8)}</span>
          </div>
        ))}
      </div>

      <div className="table-note">
        <b>0선 위가 순매수, 아래가 순매도</b>입니다. 며칠째 같은 방향이면 프로그램이 이 종목에
        붙어 있는 것이고, 위아래를 오가면 차익거래일 뿐입니다 — <b>하루만 보면 우연</b>입니다.
        <br />
        아래 일자별은 키움 REST(`ka90013`)라 <b>일자 단위</b>입니다. 오늘 장중은 위쪽
        그래프에서 보세요 — 웹소켓으로 따로 쌓습니다. 단위는 억원입니다.
      </div>
    </div>
  );
}
