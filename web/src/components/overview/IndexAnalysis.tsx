import { useMemo } from "react";
import type { IndexFlowRow } from "../../api";
import { MiniLine } from "../MiniLine";

/**
 * 수급 한 줄 — **느슨한 모양**. 코스피·코스닥은 열두 주체가 다 오지만, 선물은 네이버가
 * 주는 개인·외국인·기관 셋(계약)뿐이다. 없는 주체는 「-」로 적는다 — 0 으로 채우면
 * 「안 샀다」는 거짓이 된다.
 */
export type LooseFlow = { date: string; changeRate: number } & Partial<
  Record<
    | "individual"
    | "foreign"
    | "institution"
    | "securities"
    | "trust"
    | "pension"
    | "privateFund"
    | "insurance"
    | "bank"
    | "otherFinance"
    | "nation"
    | "otherCorp",
    number | null
  >
>;

/**
 * 지수 **분석** 서브탭 (2026-09-07) — 국내(코스피·코스닥·선물)와 미국(S&P·나스닥100·
 * 필라델피아 반도체 …)이 **같은 부품**을 쓴다.
 *
 * 벤티지: "각 수급 누르면 나오는 화면에서 서브탭 하나 구성해서 각 지수별 수급 주체 변화,
 * 지수의 흐름 변화, 이런 거 정밀하게 분석할 수 있게. 전체 시장의 흐름을 볼 수 있게.
 * 미국 탭의 S&P 500·나스닥 100·필라델피아 반도체 등도 같은 기능을."
 *
 * ## 개요 탭이 「오늘」이라면 여기는 「자리와 방향」
 *
 * 개요는 봉차트와 오늘·일별 표다 — **값**이 있다. 여기는 그 값이 어디에 서 있는지를
 * 잰다: 이동평균에서 얼마나 떨어졌나, 고점에서 얼마나 내려왔나, 며칠째 한 방향인가,
 * 그리고 국내는 **누가 그 방향을 만들고 있나**(주체별 누적·연속·상관).
 *
 * ## 미국 지수엔 수급이 없다 — 대신 상대강도
 *
 * 미국 지수는 투자자별 매매가 공개되지 않는다. 그래서 수급 절은 안 그린다 — 없는 것을
 * 있는 척하지 않는다. 대신 **S&P 500 대비 상대강도**를 준다. 나스닥100·반도체가
 * S&P 보다 앞서는지 뒤지는지가 「위험 선호」의 온도계다.
 *
 * ## 상관은 20일 굴림이다
 *
 * 「외국인이 지수를 끄나」는 어느 하루로는 못 답한다. 지수 등락률과 주체별 순매수의
 * **20일 굴림 상관**을 낸다 — +0.6 이면 외국인이 사는 날 오르고 파는 날 내리는 장이고,
 * 0 근처면 외국인과 지수가 따로 논다. 이게 바뀌는 순간이 장의 주인이 바뀌는 순간이다.
 */

export interface DailyPt {
  /** YYYYMMDD 또는 YYYY-MM-DD */
  d: string;
  close: number;
  /** 억원 (국내) — 미국은 없다 */
  tradeValue?: number;
}

const ymd = (d: string) => d.replace(/-/g, "");
const lbl = (d: string) => {
  const s = ymd(d);
  return `${s.slice(4, 6)}/${s.slice(6, 8)}`;
};
const pct = (v: number | null, d = 2) => (v === null ? "-" : `${v > 0 ? "+" : ""}${v.toFixed(d)}%`);
const cls = (v: number | null) => (v === null || v === 0 ? "" : v > 0 ? "positive" : "negative");
const chg = (a: number | undefined, b: number | undefined) =>
  a !== undefined && b !== undefined && b > 0 ? ((a - b) / b) * 100 : null;
const avg = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);

/** 피어슨 상관 — 둘 중 하나가 안 움직이면 null(0 으로 두면 「무관」이라는 거짓) */
function corr(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 5) return null;
  const mx = avg(xs.slice(0, n)) as number;
  const my = avg(ys.slice(0, n)) as number;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

