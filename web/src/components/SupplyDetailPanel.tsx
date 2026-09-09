import { useEffect, useState } from "react";
import { api, fmtNum, pickList, signClass, type RawRecord } from "../api";
import { SortableTh, useSortableTable } from "../useSortableTable";
import { toBusinessDay, TrendLineChart, type TrendSeries } from "./TrendLineChart";

/** ka10008(외국인), ka10014(공매도), ka20068(대차) 공식 문서 기준 필드명 */
const FOREIGN_KEYS = ["stk_frgnr"];
const SHORT_KEYS = ["shrts_trnsn"];
const LENDING_KEYS = ["dbrt_trde_trnsn"];

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function absNum(v: unknown): number {
  return Math.abs(num(v));
}

function fmtDt(dt: string): string {
  if (!/^\d{8}$/.test(dt)) return dt || "-";
  return `${dt.slice(4, 6)}/${dt.slice(6, 8)}`;
}

/** 최신순 응답을 차트용(시간 오름차순) 시계열로 */
function seriesFrom(rows: RawRecord[], valueKey: string, transform = num): TrendSeries["data"] {
  return rows
    .map((r) => {
      const time = toBusinessDay(String(r.dt ?? ""));
      if (!time) return null;
      return { time, value: transform(r[valueKey]) };
    })
    .filter((d): d is { time: ReturnType<typeof toBusinessDay> & object; value: number } => d !== null)
    .reverse() as TrendSeries["data"];
}

const priceSeries = (rows: RawRecord[], key = "close_pric"): TrendSeries => ({
  label: "주가",
  color: "#8b96a5",
  axis: "left",
  data: seriesFrom(rows, key, absNum),
});

/**
 * 종합 화면용 — 외국인 지분율 / 대차잔고 / 공매도를 표 없이 그래프만 세로로 쌓는다.
 * 상세 수치는 '외국인·공매도·대차' 탭에서 본다.
 */
