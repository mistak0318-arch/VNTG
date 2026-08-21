import { api, fmtNum, signClass } from "../api";
import { useEffect, useState } from "react";
import { DeltaChart } from "./DeltaChart";
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
 * 오늘 장중 프로그램 순매수 **증감** — 서버가 실시간(`0w`)으로 쌓은 것.
 *
 * FID `213` 이 순매수금액증감이다. 누적(`212`)이 아니라 **증감**을 그린다 —
 * 누적을 그리면 아침에 크게 산 뒤 하루 종일 가만히 있어도 계속 높은 선으로 남아서
 * 「지금 붙고 있나」를 못 읽는다.
 */
function useProgramSeries(code: string) {
  const [pts, setPts] = useState<{ t: string; v: number }[]>([]);

  useEffect(() => {
    if (!code) {
      setPts([]);
      return;
    }
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`/api/realtime/series?type=0w&item=${encodeURIComponent(code)}`);
        const j = (await r.json()) as { points: { t: string; v: Record<string, string> }[] };
        if (!alive) return;
        setPts(
          (j.points ?? [])
            .map((p) => ({ t: p.t, v: Number(p.v["213"]) || 0 }))
            .filter((p) => p.v !== 0),
        );
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

  return pts;
}

function IntradayProgram({ code }: { code: string }) {
  const pts = useProgramSeries(code);
  if (pts.length < 2) return null;

  return (
    <section className="card">
      <h3 className="section-heading">오늘 장중 — 구간별 프로그램 순매수</h3>
      <DeltaChart points={pts} unit="백만" />
      <div className="table-note">
        <b>누적이 아니라 그 구간에 붙은 양</b>입니다 — 아침에 크게 산 뒤 가만히 있으면
        0 으로 떨어집니다. 서버가 실시간으로 30초마다 쌓으므로 <b>화면을 안 보고 있어도</b>
        늘어납니다.
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