type FlowKey = keyof Pick<
  IndexFlowRow,
  | "individual"
  | "foreign"
  | "institution"
  | "securities"
  | "trust"
  | "pension"
  | "privateFund"
  | "insurance"
  | "bank"
  | "otherFinance"
  | "nation"
  | "otherCorp"
>;

const SUBJECTS: { key: FlowKey; label: string }[] = [
  { key: "individual", label: "개인" },
  { key: "foreign", label: "외국인" },
  { key: "institution", label: "기관" },
  { key: "securities", label: "금융투자" },
  { key: "trust", label: "투신" },
  { key: "pension", label: "연기금" },
  { key: "privateFund", label: "사모펀드" },
  { key: "insurance", label: "보험" },
  { key: "bank", label: "은행" },
  { key: "otherFinance", label: "기타금융" },
  { key: "nation", label: "국가" },
  { key: "otherCorp", label: "기타법인" },
];

/** 최신순 배열에서 앞 n 개를 더한다 — 아는 날만, 며칠 더했는지 같이 */
function sumN(rows: LooseFlow[], key: FlowKey, n: number): { v: number | null; days: number } {
  const win = rows.slice(0, n);
  const known = win.map((r) => r[key]).filter((x): x is number => typeof x === "number");
  return { v: known.length ? known.reduce((s, v) => s + v, 0) : null, days: known.length };
}

/** 연속 순매수(+)/순매도(−) — 최신순 배열 */
function streakOf(rows: LooseFlow[], key: FlowKey): number {
  let k = 0;
  let sign = 0;
  for (const r of rows) {
    const v = r[key];
    if (typeof v !== "number" || v === 0) break;
    const s = v > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    if (s !== sign) break;
    k += 1;
  }
  return k * sign;
}

