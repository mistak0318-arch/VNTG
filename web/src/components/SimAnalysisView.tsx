import { useEffect, useState } from "react";
import { api, type SimAnalysis, type SimCondStat, type SimRule, type SimSeriesDef } from "../api";
import { condSay, dtFull, dtY } from "./SimulatorTab";

/**
 * 백테스트 **상세 분석** 화면 (2026-09-05).
 *
 * 벤티지: "백테스트를 좀 더 디테일한 분석까지 볼 수 있게, 새 창에서도 볼 수 있게
 * 해줄래? 어떤 영향인지 흐름인지 알 수 있게 구성해서."
 *
 * ## 두 물음으로 나눠 놓았다
 *
 * **영향** — 어떤 조건이 성적에 무엇을 했나. 표의 마지막 칸이 「이걸 빼면」인데,
 * 그 값이 본 성적보다 **높으면 그 조건은 해를 끼치고 있었다.** 조건이 며칠 맞았는지만
 * 세면 절대 안 나오는 답이다(매일 맞는 조건은 아무것도 안 거르는 것이다).
 *
 * **흐름** — 언제 벌고 언제 잃었나. 한 달에 다 벌고 나머지 열한 달을 새고 있었다면
 * 총수익률은 같아도 그건 다른 규칙이다. 달마다의 표와, 고점을 되찾기까지 걸린
 * 시간이 그 답이다.
 *
 * ## 곡선에 **그냥 보유**를 겹쳐 그린다
 *
 * 규칙 곡선 하나만 그리면 위로 가는 그림은 다 좋아 보인다. 같은 기간 그 종목이
 * 더 올랐으면 그 규칙은 진 것인데, 겹쳐 놓지 않으면 그게 안 보인다.
 *
 * ## 붙박이로도 보고 새 창으로도 본다 — 같은 화면이다
 *
 * 분석 자체는 초안(저장 안 한 규칙)도 받는다. 다만 **새 창은 저장된 규칙만** 열 수
 * 있다 — 창 사이로 넘길 수 있는 것은 주소뿐이고, 초안은 주소에 담기지 않는다.
 * 그래서 초안에는 새 창 단추를 **안 보여 준다.** 눌러도 안 되는 단추를 두느니
 * 없는 편이 낫다.
 */

const 억 = (n: number) =>
  Math.abs(n) >= 100_000_000
    ? `${(n / 100_000_000).toFixed(Math.abs(n) % 100_000_000 === 0 ? 0 : 2)}억`
    : `${Math.round(n / 10_000).toLocaleString("ko-KR")}만`;
const pct = (n: number | null) => (n === null ? "-" : `${n > 0 ? "+" : ""}${n.toFixed(2)}%`);
const cls = (n: number | null | undefined) =>
  n === null || n === undefined ? "" : n > 0 ? "positive" : n < 0 ? "negative" : "";

/* ── 곡선 ──────────────────────────────────────────────────────────
   규칙과 그냥 보유를 같은 자에 올린다. 밑에는 「들고 있던 날」 띠 —
   수익이 언제 났는지와 **언제 시장에 나가 있었는지**는 다른 이야기다. */
function Curve({ a }: { a: SimAnalysis }) {
  const eq = a.result.curve.map((p) => p.equity);
  if (eq.length < 2) return null;
  const lo = Math.min(...eq, ...a.hold, a.result.seed);
  const hi = Math.max(...eq, ...a.hold, a.result.seed);
  const H = 150;
  const y = (v: number) => (hi === lo ? H / 2 : H - ((v - lo) / (hi - lo)) * H);
  const x = (i: number) => (i / (eq.length - 1)) * 1000;
  const line = (arr: number[]) =>
    arr.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");

  /* 매매 지점 — 곡선 위에 점으로. 「어디서 사고 어디서 팔았나」가 흐름의 절반이다 */
  const at = new Map(a.days.map((d, i) => [d, i]));
  const marks = a.result.trades
    .map((t) => ({ i: at.get(t.d), side: t.side }))
    .filter((m): m is { i: number; side: "buy" | "sell" } => m.i !== undefined);

  /* 보유 띠 — 이어진 구간만 사각형으로 묶는다 */
  const bands: { from: number; to: number }[] = [];
  a.pos.forEach((v, i) => {
    if (v === 1) {
      const last = bands[bands.length - 1];
      if (last && last.to === i - 1) last.to = i;
      else bands.push({ from: i, to: i });
    }
  });

  return (
    <div className="sa-curve-wrap">
      <svg className="sa-curve" viewBox={`0 -6 1000 ${H + 12}`} preserveAspectRatio="none">
        <line x1="0" x2="1000" y1={y(a.result.seed)} y2={y(a.result.seed)} className="sa-seed" />
        <path d={line(a.hold)} className="sa-hold" />
        <path d={line(eq)} className={`sa-rule ${a.result.ret >= 0 ? "up" : "down"}`} />
        {marks.map((m, i) => (
          <circle
            key={i}
            cx={x(m.i)}
            cy={y(eq[m.i])}
            r="4"
            className={m.side === "buy" ? "sa-mk-buy" : "sa-mk-sell"}
          />
        ))}
      </svg>
      <svg className="sa-band" viewBox="0 0 1000 10" preserveAspectRatio="none">
        {bands.map((b, i) => (
          <rect
            key={i}
            x={x(b.from)}
            width={Math.max(1.2, x(b.to) - x(b.from))}
            y="0"
            height="10"
            className="sa-band-on"
          />
        ))}
      </svg>
      <div className="sa-axis">
        <span>{dtFull(a.days[0])}</span>
        <span className="sa-legend">
          <i className="sa-l-rule" /> 규칙
          <i className="sa-l-hold" /> 그냥 보유
          <i className="sa-l-band" /> 들고 있던 날
        </span>
        <span>{dtFull(a.days[a.days.length - 1])}</span>
      </div>
    </div>
  );
}

