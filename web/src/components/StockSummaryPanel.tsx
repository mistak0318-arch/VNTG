import { useEffect, useState } from "react";
import { api, fmtNum, signClass, type StockSummaryData } from "../api";

/**
 * **오늘 누가 샀나** — 장중 수급 요약.
 *
 * ## ⚠️ 지표는 여기 없다
 *
 * 처음엔 시총·회전율·체결강도까지 여기에 넣었다가 뺐다. 그 값들은 **요약줄
 * (`PriceHeader`)에 이미 있다** — 같은 값을 두 번 그린 것이다. 그러면 언젠가 한쪽만
 * 고쳐져서 같은 종목이 한 화면에서 다른 숫자를 말한다. 이 앱에서 여러 번 겪은 사고다.
 *
 * 그래서 **지표는 요약줄이 맡고**(회전율도 거기로 옮겼다), 여기는 수급만 한다.
 *
 * ## 기관은 반드시 쪼갠다
 *
 * 「기관 +127억」만 적으면 **누가 샀는지 모른다.** 연기금이 산 것과 투신이 산 것은
 * 다음 날 이어질 확률이 다르다. 실제로 오늘 삼성전자는 기관 전체로는 +127억인데
 * 안을 보면 **연기금 +234억, 투신 −108억**이었다 — 한 덩어리로는 안 보이는 이야기다.
 *
 * 0 인 창구는 안 그린다. 안 움직인 것을 늘어놓으면 움직인 게 묻힌다.
 */

function eok(millionWon: number): string {
  /* 키움은 백만원으로 준다. 100 백만원 = 1억 */
  const v = millionWon / 100;
  if (Math.abs(v) >= 10000) return `${(v / 10000).toFixed(2)}조`;
  return `${fmtNum(Math.round(v))}억`;
}

function cls(n: number): string {
  return n > 0 ? "positive" : n < 0 ? "negative" : "";
}

/** 순매수 한 줄 — 이름·금액·막대 */
function FlowRow({ label, amount, max }: { label: string; amount: number; max: number }) {
  const w = max > 0 ? Math.min(100, (Math.abs(amount) / max) * 100) : 0;
  return (
    <div className="ss-flow">
      <span className="ss-flow-k">{label}</span>
      {/*
        막대는 **가운데에서 좌우로** 뻗는다. 왼쪽 끝에서 시작하면 매수와 매도가
        같은 방향으로 자라서 부호를 숫자로만 읽어야 한다 — 그림의 뜻이 없어진다.
      */}
      <span className="ss-flow-bar">
        <i
          className={amount >= 0 ? "up" : "down"}
          style={{ width: `${w / 2}%`, [amount >= 0 ? "left" : "right"]: "50%" }}
        />
      </span>
      <b className={`num ${cls(amount)}`}>
        {amount > 0 ? "+" : ""}
        {eok(amount)}
      </b>
    </div>
  );
}


/**
 * 수급 누적 곡선 (2026-08-31 — "그래프로 그려줄 수 있나? 반반 나눠서 주체는
 * 똑같이 표현하면서 이렇게").
 *
 * ## 왜 곡선인가
 *
 * 가로 막대는 **오늘 하루**만 말한다. 그런데 이 칸을 보는 이유는 대개
 * 「오늘 판 게 며칠째인가」다 — 그건 막대 하나로는 답이 안 된다.
 *
 * `ka10059` 응답에는 처음부터 여러 날치가 들어 있었다(오늘 줄만 쓰고 버렸다).
 * **조회를 하나도 안 늘리고** 스무 날 누적을 그린다. 지수 시트의 「장중 수급 변화」와
 * 같은 문법이라, 두 화면을 같은 눈으로 읽을 수 있다.
 *
 * ⚠️ **장중이 아니라 일자별**이다. 개별 종목의 장중 투자자별 누적은 우리 출처에
 * 없다 — 네이버 장중 수급은 코스피·코스닥·선물 **시장 단위**만 준다.
 *
 * ## 읽는 법
 *
 * 값은 **구간 시작부터의 누적**이라, 선이 **올라가는 동안은 사는 중**이고
 * 기울기가 곧 세기다. 0선을 넘나드는 것보다 **방향이 꺾이는 자리**가 중요하다.
 */
