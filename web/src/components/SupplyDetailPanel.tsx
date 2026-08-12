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