/* ── 조건별 영향 ──────────────────────────────────────────────────── */
function CondTable({
  a,
  side,
  series,
}: {
  a: SimAnalysis;
  side: "buy" | "sell";
  series: SimSeriesDef[];
}) {
  const rows = a.conds.filter((c) => c.side === side);
  if (rows.length === 0) return null;
  const list = side === "buy" ? a.rule.buy : a.rule.sell;
  const base = a.result.ret;
  const total = a.result.days;

  /*
    조건을 문장으로 적는 곳은 **편집기와 같은 함수**다. 여기서 따로 적으면 편집기에서
    본 문장과 분석표의 문장이 갈리고, 그러면 어느 조건 이야기인지 대조해야 한다.
  */
  const say = (c: SimCondStat) => {
    const cond = list[c.index];
    return cond ? condSay(cond, series) : `${c.index + 1}번 조건`;
  };

  return (
    <div className="data-table-wrap">
      <table className="data-table sa-cond-t">
        <thead>
          <tr>
            <th>{side === "buy" ? "매수" : "매도"} 조건</th>
            <th className="num" title="이 조건 하나가 참이었던 거래일. 매일 맞으면 아무것도 안 거르는 조건입니다">
              맞은 날
            </th>
            <th className="num" title="이 조건 하나만 남기고 돌렸다면 (반대편 조건은 그대로)">
              이것만으로
            </th>
            <th
              className="num"
              title="이 조건만 빼고 돌렸다면. 본 성적보다 높으면 그 조건은 해를 끼치고 있었습니다"
            >
              이걸 빼면
            </th>
            <th>영향</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const w = c.without;
            /* 뺐더니 좋아졌으면 그 조건은 **깎아먹고 있었다**. 이 표의 요점이다 */
            const delta = w && !w.emptied ? base - w.ret : null;
            return (
              <tr key={`${c.side}${c.index}`}>
                <td className="sa-cond-say">{say(c)}</td>
                <td className="num">
                  {c.hit}일
                  <span className="pt-n"> {total > 0 ? Math.round((c.hit / total) * 100) : 0}%</span>
                  {c.unknown > 0 && (
                    <div className="pt-n sa-unknown" title="자료가 없어 못 잰 날 — 이 날들은 「안 맞음」으로 세어집니다">
                      못 잰 날 {c.unknown}
                    </div>
                  )}
                </td>
                <td className={`num ${cls(c.alone?.ret ?? null)}`}>
                  {c.alone ? pct(c.alone.ret) : "-"}
                  {c.alone && <span className="pt-n"> {c.alone.closed}회</span>}
                </td>
                <td className={`num ${w?.emptied ? "" : cls(w?.ret ?? null)}`}>
                  {w?.emptied ? <span className="pt-n">-</span> : pct(w?.ret ?? null)}
                </td>
                <td className="sa-verdict">
                  {w?.emptied ? (
                    <span className="pt-n">이 조건이 {side === "buy" ? "매수" : "매도"} 조건의 전부입니다</span>
                  ) : delta === null ? (
                    "-"
                  ) : delta > 0.5 ? (
                    <b className="positive">보태고 있음 +{delta.toFixed(2)}%p</b>
                  ) : delta < -0.5 ? (
                    <b className="negative">깎아먹고 있음 {delta.toFixed(2)}%p</b>
                  ) : (
                    <span className="pt-n">거의 없음</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ── 달마다 ──────────────────────────────────────────────────────── */
function Months({ a }: { a: SimAnalysis }) {
  if (a.months.length === 0) return null;
  const mx = Math.max(...a.months.map((m) => Math.abs(m.ret)), 1);
  return (
    <div className="sa-months">
      {a.months.map((m) => (
        <div className="sa-mo" key={m.m} title={`${m.m} · ${m.legs}회차 · 보유 ${m.exposure}%`}>
          <span className="sa-mo-bar">
            <i
              className={m.ret >= 0 ? "up" : "down"}
              style={{ height: `${(Math.abs(m.ret) / mx) * 100}%` }}
            />
          </span>
          <b className={cls(m.ret)}>{m.ret > 0 ? "+" : ""}{m.ret.toFixed(1)}</b>
          <span className="pt-n">{m.m.slice(2)}</span>
        </div>
      ))}
    </div>
  );
}

export function SimAnalysisView({ a, series }: { a: SimAnalysis; series: SimSeriesDef[] }) {
  const r = a.result;
  const beat = r.buyHold !== null ? r.ret - r.buyHold : null;
  const wins = a.legs.filter((l) => l.pnl > 0).length;
  const avgHeld =
    a.legs.length > 0 ? a.legs.reduce((s, l) => s + l.held, 0) / a.legs.length : null;
  const best = a.legs.reduce<null | (typeof a.legs)[0]>((b, l) => (!b || l.pnl > b.pnl ? l : b), null);
  const worst = a.legs.reduce<null | (typeof a.legs)[0]>((b, l) => (!b || l.pnl < b.pnl ? l : b), null);

  return (
    <div className="sa">
      <div className="sa-head">
        <b>{a.rule.name || "이름 없는 규칙"}</b>
        <span className="pt-n">
          {a.rule.stockName} {a.rule.code} · 시드 {억(a.rule.seed)} · 한 번 {억(a.rule.buyAmount)}
          {a.rule.addOn ? " · 추가매수" : ""}
        </span>
        {a.days.length > 0 && (
          <span className="sa-span">
            {dtFull(a.days[0])} ~ {dtFull(a.days[a.days.length - 1])} · {r.days}거래일
          </span>
        )}
      </div>

      {r.note && <p className="sim-note">{r.note}</p>}
      {(r.limits ?? []).length > 0 && (
        <ul className="sim-limits">
          {(r.limits ?? []).map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      )}

      <dl className="sim-kpis sa-kpis">
        <div>
          <dt>수익률</dt>
          <dd className={cls(r.ret)}>{pct(r.ret)}</dd>
        </div>
        <div title="같은 기간 그 종목을 첫날 사서 그냥 들고 있었다면. 규칙이 값을 했는지는 이것과 견줘야 압니다">
          <dt>그냥 보유</dt>
          <dd className={cls(r.buyHold)}>{pct(r.buyHold)}</dd>
        </div>
        <div title="규칙 − 그냥 보유. 음수면 아무것도 안 하는 편이 나았다는 뜻입니다">
          <dt>차이</dt>
          <dd className={cls(beat)}>
            {beat === null ? "-" : `${beat > 0 ? "+" : ""}${beat.toFixed(2)}%p`}
          </dd>
        </div>
        <div title="곡선의 고점 대비 가장 크게 밀린 폭">
          <dt>최대낙폭</dt>
          <dd className="negative">{r.mdd.toFixed(2)}%</dd>
        </div>
        <div title="구간 중 실제로 종목을 들고 있던 날의 비율 — 나머지는 현금이었습니다">
          <dt>시장에 나가 있던 날</dt>
          <dd>{a.exposure.toFixed(0)}%</dd>
        </div>
        <div title="사서 팔기까지를 한 회차로 셉니다">
          <dt>회차</dt>
          <dd>
            {a.legs.length}회{" "}
            <span className="pt-n">
              ({wins}승 {a.legs.length - wins}패
              {avgHeld !== null ? ` · 평균 ${avgHeld.toFixed(1)}일` : ""})
            </span>
          </dd>
        </div>
        <div>
          <dt>평가액</dt>
          <dd>{억(r.equity)}</dd>
        </div>
      </dl>

      <Curve a={a} />

      {/*
        낙폭은 **깊이만큼 길이**가 아프다. -27% 를 3일 만에 되찾는 것과 넉 달을
        물려 있는 것은 실전에서 완전히 다른 일인데, 최대낙폭 숫자 하나로는 안 갈린다.
      */}
      {a.worstSpell && (
        <p className="sa-spell">
          가장 오래 물려 있던 구간 — <b>{dtFull(a.worstSpell.from)}</b> 고점에서{" "}
          <b className="negative">{a.worstSpell.dd.toFixed(2)}%</b> 까지 밀렸고,{" "}
          {a.worstSpell.recovered ? (
            <>
              <b>{a.worstSpell.days}거래일</b> 만에 그 고점을 되찾았습니다.
            </>
          ) : (
            <>
              <b>{a.worstSpell.days}거래일</b>이 지난 구간 끝까지 <b>못 되찾았습니다.</b>
            </>
          )}
        </p>
      )}

      <h4 className="sa-h">흐름 — 달마다</h4>
      <Months a={a} />

      <h4 className="sa-h">영향 — 조건 하나를 빼면 어떻게 되나</h4>
      <p className="pt-n sa-note">
        「이걸 빼면」이 본 성적(<b className={cls(r.ret)}>{pct(r.ret)}</b>)보다 <b>높으면</b> 그
        조건은 <b className="negative">깎아먹고 있던 것</b>입니다. 조건이 며칠 맞았는지만으로는
        안 나오는 답입니다 — 매일 맞는 조건은 아무것도 안 거릅니다.
      </p>
      <CondTable a={a} side="buy" series={series} />
      <CondTable a={a} side="sell" series={series} />
      <p className="pt-n sa-note">
        매수 조건이 <b>전부</b> 맞은 날 {a.buyAllDays}일 · 매도 조건이 전부 맞은 날{" "}
        {a.sellAllDays}일 (총 {r.days}거래일).
        <br />
        ⚠️ 같은 과거 한 벌을 여러 번 재는 것이라, <b>이 표에 맞춰 조건을 고르면 그 과거에만
        맞는 규칙</b>이 됩니다. 고친 규칙은 다른 구간에서 한 번 더 보세요.
      </p>

      {a.legs.length > 0 && (
        <>
          <h4 className="sa-h">회차 — 사서 팔기까지</h4>
          {best && worst && best !== worst && (
            <p className="pt-n sa-note">
              가장 좋았던 회차 {dtFull(best.buyD)} → {dtFull(best.sellD)}{" "}
              <b className="positive">{pct(best.pnlPct)}</b> · 가장 나빴던 회차{" "}
              {dtFull(worst.buyD)} → {dtFull(worst.sellD)}{" "}
              <b className="negative">{pct(worst.pnlPct)}</b>
            </p>
          )}
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>산 날</th>
                  <th>판 날</th>
                  <th className="num">보유</th>
                  <th className="num">손익</th>
                  <th className="num">수익률</th>
                  <th>왜 샀나</th>
                  <th>왜 팔았나</th>
                </tr>
              </thead>
              <tbody>
                {[...a.legs].reverse().map((l, i) => (
                  <tr key={i}>
                    <td>{dtY(l.buyD)}</td>
                    <td>{dtY(l.sellD)}</td>
                    <td className="num">{l.held}일</td>
                    <td className={`num ${cls(l.pnl)}`}>
                      {l.pnl > 0 ? "+" : ""}
                      {l.pnl.toLocaleString("ko-KR")}
                    </td>
                    <td className={`num ${cls(l.pnlPct)}`}>{pct(l.pnlPct)}</td>
                    <td className="sim-why">{l.buyWhy}</td>
                    <td className="sim-why">{l.sellWhy}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * **새 창** (`#/simwin?rule=<id>&days=<n>`).
 *
 * 사이드바 없이 분석만 그린다 — 옆 모니터에 띄워 두고 보라고 만든 창이라
 * 메뉴가 있으면 자리만 먹는다.
 */
export function SimAnalysisWindow({ ruleId, days }: { ruleId: string; days: number }) {
  const [a, setA] = useState<SimAnalysis | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [d, setD] = useState(days);
  const [rule, setRule] = useState<SimRule | null>(null);
  /* 조건 문장에 변수 **이름표**가 필요하다 — 없으면 「MU_PRE」라고 적힌다 */
  const [series, setSeries] = useState<SimSeriesDef[]>([]);

  useEffect(() => {
    api
      .simSeries()
      .then((r) => setSeries(r.series))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    setA(null);
    setErr(null);
    api
      .simAnalyze({ id: ruleId, days: d })
      .then((r) => {
        setA(r.analysis);
        setRule(r.analysis.rule);
        document.title = `${r.analysis.rule.name || "규칙"} — 백테스트 ${d}일`;
      })
      .catch((e: Error) => setErr(e.message));
  }, [ruleId, d]);

  return (
    <div className="sa-win">
      <div className="sa-win-top">
        <b>🧪 백테스트 분석</b>
        <span className="pt-n">{rule?.name}</span>
        <span className="sa-win-days">
          {[60, 120, 250, 500].map((v) => (
            <button key={v} className={`filter-btn ${d === v ? "active" : ""}`} onClick={() => setD(v)}>
              {v}일
            </button>
          ))}
        </span>
      </div>
      {err && <div className="error-banner">{err}</div>}
      {!a && !err && <p className="pt-n">돌리는 중… 조건을 하나씩 빼고 다시 돌립니다.</p>}
      {a && <SimAnalysisView a={a} series={series} />}
    </div>
  );
}