function FlowSeriesChart({
  series,
  keys,
  colors,
  labels,
  timeAxis = false,
}: {
  series: { date: string; v: Record<string, number> }[];
  keys: string[];
  colors: Record<string, string>;
  labels: Record<string, string>;
  /** 참이면 `date` 를 「HH:MM」 그대로 눈금에 쓴다 (장중 곡선) */
  timeAxis?: boolean;
}) {
  if (series.length < 2 || keys.length === 0) return null;

  const H = 132;
  /* 왼쪽 여백 — 첫 날짜 라벨이 가운데 정렬이라 여기가 좁으면 반이 잘린다 */
  const PAD = { l: 20, r: 54, t: 12, b: 15 };
  const W = Math.max(260, PAD.l + PAD.r + series.length * 12);

  const vals = series.flatMap((p) => keys.map((k) => p.v[k] ?? 0));
  const max = Math.max(1, ...vals.map(Math.abs));
  const zero = PAD.t + (H - PAD.t - PAD.b) / 2;
  const scale = (H - PAD.t - PAD.b) / 2 / max;
  const xOf = (i: number) => PAD.l + ((W - PAD.l - PAD.r) * i) / (series.length - 1);
  const yOf = (v: number) => zero - v * scale;

  /* 억으로 접어 짧게 — 축은 값을 읽는 자리가 아니라 크기를 가늠하는 자리다 */
  const eok = (v: number) => `${Math.round(v / 100).toLocaleString("ko-KR")}억`;
  const md = (d: string) =>
    timeAxis ? d : `${Number(d.slice(4, 6))}/${Number(d.slice(6, 8))}`;

  /* 날짜 눈금은 처음·가운데·끝 셋만 — 스무 개를 다 적으면 겹쳐서 못 읽는다 */
  const ticks = [0, Math.floor((series.length - 1) / 2), series.length - 1].filter(
    (v, i, a) => a.indexOf(v) === i,
  );
  const last = series[series.length - 1];

  return (
    <div className="fs-wrap">
      <div className="fs-legend">
        {keys.map((k) => (
          <span className="fs-key" key={k}>
            <i className="fs-dot" style={{ background: colors[k] }} />
            {labels[k]}
            <b className={signClass(last.v[k] ?? 0)}>{eok(last.v[k] ?? 0)}</b>
          </span>
        ))}
      </div>
      <div className="fs-scroll">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          preserveAspectRatio="none"
          style={{ width: `${W}px`, height: `${H}px`, minWidth: "100%" }}
        >
          <line className="fs-zero" x1={PAD.l} x2={W - PAD.r} y1={zero} y2={zero} />
          <text className="fs-tick" x={W - PAD.r + 4} y={PAD.t + 8}>
            +{eok(max)}
          </text>
          <text className="fs-tick" x={W - PAD.r + 4} y={H - PAD.b}>
            -{eok(max)}
          </text>
          {keys.map((k) => (
            <polyline
              key={k}
              className="fs-line"
              style={{ stroke: colors[k] }}
              points={series.map((p, i) => `${xOf(i)},${yOf(p.v[k] ?? 0)}`).join(" ")}
            />
          ))}
          {ticks.map((i) => (
            <text key={i} className="fs-tick" x={xOf(i)} y={H - 3} textAnchor="middle">
              {md(series[i].date)}
            </text>
          ))}
        </svg>
      </div>
    </div>
  );
}

/*
 * 색 — 지수 시트의 장중 수급 차트와 **같은 배정**이다(외국인 빨강·기관 노랑·개인 초록).
 * 두 화면에서 같은 주체가 다른 색이면 눈이 매번 다시 배워야 한다.
 */
const MAIN_COLORS: Record<string, string> = {
  ind_invsr: "#35c46a",
  frgnr_invsr: "#f04452",
  orgn: "#eab308",
  etc_corp: "#8b95a1",
};
/**
 * 장중 점을 **일별과 같은 열쇠**로 옮긴다.
 *
 * 저장은 짧은 이름(`ind`·`frgn`…)으로 하고 화면은 일별과 같은 열쇠(`ind_invsr`…)를
 * 쓴다. 같은 색·같은 이름표를 그대로 재활용하려는 것이다 — 두 곡선이 다른 색이면
 * 당일과 20일을 오갈 때마다 눈이 다시 배워야 한다.
 */