export function IndexAnalysis({
  name,
  daily,
  flows,
  bench,
  unit = "p",
  flowUnit = "억원",
  fewSubjects = false,
}: {
  name: string;
  /** 옛날→최신 */
  daily: DailyPt[];
  /** 최신→옛날 (서버 모양 그대로). 미국은 없다 */
  flows?: LooseFlow[];
  /** 상대강도 상대 — 미국 지수용 */
  bench?: { name: string; daily: DailyPt[] } | null;
  unit?: string;
  /** 수급 단위 — 지수는 억원, 선물은 계약 */
  flowUnit?: string;
  /** 주체가 셋뿐이면(선물) 기관 속살·열두 줄을 안 그린다 */
  fewSubjects?: boolean;
}) {
  const closes = useMemo(() => daily.map((p) => p.close).filter((c) => c > 0), [daily]);
  const n = closes.length;
  const last = closes[n - 1];

  /* ── 지수 위치 ── */
  const ma = (k: number) => (n >= k ? (avg(closes.slice(-k)) as number) : null);
  const hiOf = (k: number) => (n > 0 ? Math.max(...closes.slice(-k)) : null);
  const ret = (k: number) => chg(last, closes[n - 1 - k]);
  const gap = (m: number | null) => (m !== null && last ? ((last - m) / m) * 100 : null);
  const ma5 = ma(5);
  const ma20 = ma(20);
  const ma60 = ma(60);
  const ma120 = ma(120);
  let run = 0;
  for (let i = n - 1; i > 0; i -= 1) {
    const s = closes[i] > closes[i - 1] ? 1 : closes[i] < closes[i - 1] ? -1 : 0;
    if (s === 0) break;
    if (run === 0) run = s;
    else if (Math.sign(run) !== s) break;
    else run += s;
  }
  const dailyMoves = closes.slice(-21).map((c, i, a) => (i === 0 ? null : Math.abs((c - a[i - 1]) / a[i - 1]) * 100)).filter((x): x is number => x !== null);
  const vol20 = avg(dailyMoves);
  const tvs = daily.map((p) => p.tradeValue ?? 0).filter((v) => v > 0);
  const tvToday = tvs[tvs.length - 1] ?? null;
  const tvAvg20 = tvs.length >= 21 ? avg(tvs.slice(-21, -1)) : null;

  /* ── 60일 흐름: 지수·20일선·60일선 ── */
  const win = 60;
  const tail = daily.slice(-win);
  const labels = tail.map((p) => lbl(p.d));
  const maSeries = (k: number) =>
    tail.map((_, i) => {
      const idx = n - tail.length + i;
      return idx + 1 >= k ? (avg(closes.slice(idx + 1 - k, idx + 1)) as number) : null;
    });

  /* ── 수급 (국내) ── */
  const fl = flows ?? [];
  const flAsc = [...fl].reverse().slice(-win);
  const flLabels = flAsc.map((r) => lbl(r.date));
  const cum = (key: FlowKey) => {
    let s = 0;
    let seen = false;
    return flAsc.map((r) => {
      const v = r[key];
      if (typeof v !== "number") return seen ? s : null;
      s += v;
      seen = true;
      return s;
    });
  };
  const corrOf = (key: FlowKey, k = 20) => {
    const rows = fl.slice(0, k).filter((r) => typeof r[key] === "number");
    return corr(
      rows.map((r) => r.changeRate),
      rows.map((r) => r[key] as number),
    );
  };
  /* 외국인 상관의 60일 굴림 — 장의 주인이 언제 바뀌었나 */
  const corrSeries = flAsc.map((_, i) => {
    const upto = flAsc.slice(Math.max(0, i - 19), i + 1).filter((r) => typeof r.foreign === "number");
    if (upto.length < 10) return null;
    return corr(
      upto.map((r) => r.changeRate),
      upto.map((r) => r.foreign as number),
    );
  });

  /* ── 상대강도 (미국) ── */
  const rel = useMemo(() => {
    if (!bench || bench.daily.length === 0) return null;
    const bm = new Map(bench.daily.map((p) => [ymd(p.d), p.close]));
    const pairs = daily.map((p) => ({ d: p.d, a: p.close, b: bm.get(ymd(p.d)) ?? null })).filter((x) => x.b !== null && x.b > 0) as {
      d: string;
      a: number;
      b: number;
    }[];
    if (pairs.length < 5) return null;
    const t = pairs.slice(-win);
    const base = t[0].a / t[0].b;
    const ratio = t.map((x) => ((x.a / x.b) / base - 1) * 100);
    const r = (k: number) => {
      const i = pairs.length - 1 - k;
      return i >= 0 ? ((pairs[pairs.length - 1].a / pairs[pairs.length - 1].b) / (pairs[i].a / pairs[i].b) - 1) * 100 : null;
    };
    return { labels: t.map((x) => lbl(x.d)), ratio, r5: r(5), r20: r(20), r60: r(60) };
  }, [daily, bench]);

  if (n < 5) return <div className="empty">분석할 일봉이 모자랍니다</div>;

  const fmtP = (v: number | null) => (v === null ? "-" : `${v.toLocaleString("ko-KR", { maximumFractionDigits: 2 })}${unit}`);

  return (
    <div className="ia">
      {/* ① 자리 */}
      <h3 className="idx-h3">
        {name} — 지금 어디에 서 있나 <span className="pt-n">{fmtP(last)}</span>
      </h3>
      <dl className="ia-kv">
        <div><dt>5일</dt><dd className={cls(ret(5))}>{pct(ret(5))}</dd></div>
        <div><dt>20일</dt><dd className={cls(ret(20))}>{pct(ret(20))}</dd></div>
        <div><dt>60일</dt><dd className={cls(ret(60))}>{pct(ret(60))}</dd></div>
        <div><dt>120일</dt><dd className={cls(ret(120))}>{pct(ret(120))}</dd></div>
        <div title="종가가 이동평균에서 얼마나 떨어졌나. 양수면 위"><dt>5일선</dt><dd className={cls(gap(ma5))}>{pct(gap(ma5))}</dd></div>
        <div><dt>20일선</dt><dd className={cls(gap(ma20))}>{pct(gap(ma20))}</dd></div>
        <div><dt>60일선</dt><dd className={cls(gap(ma60))}>{pct(gap(ma60))}</dd></div>
        <div><dt>120일선</dt><dd className={cls(gap(ma120))}>{pct(gap(ma120))}</dd></div>
        <div title="0 이면 신고가 자리"><dt>20일 고점</dt><dd className={cls(chg(last, hiOf(20) ?? undefined))}>{pct(chg(last, hiOf(20) ?? undefined))}</dd></div>
        <div><dt>60일 고점</dt><dd className={cls(chg(last, hiOf(60) ?? undefined))}>{pct(chg(last, hiOf(60) ?? undefined))}</dd></div>
        <div><dt>250일 고점</dt><dd className={cls(chg(last, hiOf(250) ?? undefined))}>{pct(chg(last, hiOf(250) ?? undefined))}</dd></div>
        <div title="종가 기준 연속 상승(+)·하락(−) 일수"><dt>연속</dt><dd className={cls(run)}>{run === 0 ? "-" : `${Math.abs(run)}일 ${run > 0 ? "상승" : "하락"}`}</dd></div>
        <div title="최근 20일 하루 등락폭의 평균(절대값)"><dt>일 변동폭</dt><dd>{vol20 === null ? "-" : `${vol20.toFixed(2)}%`}</dd></div>
        {tvToday !== null && (
          <div title="오늘 거래대금 ÷ 20일 평균 — 지수가 오르는 날과 돈이 들어오는 날은 다르다">
            <dt>거래대금</dt>
            <dd>{tvAvg20 ? `${(tvToday / tvAvg20).toFixed(2)}배` : "-"}<span className="pt-n"> {Math.round(tvToday / 10_000).toLocaleString("ko-KR")}조</span></dd>
          </div>
        )}
      </dl>

      {/* ② 60일 흐름 */}
      <h3 className="idx-h3">흐름 <span className="pt-n">60일 · 종가와 20·60일선</span></h3>
      <MiniLine
        height={150}
        labels={labels}
        series={[
          { label: name, color: "var(--red)", values: tail.map((p) => p.close), width: 2 },
          { label: "20일선", color: "#f59e0b", values: maSeries(20), dash: true },
          { label: "60일선", color: "#0ea5e9", values: maSeries(60), dash: true },
        ]}
        yFmt={(v) => v.toLocaleString("ko-KR", { maximumFractionDigits: 0 })}
      />

      {/* ③ 수급 — 국내만 */}
      {fl.length > 5 && (
        <>
          <h3 className="idx-h3">누가 만들고 있나 <span className="pt-n">{flAsc.length}일 누적 · {flowUnit}</span></h3>
          <MiniLine
            height={150}
            labels={flLabels}
            refY={0}
            series={[
              { label: "외국인", color: "var(--red)", values: cum("foreign"), width: 2 },
              { label: "기관", color: "var(--blue)", values: cum("institution"), width: 2 },
              { label: "개인", color: "var(--muted)", values: cum("individual"), dash: true },
            ]}
            yFmt={(v) => (Math.abs(v) >= 10_000 ? `${(v / 10_000).toFixed(1)}만` : Math.round(v).toLocaleString("ko-KR"))}
          />
          {!fewSubjects && (
          <>
          <h3 className="idx-h3">기관 속살 <span className="pt-n">누적 · {flowUnit}</span></h3>
          <MiniLine
            height={130}
            labels={flLabels}
            refY={0}
            series={[
              { label: "연기금", color: "#f59e0b", values: cum("pension") },
              { label: "투신", color: "#22c55e", values: cum("trust") },
              { label: "사모", color: "#a855f7", values: cum("privateFund") },
              { label: "금융투자", color: "#64748b", values: cum("securities"), dash: true },
            ]}
            yFmt={(v) => (Math.abs(v) >= 10_000 ? `${(v / 10_000).toFixed(1)}만` : Math.round(v).toLocaleString("ko-KR"))}
          />
          </>
          )}

          {/* 주체 표 */}
          <h3 className="idx-h3">주체별 <span className="pt-n">합산 · 연속 · 20일 중 산 날</span></h3>
          <div className="data-table-wrap">
            <table className="data-table num ia-subj">
              <thead>
                <tr>
                  <th className="sticky-col">주체</th>
                  <th>5일</th>
                  <th>20일</th>
                  <th>60일</th>
                  <th title="연속 순매수(+)·순매도(−) 일수">연속</th>
                  <th title="최근 20일 중 순매수로 끝난 날">산 날</th>
                  <th title="지수 등락률과의 20일 상관 — +면 이 주체가 사는 날 지수가 오른다">상관</th>
                </tr>
              </thead>
              <tbody>
                {SUBJECTS.filter((s) => !fewSubjects || ["individual", "foreign", "institution"].includes(s.key)).map((s) => {
                  const s5 = sumN(fl, s.key, 5);
                  const s20 = sumN(fl, s.key, 20);
                  const s60 = sumN(fl, s.key, 60);
                  const st = streakOf(fl, s.key);
                  const bought = fl.slice(0, 20).filter((r) => typeof r[s.key] === "number" && (r[s.key] as number) > 0).length;
                  const known20 = fl.slice(0, 20).filter((r) => typeof r[s.key] === "number").length;
                  const c = corrOf(s.key);
                  const cell = (x: { v: number | null; days: number }, k: number) =>
                    x.v === null ? "-" : (
                      <>
                        {Math.round(x.v).toLocaleString("ko-KR")}
                        {x.days < Math.min(k, fl.length) && <span className="pt-n idx-sum-part">{x.days}일</span>}
                      </>
                    );
                  return (
                    <tr key={s.key} className={s.key === "foreign" || s.key === "institution" || s.key === "individual" ? "ia-main" : ""}>
                      <td className="sticky-col">{s.label}</td>
                      <td className={cls(s5.v)}>{cell(s5, 5)}</td>
                      <td className={cls(s20.v)}>{cell(s20, 20)}</td>
                      <td className={cls(s60.v)}>{cell(s60, 60)}</td>
                      <td className={cls(st)}>{st === 0 ? "-" : `${Math.abs(st)}일 ${st > 0 ? "매수" : "매도"}`}</td>
                      <td>{known20 ? `${bought}/${known20}` : "-"}</td>
                      <td className={c === null ? "" : Math.abs(c) >= 0.4 ? cls(c) : ""}>{c === null ? "-" : c.toFixed(2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* 상관 굴림 */}
          <h3 className="idx-h3">
            외국인이 지수를 끄나 <span className="pt-n">지수 등락률 × 외국인 순매수 · 20일 굴림 상관</span>
          </h3>
          <MiniLine
            height={110}
            labels={flLabels}
            refY={0}
            series={[{ label: "상관", color: "var(--red)", values: corrSeries }]}
            yFmt={(v) => v.toFixed(1)}
          />
          <p className="pt-n ia-note">
            +0.6 위면 외국인이 사는 날 오르고 파는 날 내리는 장 — 외국인이 주인입니다. 0 근처면 외국인과 지수가
            따로 놉니다(개인·기관이 끌거나, 수급 말고 다른 것이 움직입니다). 이 선이 <b>꺾이는 자리</b>가 장의
            주인이 바뀌는 자리입니다.
          </p>
        </>
      )}

      {/* ④ 상대강도 — 미국 */}
      {rel && bench && (
        <>
          <h3 className="idx-h3">
            {bench.name} 대비 상대강도 <span className="pt-n">60일 · 비율의 변화(%)</span>
          </h3>
          <MiniLine
            height={130}
            labels={rel.labels}
            refY={0}
            refYLabel="같음"
            series={[{ label: `${name} ÷ ${bench.name}`, color: "var(--red)", values: rel.ratio, width: 2 }]}
            yFmt={(v) => `${v.toFixed(1)}%`}
          />
          <dl className="ia-kv">
            <div><dt>5일 상대</dt><dd className={cls(rel.r5)}>{pct(rel.r5)}</dd></div>
            <div><dt>20일 상대</dt><dd className={cls(rel.r20)}>{pct(rel.r20)}</dd></div>
            <div><dt>60일 상대</dt><dd className={cls(rel.r60)}>{pct(rel.r60)}</dd></div>
          </dl>
          <p className="pt-n ia-note">
            양수면 {bench.name} 보다 앞서고 있습니다. 나스닥100·반도체가 S&P 를 앞서는 구간은 위험 선호가
            살아 있는 구간이고, 뒤처지기 시작하면 돈이 방어로 옮겨 가는 신호입니다.
            미국 지수는 투자자별 매매가 공개되지 않아 수급 절은 없습니다.
          </p>
        </>
      )}
    </div>
  );
}