export function SupplyMiniCharts({ code }: { code: string }) {
  const [data, setData] = useState<{ f: RawRecord; s: RawRecord; l: RawRecord } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([api.foreignTrend(code), api.shortSale(code, 90), api.stockLending(code, 90)])
      .then(([f, s, l]) => {
        if (!cancelled) setData({ f: f as RawRecord, s: s as RawRecord, l: l as RawRecord });
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (loading) return <div className="empty">수급 그래프 불러오는 중...</div>;
  if (error) return <div className="error-banner">{error}</div>;
  if (!data) return null;

  const foreignRows = pickList(data.f, FOREIGN_KEYS);
  const lendingRows = pickList(data.l, LENDING_KEYS);
  const shortRows = pickList(data.s, SHORT_KEYS);

  return (
    <>
      <h3 className="section-heading">외국인 지분율</h3>
      <div className="chart-wrap">
        <TrendLineChart
          height={180}
          series={[
            priceSeries(foreignRows),
            {
              label: "외국인 지분율(%)",
              color: "#4ade80",
              axis: "right",
              data: seriesFrom(foreignRows, "wght"),
            },
          ]}
        />
      </div>

      <h3 className="section-heading">대차잔고</h3>
      <div className="chart-wrap">
        <TrendLineChart
          height={180}
          series={[
            { label: "대차잔고(주)", color: "#c084fc", axis: "right", data: seriesFrom(lendingRows, "rmnd") },
          ]}
        />
      </div>

      <h3 className="section-heading">공매도</h3>
      <div className="chart-wrap">
        <TrendLineChart
          height={180}
          series={[
            priceSeries(shortRows),
            {
              label: "공매도 비중(%)",
              color: "#f0555f",
              axis: "right",
              data: seriesFrom(shortRows, "trde_wght"),
            },
          ]}
        />
      </div>
      <div className="table-note">최근 90일 · 자세한 수치는 &apos;외국인·공매도·대차&apos; 탭에서 볼 수 있습니다</div>
    </>
  );
}

/**
 * **거래량 흐름** (2026-09-09 밤 — 벤티지 "프로그램 수급 밑에 외국인 지분율 나오기 전에 거래량
 * 그래프도 한 번 보여줄래? … 거래량이 많아지고 있는지 적어지고 있는지. 시장의 관심이 어떤지").
 *
 * 일봉(`dailyChart`, 이미 다른 자리에서도 받는 조회)에서 최근 90일 거래량을 막대로, 그 위에
 * **20일 평균 거래량**을 선으로 얹는다 — 막대가 평균선 위로 올라오면 관심이 붙는 중이고
 * 아래로 가라앉으면 식는 중이다. 주가는 왼쪽 축에 얇게 같이 둔다(지분율 그래프와 같은 문법).
 */
export function VolumeFlowChart({ code }: { code: string }) {
  /*
   * 일별 / 주별 (2026-09-10 — 벤티지 "일별 주별 선택할 수 있게 … 지금은 확대해야 일별
   * 나오잖아. 차트 설정하는 거랑 비슷하게"). 주별은 주봉(ka10082)의 거래량 — 창은 60주,
   * 평균선은 20주. 마지막 고른 것을 기억한다.
   */
  const [unit, setUnit] = useState<"day" | "week">(() => {
    try {
      return localStorage.getItem("vntg.volflow.unit") === "week" ? "week" : "day";
    } catch {
      return "day";
    }
  });
  const pickUnit = (u: "day" | "week") => {
    setUnit(u);
    try {
      localStorage.setItem("vntg.volflow.unit", u);
    } catch {
      /* 저장 못 해도 이번 화면에서는 바뀐다 */
    }
  };
  /* 기간 — 일별 60·90·120·240일, 주별 26·52·104주 (벤티지 "기간도 선택할 수 있도록") */
  /* 일별 30일 추가·기본 30 (벤티지 2026-09-10 "거래량도 일별 30일 추가해서 기본 30일 체크") */
  const SPANS = { day: [30, 60, 90, 120, 240], week: [26, 52, 104] } as const;
  const [spans, setSpans] = useState<{ day: number; week: number }>(() => {
    try {
      const d = Number(localStorage.getItem("vntg.volflow.span.day"));
      const w = Number(localStorage.getItem("vntg.volflow.span.week"));
      return { day: SPANS.day.includes(d as 30) ? d : 30, week: SPANS.week.includes(w as 26) ? w : 52 };
    } catch {
      return { day: 30, week: 52 };
    }
  });
  const span = spans[unit];
  const pickSpan = (n: number) => {
    setSpans((p) => ({ ...p, [unit]: n }));
    try {
      localStorage.setItem(`vntg.volflow.span.${unit}`, String(n));
    } catch {
      /* 저장 못 해도 이번 화면에서는 바뀐다 */
    }
  };
  const [rows, setRows] = useState<RawRecord[] | null>(null);
  useEffect(() => {
    let alive = true;
    setRows(null);
    (unit === "week" ? api.weeklyChart(code) : api.dailyChart(code))
      .then((d) => {
        if (!alive) return;
        const raw = d as RawRecord;
        const list = ((unit === "week" ? raw.stk_stk_pole_chart_qry : raw.stk_dt_pole_chart_qry) as RawRecord[] | undefined) ?? [];
        setRows(list);
      })
      .catch(() => alive && setRows([]));
    return () => {
      alive = false;
    };
  }, [code, unit]);
  if (rows === null) return <div className="empty">거래량 불러오는 중...</div>;
  if (rows.length === 0) return null;

  /* 최신순 → 과거순. 20일 평균은 뒤(과거)에서부터 굴린다 */
  const asc = [...rows].reverse();
  const vol = asc.map((r) => Math.abs(num(r.trde_qty)));
  const avg20: (number | null)[] = vol.map((_, i) =>
    i >= 19 ? vol.slice(i - 19, i + 1).reduce((a, b) => a + b, 0) / 20 : null,
  );
  const last = asc.length;
  const from = Math.max(0, last - span);
  const bars: TrendSeries["data"] = [];
  const avgLine: TrendSeries["data"] = [];
  const price: TrendSeries["data"] = [];
  for (let i = from; i < last; i += 1) {
    const time = toBusinessDay(String(asc[i].dt ?? ""));
    if (!time) continue;
    /* 오른 날 붉게, 내린 날 파랗게 — 캔들 차트의 거래량과 같은 색 (벤티지 "막대그래프 색깔이 안 변하는데") */
    const c = Math.abs(num(asc[i].cur_prc));
    const pc = i > 0 ? Math.abs(num(asc[i - 1].cur_prc)) : c;
    bars.push({ time, value: vol[i], color: c > pc ? "rgba(239, 68, 68, 0.6)" : c < pc ? "rgba(76, 141, 255, 0.6)" : "rgba(139, 150, 165, 0.5)" });
    if (avg20[i] !== null) avgLine.push({ time, value: avg20[i] as number });
    price.push({ time, value: Math.abs(num(asc[i].cur_prc)) });
  }
  const todayV = vol[last - 1] ?? 0;
  const a20 = avg20[last - 1];
  const ratio = a20 ? todayV / a20 : null;
  return (
    <>
      <h3 className="section-heading">
        거래량 흐름
        {ratio !== null && (
          <span className={`pt-n ${ratio >= 1.5 ? "positive" : ratio < 0.7 ? "negative" : ""}`} style={{ marginLeft: 8, fontWeight: 400, fontSize: "0.8rem" }}>
            {unit === "week" ? "이번 주 = 20주" : "오늘 = 20일"} 평균의 <b>{ratio.toFixed(1)}배</b>
          </span>
        )}
        <span className="filter-row" style={{ display: "inline-flex", marginLeft: 10, gap: 4, flexWrap: "wrap" }}>
          {(["day", "week"] as const).map((u) => (
            <button key={u} className={`filter-btn ${unit === u ? "active" : ""}`} onClick={() => pickUnit(u)} style={{ fontWeight: 400 }}>
              {u === "day" ? "일" : "주"}
            </button>
          ))}
          <span className="news-scope-sep" />
          {SPANS[unit].map((n) => (
            <button key={n} className={`filter-btn ${span === n ? "active" : ""}`} onClick={() => pickSpan(n)} style={{ fontWeight: 400 }}>
              {n}
              {unit === "week" ? "주" : "일"}
            </button>
          ))}
        </span>
      </h3>
      <div className="chart-wrap">
        <TrendLineChart
          height={180}
          series={[
            { label: "주가", color: "#8b96a5", axis: "left", data: price },
            { label: "거래량", color: "rgba(139, 150, 165, 0.5)", axis: "right", type: "histogram", data: bars },
            { label: unit === "week" ? "20주 평균 거래량" : "20일 평균 거래량", color: "#f59e0b", axis: "right", data: avgLine },
          ]}
        />
      </div>
      <div className="table-note">
        최근 {span}{unit === "week" ? "주" : "일"} · 붉은 막대는 오른 {unit === "week" ? "주" : "날"}, 파란 막대는 내린 {unit === "week" ? "주" : "날"} · 막대가 주황 선({unit === "week" ? "20주" : "20일"} 평균) 위면 관심이 붙는 중, 아래면 식는 중입니다. 머리의 배수는 1.5배 넘으면 붉게, 0.7배 아래면 파랗게 적습니다.
      </div>
    </>
  );
}

type SubTab = "foreign" | "short" | "lending";

const SUB_TABS: { key: SubTab; label: string }[] = [
  { key: "foreign", label: "외국인 지분율" },
  { key: "short", label: "공매도" },
  { key: "lending", label: "대차잔고" },
];

export function SupplyDetailPanel({ code }: { code: string }) {
  const [sub, setSub] = useState<SubTab>("foreign");
  const [foreign, setForeign] = useState<RawRecord | null>(null);
  const [short, setShort] = useState<RawRecord | null>(null);
  const [lending, setLending] = useState<RawRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([api.foreignTrend(code), api.shortSale(code, 90), api.stockLending(code, 90)])
      .then(([f, s, l]) => {
        if (cancelled) return;
        setForeign(f as RawRecord);
        setShort(s as RawRecord);
        setLending(l as RawRecord);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  // 응답은 최신순 → 차트는 시간순이 필요하므로 뒤집는다
  const foreignRows = pickList(foreign ?? undefined, FOREIGN_KEYS);
  const shortRows = pickList(short ?? undefined, SHORT_KEYS);
  const lendingRows = pickList(lending ?? undefined, LENDING_KEYS);

  const foreignSort = useSortableTable(foreignRows);
  const shortSort = useSortableTable(shortRows);
  const lendingSort = useSortableTable(lendingRows);

  if (loading) return <div className="empty">불러오는 중...</div>;
  if (error) return <div className="error-banner">{error}</div>;

  return (
    <div>
      <div className="filter-row">
        {SUB_TABS.map((t) => (
          <button
            key={t.key}
            className={`filter-btn ${sub === t.key ? "active" : ""}`}
            onClick={() => setSub(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {sub === "foreign" && (
        <>
          <div className="chart-wrap">
            <TrendLineChart
              series={[
                priceSeries(foreignRows),
                { label: "외국인 지분율(%)", color: "#4ade80", axis: "right", data: seriesFrom(foreignRows, "wght", num) },
              ]}
            />
          </div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <SortableTh columnKey="dt" label="일자" accessor={(r: RawRecord) => String(r.dt ?? "")} sort={foreignSort} className="sticky-col" />
                  <SortableTh columnKey="close" label="종가" accessor={(r: RawRecord) => absNum(r.close_pric)} sort={foreignSort} />
                  <SortableTh columnKey="chg" label="변동수량" accessor={(r: RawRecord) => num(r.chg_qty)} sort={foreignSort} />
                  <SortableTh columnKey="poss" label="보유주식수" accessor={(r: RawRecord) => num(r.poss_stkcnt)} sort={foreignSort} />
                  <SortableTh columnKey="wght" label="지분율(%)" accessor={(r: RawRecord) => num(r.wght)} sort={foreignSort} />
                </tr>
              </thead>
              <tbody>
                {foreignSort.sorted.map((r, i) => (
                  <tr key={i}>
                    <td className="sticky-col">{fmtDt(String(r.dt ?? ""))}</td>
                    <td>{fmtNum(absNum(r.close_pric))}</td>
                    <td className={signClass(r.chg_qty)}>{fmtNum(num(r.chg_qty))}</td>
                    <td>{fmtNum(num(r.poss_stkcnt))}</td>
                    <td className="strong-col">{fmtNum(num(r.wght))}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="table-note">지분율이 꾸준히 오르면 외국인이 비중을 늘리고 있다는 뜻입니다</div>
          </div>
        </>
      )}

      {sub === "short" && (
        <>
          <div className="chart-wrap">
            <TrendLineChart
              series={[
                priceSeries(shortRows),
                { label: "공매도 비중(%)", color: "#f0555f", axis: "right", data: seriesFrom(shortRows, "trde_wght", num) },
              ]}
            />
          </div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <SortableTh columnKey="dt" label="일자" accessor={(r: RawRecord) => String(r.dt ?? "")} sort={shortSort} className="sticky-col" />
                  <SortableTh columnKey="close" label="종가" accessor={(r: RawRecord) => absNum(r.close_pric)} sort={shortSort} />
                  <SortableTh columnKey="flu" label="등락률" accessor={(r: RawRecord) => num(r.flu_rt)} sort={shortSort} />
                  <SortableTh columnKey="qty" label="공매도량" accessor={(r: RawRecord) => num(r.shrts_qty)} sort={shortSort} />
                  <SortableTh columnKey="wght" label="매매비중(%)" accessor={(r: RawRecord) => num(r.trde_wght)} sort={shortSort} />
                  <SortableTh columnKey="avg" label="평균가" accessor={(r: RawRecord) => absNum(r.shrts_avg_pric)} sort={shortSort} />
                </tr>
              </thead>
              <tbody>
                {shortSort.sorted.map((r, i) => (
                  <tr key={i}>
                    <td className="sticky-col">{fmtDt(String(r.dt ?? ""))}</td>
                    <td>{fmtNum(absNum(r.close_pric))}</td>
                    <td className={signClass(r.flu_rt)}>{fmtNum(num(r.flu_rt))}%</td>
                    <td>{fmtNum(num(r.shrts_qty))}</td>
                    <td className="strong-col">{fmtNum(num(r.trde_wght))}%</td>
                    <td>{fmtNum(absNum(r.shrts_avg_pric))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="table-note">
              매매비중은 그날 거래량 중 공매도가 차지한 비율입니다. 비중이 급증하면 하락 베팅이 몰렸다는 신호로 봅니다
            </div>
          </div>
        </>
      )}

      {sub === "lending" && (
        <>
          <div className="chart-wrap">
            <TrendLineChart
              series={[
                { label: "대차잔고(주)", color: "#c084fc", axis: "right", data: seriesFrom(lendingRows, "rmnd", num) },
              ]}
            />
          </div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <SortableTh columnKey="dt" label="일자" accessor={(r: RawRecord) => String(r.dt ?? "")} sort={lendingSort} className="sticky-col" />
                  <SortableTh columnKey="cntr" label="체결주수" accessor={(r: RawRecord) => num(r.dbrt_trde_cntrcnt)} sort={lendingSort} />
                  <SortableTh columnKey="rpy" label="상환주수" accessor={(r: RawRecord) => num(r.dbrt_trde_rpy)} sort={lendingSort} />
                  <SortableTh columnKey="irds" label="증감" accessor={(r: RawRecord) => num(r.dbrt_trde_irds)} sort={lendingSort} />
                  <SortableTh columnKey="rmnd" label="잔고주수" accessor={(r: RawRecord) => num(r.rmnd)} sort={lendingSort} />
                  <SortableTh columnKey="amt" label="잔고금액(백만)" accessor={(r: RawRecord) => num(r.remn_amt)} sort={lendingSort} />
                </tr>
              </thead>
              <tbody>
                {lendingSort.sorted.map((r, i) => (
                  <tr key={i}>
                    <td className="sticky-col">{fmtDt(String(r.dt ?? ""))}</td>
                    <td>{fmtNum(num(r.dbrt_trde_cntrcnt))}</td>
                    <td>{fmtNum(num(r.dbrt_trde_rpy))}</td>
                    <td className={signClass(r.dbrt_trde_irds)}>{fmtNum(num(r.dbrt_trde_irds))}</td>
                    <td className="strong-col">{fmtNum(num(r.rmnd))}</td>
                    <td>{fmtNum(num(r.remn_amt))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="table-note">
              대차잔고는 빌려간 주식 중 아직 안 갚은 물량입니다. 공매도의 선행 지표로 보며, 잔고가 늘면 하락 압력이 쌓이는 것으로 해석합니다
            </div>
          </div>
        </>
      )}
    </div>
  );
}