function intraMain(p: StockSummaryData["intraday"][number]): Record<string, number> {
  return { ind_invsr: p.ind, frgnr_invsr: p.frgn, orgn: p.orgn, etc_corp: p.etc };
}
function intraInst(p: StockSummaryData["intraday"][number]): Record<string, number> {
  return {
    fnnc_invt: p.fnnc,
    invtrt: p.invt,
    penfnd_etc: p.penf,
    samo_fund: p.samo,
    insrnc: p.insr,
    bank: p.bank,
    etc_fnnc: p.etcf,
  };
}

/**
 * 당일 장중 곡선 — **쌓인 만큼만 그린다.**
 *
 * 키움은 종목별 시간대별 투자자를 안 준다(거래원도 같다). 그래서 서버가 종목 화면의
 * 30초 폴링에 얹어 한 점씩 남긴다 — **조회를 하나도 안 늘린다.**
 *
 * 그 대가로 **보고 있는 동안만 쌓인다.** 두 점이 안 되면 곡선이 아니므로 그리지 않고
 * 그 사실을 적는다 — 빈 칸을 두면 「수급이 없다」로 읽힌다.
 */
function IntradayBlock({
  points,
  pick,
  keys,
  colors,
  labels,
}: {
  points: StockSummaryData["intraday"];
  pick: (p: StockSummaryData["intraday"][number]) => Record<string, number>;
  keys: string[];
  colors: Record<string, string>;
  labels: Record<string, string>;
}) {
  if (points.length < 2) {
    /*
     * 장이 아닐 때 「0점」만 보이면 고장난 줄 안다. 언제 쌓이는지를 같이 적는다.
     * 판정은 한국시간 벽시계로 — 서버(`inSession`)와 같은 구간이다.
     */
    const hm = new Date(Date.now() + 9 * 3600_000).toISOString().slice(11, 16);
    const dow = new Date(Date.now() + 9 * 3600_000).getUTCDay();
    const off = dow === 0 || dow === 6 || hm < "08:50" || hm > "16:00";
    return (
      <div className="ss-none">
        {off && (
          <>
            <b>지금은 장중이 아닙니다</b> — 08:50~16:00 평일에만 쌓입니다.{" "}
          </>
        )}
        장중 곡선은 <b>이 화면을 열어 둔 동안</b> 쌓입니다 — 지금 {points.length}점.
        키움이 종목별 시간대별 투자자를 안 줘서, 30초마다 오는 「지금까지의 누적」을
        찍어 모으는 방식입니다 <span className="pt-n">(추가 조회 없음)</span>.
        <b> 과거로 소급되지 않습니다.</b>
      </div>
    );
  }
  return (
    <>
      <FlowSeriesChart
        series={points.map((p) => ({ date: p.t, v: pick(p) }))}
        keys={keys}
        colors={colors}
        labels={labels}
        timeAxis
      />
      <div className="ss-note">
        {points[0].t}~{points[points.length - 1].t} · <b>본 구간만</b> 쌓였습니다 —
        화면을 안 열어 둔 시간은 비어 있습니다.
      </div>
    </>
  );
}

const INST_COLORS: Record<string, string> = {
  fnnc_invt: "#f04452",
  invtrt: "#eab308",
  penfnd_etc: "#35c46a",
  samo_fund: "#4b9bff",
  insrnc: "#c084fc",
  bank: "#8b95a1",
  etc_fnnc: "#f59e0b",
};

export function StockSummaryPanel({ code }: { code: string }) {
  const [d, setD] = useState<StockSummaryData | null>(null);
  /** 1 = 당일(곡선 없음) */
  const [spanState, setSpan] = useState(20);

  useEffect(() => {
    if (!code) return;
    let alive = true;
    setD(null);
    const load = () =>
      api
        .stockSummary(code)
        .then((r) => alive && setD(r))
        .catch(() => undefined);
    void load();
    /* 장중에는 수급도 체결강도도 계속 바뀐다 — 첫 화면 값이 멈춰 있으면 안 된다 */
    const t = setInterval(() => void load(), 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [code]);

  if (!d) return null;

  /*
   * 곡선 기간 (2026-08-31 — "5일 20일 60일 120일 선택할 수 있게" + "당일도").
   *
   * **자르는 자리는 화면이다.** 서버가 한 쪽에 오는 만큼(100일쯤) 다 보내므로,
   * 기간을 바꿔도 **조회가 새로 안 나간다.**
   *
   * `1`(당일)은 곡선이 안 된다 — 점 하나로는 선이 없다. 그때는 곡선을 안 그리고
   * 아래 「오늘」 막대만 남긴다(예전 화면이 그것이다). 없는 것을 그리는 척하지 않는다.
   */
  const span = spanState;
  /*
   * ⚠️ **자른 뒤 기준을 다시 잡는다** (2026-08-31 버그 수정).
   *
   * 서버가 보내는 값은 **100일차부터의 누적**이다. 뒤에서 20개만 잘라 쓰면
   * 구간은 20일인데 값은 여전히 100일 누적이라 — 「20일 누적」이라 적힌 숫자가
   * 실제로는 100일 누적이었다(삼성전자 22,795억 → 318,149억). 게다가 큰 값이
   * 세로 축을 다 먹어 **곡선이 평평해져 변별력이 사라졌다.**
   *
   * 구간 **직전 날의 누적**을 빼면 「이 구간 안에서 얼마나 샀나」가 된다.
   * 구간이 처음부터면 뺄 것이 없다(0).
   */
  const series = (() => {
    if (span <= 1) return [];
    /*
     * **오늘은 뺀다** (2026-08-31 — "당일 그래프는 실시간으로 변하는게 맞아.
     * 내가 말한건 뒤에 것들 5일 20일 60일").
     *
     * 오늘 값은 장중에 계속 움직인다. 그게 다일 누적에 섞이면 「5일 수급」이 30초마다
     * 흔들려 **판단 기준이 못 된다.** 완결된 날만 합해야 어제 본 값과 오늘 본 값이
     * 같은 뜻을 갖는다. 실시간이 필요하면 그건 「당일」 곡선이 맡는다.
     *
     * ⚠️ 그래서 아래 「투자자 수급」 표의 같은 기간 합계와는 **오늘치만큼 다르다.**
     * 그 표는 오늘을 포함해 합한다. 화면이 「어제까지」라고 적어 그 차이를 알린다.
     */
    const todayYmd = new Date(Date.now() + 9 * 3600_000)
      .toISOString()
      .slice(0, 10)
      .replace(/-/g, "");
    const raw = d.flowSeries;
    const all = raw.length > 0 && raw[raw.length - 1].date === todayYmd ? raw.slice(0, -1) : raw;
    if (all.length === 0) return [];
    const start = Math.max(0, all.length - span);
    const base = start > 0 ? all[start - 1] : null;
    const rebase = (v: Record<string, number>, b: Record<string, number> | undefined) =>
      b ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x - (b[k] ?? 0)])) : v;
    return all.slice(start).map((p) => ({
      date: p.date,
      main: rebase(p.main, base?.main),
      inst: rebase(p.inst, base?.inst),
    }));
  })();
  /** 달라고 한 만큼 없을 때 — 「100일치뿐」을 적으려고 */
  const short = span > 1 && d.flowSeries.length < span;

  /* 막대 기준 — 그 표 안에서 제일 큰 것. 표마다 따로여야 작은 값이 안 사라진다 */
  const maxMain = Math.max(1, ...d.main.map((r) => Math.abs(r.amount)));
  const maxInst = Math.max(1, ...d.institution.map((r) => Math.abs(r.amount)));

  return (
    <div className="ss">
      <div className="ss-flows">
        <div className="ss-col">
          <div className="ss-sub">
            수급 흐름
            <i
              title={
                span > 1
                  ? "완결된 거래일만 합합니다(오늘 제외) — 장중에 값이 흔들리지 않게 하려는 것입니다. 아래 「투자자 수급」 표는 오늘을 포함해 합하므로 오늘치만큼 다릅니다. 실시간은 「당일」에서 봅니다."
                  : undefined
              }
            >
              {span <= 1 ? "장중 누적" : `${series.length}일 누적 · 어제까지`} · 금액
              {short && ` (${d.flowSeries.length}일치뿐)`}
            </i>
            <span className="ss-spans">
              {/*
                120일은 뺐다 (2026-08-31 — "그래프가 의미가 없어지네"). 그만큼 길면
                누적이 한 방향으로 크게 벌어져 **세로 축을 다 먹고**, 최근 며칠의
                방향 전환이 평평하게 눌린다. 이 곡선을 보는 이유는 「지금 누가 붙고
                있나」인데 그게 안 보이면 그릴 값이 없다.
              */}
              {[1, 5, 20, 60].map((n) => (
                <button
                  key={n}
                  className={`ss-span${span === n ? " active" : ""}`}
                  onClick={() => setSpan(n)}
                  title={n === 1 ? "곡선 없이 오늘 막대만" : `${n}거래일 누적`}
                >
                  {n === 1 ? "당일" : `${n}일`}
                </button>
              ))}
            </span>
          </div>
          {/*
            곡선이 먼저, 오늘 막대가 그 아래다 (2026-08-31). 이 칸을 보는 이유는
            대개 「오늘 판 게 며칠째인가」인데 막대 하나로는 그 답이 안 나온다.
            오늘 값도 지웠다가는 「그래서 오늘은 얼마」를 못 읽으므로 둘 다 둔다.
          */}
          {span <= 1 ? (
            <IntradayBlock
              points={d.intraday}
              pick={intraMain}
              keys={d.main.map((r) => r.key)}
              colors={MAIN_COLORS}
              labels={Object.fromEntries(d.main.map((r) => [r.key, r.label]))}
            />
          ) : (
            <FlowSeriesChart
              series={series.map((p) => ({ date: p.date, v: p.main }))}
              keys={d.main.map((r) => r.key)}
              colors={MAIN_COLORS}
              labels={Object.fromEntries(d.main.map((r) => [r.key, r.label]))}
            />
          )}
          <div className="ss-sub ss-sub2">
            오늘
            <i>순매수 · 금액</i>
          </div>
          {d.main.length === 0 ? (
            <div className="ss-none">아직 집계 전입니다.</div>
          ) : (
            d.main.map((r) => <FlowRow key={r.key} label={r.label} amount={r.amount} max={maxMain} />)
          )}
          {/*
            프로그램은 **개인·외국인·기관과 겹치는 값**이다(그 안에 섞여 있다).
            더하면 안 되므로 줄을 갈라 놓고 그렇다고 적는다.
          */}
          {d.program !== null && (
            <>
              <div className="ss-sep" />
              <FlowRow label="프로그램" amount={d.program} max={Math.abs(d.program) || 1} />
              <div className="ss-note">
                프로그램은 위 셋과 <b>겹치는 값</b>입니다 — 더하지 마세요.
              </div>
            </>
          )}
        </div>

        <div className="ss-col">
          <div className="ss-sub">
            기관 안쪽
            <i>
              {span <= 1 ? "장중 누적" : `${series.length}일 누적 · 어제까지`} · 움직인 창구만
            </i>
          </div>
          {span <= 1 ? (
            <IntradayBlock
              points={d.intraday}
              pick={intraInst}
              keys={d.institution.map((r) => r.key)}
              colors={INST_COLORS}
              labels={Object.fromEntries(d.institution.map((r) => [r.key, r.label]))}
            />
          ) : (
            <FlowSeriesChart
              series={series.map((p) => ({ date: p.date, v: p.inst }))}
              keys={d.institution.map((r) => r.key)}
              colors={INST_COLORS}
              labels={Object.fromEntries(d.institution.map((r) => [r.key, r.label]))}
            />
          )}
          <div className="ss-sub ss-sub2">
            오늘
            <i>순매수 · 금액</i>
          </div>
          {d.institution.length === 0 ? (
            <div className="ss-none">기관 세부가 아직 없습니다.</div>
          ) : (
            d.institution.map((r) => (
              <FlowRow key={r.key} label={r.label} amount={r.amount} max={maxInst} />
            ))
          )}
        </div>
      </div>

      {/* 못 받은 조각은 **못 받았다고 적는다** — 0 으로 보이면 「안 움직였다」로 읽힌다 */}
      {d.missing.length > 0 && (
        <div className="ss-note">⚠️ {d.missing.join(" · ")} 을(를) 못 받았습니다.</div>
      )}
    </div>
  );
}
