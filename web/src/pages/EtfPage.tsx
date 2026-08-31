import { EtfHoldingsTab, EtfThemeTab } from "../components/EtfAnalysisTabs";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  fmtAbsNum,
  fmtNum,
  normalizeStockCode,
  pickList,
  signClass,
  type EtfListRow,
  type RawRecord,
} from "../api";
import { RefreshBar } from "../components/RefreshBar";
import { SortableTh, useSortableTable } from "../useSortableTable";
import { WatchStar } from "../useWatchedCodes";
import { SuperMark } from "../useSuperMarks";
import { EtfWatchTab } from "../components/EtfWatchTab";

/**
 * ETF (2026-08-27 — "퇴직연금에서 ETF도 투자하거든").
 *
 * 세 판으로 구성한다:
 *   ① **시세·NAV** — ka40004 전체 ETF. 정렬이 곧 순위다(거래량 정렬 = 거래량 순위,
 *      등락률 정렬 = 등락률 순위). 괴리율·추적오차·NAV 는 ETF 에만 있는 값이라
 *      시세분석이 아니라 여기가 자리다. 요약칩이 오늘의 특이점을 먼저 말한다.
 *   ② **수급 우위** — 기관/외국인 동일 순매매(ka10062)에서 ETF 만. 둘이 같은
 *      방향으로 사는 ETF 가 「수급 우위」다.
 *   ③ **연속 매매** — 기관/외국인 연속 순매수(ka10131)에서 ETF 만.
 *
 * 행을 누르면 종목 상세 — ETF 탭(구성종목·과세유형·괴리율)이 같이 열린다.
 * 기간별 수익률·과세유형은 상세가 말한다(목록 TR 에 없는 값이라 여기서 지어내지 않는다).
 */

const SUBTABS = [
  /* 내가 굴리는 것이 먼저다 — 전체 시세는 그다음 (2026-08-27) */
  { key: "watch", label: "내 ETF" },
  /*
   * 분석을 앞쪽에 (2026-08-31) — 「뭘 담을까」가 「지금 얼마냐」보다 먼저 오는 물음이다.
   *
   * 두 가지를 **나란히** 둔다. 어느 기준이 맞는지는 비교해야만 알 수 있다
   * (벤티지: "하나의 방법론이니깐 개별 분석 메뉴로 두던지 해서 비교분석 해보면 더 좋겠지").
   *   - 테마 분석  : ETF 이름을 테마·섹터 강세에 잇는다
   *   - 구성종목 분석: ETF 가 담은 종목들이 실제로 어떤가를 본다
   */
  { key: "analysis", label: "테마 분석" },
  { key: "holdings", label: "구성종목 분석" },
  { key: "list", label: "시세·NAV" },
  { key: "cum", label: "기간 등락률" },
  { key: "supply", label: "수급 우위" },
  { key: "cont", label: "연속 매매" },
] as const;
type Sub = (typeof SUBTABS)[number]["key"];

function pct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "-";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function cls(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v) || v === 0) return "";
  return v > 0 ? "positive" : "negative";
}

/* ── ① 시세·NAV ───────────────────────────────────────── */

function EtfListTab({ onSelectStock }: { onSelectStock: (code: string, name: string) => void }) {
  const [rows, setRows] = useState<EtfListRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.etfList();
      setRows(r.rows);
      setUpdatedAt(r.at);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "불러오기 실패");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const kept = useMemo(() => {
    /* 기본은 **거래대금 상위** (2026-08-27 사용자 지정) — 정렬 3번째 클릭의 「원래 순서」도 이것 */
    const list = [...(rows ?? [])].sort((a, b) => b.tradeValue - a.tradeValue);
    const needle = q.trim().toLowerCase();
    if (!needle) return list;
    return list.filter(
      (r) => r.name.toLowerCase().includes(needle) || r.index.toLowerCase().includes(needle) || r.code.includes(needle),
    );
  }, [rows, q]);
  const sort = useSortableTable(kept);

  /* 오늘의 특이점 — 표를 정렬하기 전에 먼저 눈에 들어와야 하는 것들 */
  const chips = useMemo(() => {
    const list = (rows ?? []).filter((r) => r.tradeValue > 0);
    if (list.length === 0) return null;
    const by = <K extends keyof EtfListRow>(k: K, desc = true) =>
      [...list].sort((a, b) => {
        const av = Number(a[k] ?? 0);
        const bv = Number(b[k] ?? 0);
        return desc ? bv - av : av - bv;
      })[0];
    const withDev = list.filter((r) => r.deviation !== null && r.tradeValue >= 10);
    const prem = [...withDev].sort((a, b) => (b.deviation ?? 0) - (a.deviation ?? 0))[0];
    const disc = [...withDev].sort((a, b) => (a.deviation ?? 0) - (b.deviation ?? 0))[0];
    return { tv: by("tradeValue"), up: by("changeRate"), down: by("changeRate", false), prem, disc };
  }, [rows]);

  const chip = (label: string, r: EtfListRow | undefined, value: string, v?: number | null) =>
    r ? (
      <button className="rp-ss-chip" key={label} onClick={() => onSelectStock(r.code, r.name)}>
        <em>{label}</em>
        <b>{r.name}</b>
        <span className={`num ${cls(v ?? r.changeRate)}`}>{value}</span>
      </button>
    ) : null;

  return (
    <>
      <div className="filter-row">
        <RefreshBar onRefresh={() => void load()} loading={loading} updatedAt={updatedAt ?? undefined} />
        <input
          className="search-input etf-search"
          placeholder="이름·추적지수·코드 검색 (예: 코스피, 미국, 반도체)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {q && <span className="breadth-count">{kept.length}건</span>}
      </div>

      {chips && (
        <div className="rp-ss-chips">
          {chip("대금 1위", chips.tv, `${fmtNum(chips.tv?.tradeValue ?? 0)}억`, 1)}
          {chip("급등", chips.up, pct(chips.up?.changeRate))}
          {chip("급락", chips.down, pct(chips.down?.changeRate))}
          {chip("프리미엄", chips.prem, pct(chips.prem?.deviation), chips.prem?.deviation)}
          {chip("디스카운트", chips.disc, pct(chips.disc?.deviation), chips.disc?.deviation)}
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}
      {rows === null && !error && <div className="empty">전체 ETF 시세 불러오는 중…</div>}
      {rows !== null && (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <SortableTh columnKey="name" label="종목명" accessor={(r: EtfListRow) => r.name} sort={sort} className="sticky-col" />
                <SortableTh columnKey="price" label="현재가" accessor={(r: EtfListRow) => r.price} sort={sort} />
                <SortableTh columnKey="rate" label="등락률" accessor={(r: EtfListRow) => r.changeRate} sort={sort} />
                <SortableTh columnKey="tv" label="거래대금(억)" accessor={(r: EtfListRow) => r.tradeValue} sort={sort} />
                <SortableTh columnKey="vol" label="거래량" accessor={(r: EtfListRow) => r.volume} sort={sort} />
                <SortableTh columnKey="nav" label="NAV" accessor={(r: EtfListRow) => r.nav ?? -1} sort={sort} />
                <SortableTh columnKey="dev" label="괴리율" accessor={(r: EtfListRow) => r.deviation ?? -999} sort={sort} />
                <SortableTh columnKey="err" label="추적오차" accessor={(r: EtfListRow) => r.traceErr ?? -1} sort={sort} />
                <SortableTh columnKey="idx" label="추적지수" accessor={(r: EtfListRow) => r.index} sort={sort} />
              </tr>
            </thead>
            <tbody>
              {sort.sorted.slice(0, 300).map((r) => (
                <tr key={r.code} className="clickable-row" onClick={() => onSelectStock(r.code, r.name)}>
                  <td className="sticky-col">
                    <WatchStar code={r.code} />
<SuperMark code={r.code} />
                    {r.name}
                  </td>
                  <td className={`num ${cls(r.changeRate)}`}>{fmtNum(r.price)}</td>
                  <td className={`num ${cls(r.changeRate)}`}>{pct(r.changeRate)}</td>
                  <td className="num">{fmtNum(r.tradeValue)}</td>
                  <td className="num pt-n">{fmtNum(r.volume)}</td>
                  <td className="num pt-n">{r.nav === null ? "-" : fmtNum(Math.round(r.nav))}</td>
                  {/* 괴리율 ±0.5% 넘으면 색 — NAV 보다 비싸게/싸게 사고 있다는 경고 */}
                  <td className={`num ${r.deviation !== null && Math.abs(r.deviation) >= 0.5 ? cls(r.deviation) : ""}`}>
                    {pct(r.deviation)}
                  </td>
                  <td className="num pt-n">{r.traceErr === null ? "-" : `${r.traceErr.toFixed(2)}%`}</td>
                  <td className="pt-n etf-idx-cell" title={r.index}>
                    {r.index || "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="table-note">
        키움 ETF 전체시세(ka40004) · 3분 캐시 · 거래대금은 현재가 × 거래량 어림입니다.
        <b> 괴리율</b> = (현재가 − NAV) ÷ NAV — 양수면 순자산보다 비싸게 거래 중입니다.
        <b> 추적오차</b>가 클수록 지수를 못 따라갑니다. 머리를 눌러 정렬하면 그게 곧
        순위입니다(거래량·등락률·괴리율…). 종목을 누르면 상세 — 구성종목·과세유형까지.
        표는 상위 300까지 그립니다(검색으로 좁혀 보세요).
      </div>
    </>
  );
}

/* ── ①-2 기간 등락률 — 누적등락 계산기를 ETF 모집단으로 (시세분석과 같은 문법) ── */

/** 「내 ETF」 탭도 같은 값을 붙여 쓴다 (2026-08-27) — 두 화면이 같은 계산을 본다 */
export interface CumRow {
  code: string;
  name: string;
  price: number;
  cumRate: number;
  todayRate: number;
  tradeValue: number;
  r3: number | null;
  r5: number | null;
  r10: number | null;
  r20: number | null;
  r60: number | null;
}

/** 구간 컬럼 — 3·5·10·20·60일을 한 표에 편다 (2026-08-27 사용자 지정) */
const CUM_SPANS = [
  { key: "r3", label: "3일" },
  { key: "r5", label: "5일" },
  { key: "r10", label: "10일" },
  { key: "r20", label: "20일" },
  { key: "r60", label: "60일" },
] as const;

function EtfCumTab({ onSelectStock }: { onSelectStock: (code: string, name: string) => void }) {
  const [rows, setRows] = useState<CumRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const sort = useSortableTable<CumRow>(rows ?? []);

  useEffect(() => {
    let alive = true;
    setBusy(true);
    setError(null);
    /* days=5 는 기본 정렬(서버가 5일 누적순으로 준다) — 구간 값은 전부 같이 온다 */
    fetch(`/api/rank/cumulative?days=5&market=ETF&universe=100`)
      .then((r) => r.json())
      .then((j: { rows?: CumRow[]; note?: string; error?: string }) => {
        if (!alive) return;
        if (j.error) setError(j.error);
        setRows(j.rows ?? []);
        setNote(j.note ?? "");
      })
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <>
      <div className="filter-row">
        <span className="pt-n">
          ETF 거래대금 상위 100 을 일봉으로 직접 계산 — 3·5·10·20·60일 누적을 한 표에.
          기본은 5일 누적순, 머리를 눌러 다른 구간으로 정렬합니다. 처음 한 번은 30초쯤
          걸립니다 (10분 캐시).
        </span>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {busy && rows === null && <div className="empty">계산 중… (종목마다 일봉을 받습니다)</div>}
      {rows !== null && rows.length > 0 && (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <SortableTh columnKey="name" label="종목명" accessor={(r: CumRow) => r.name} sort={sort} className="sticky-col" />
                <SortableTh columnKey="price" label="현재가" accessor={(r: CumRow) => r.price} sort={sort} />
                <SortableTh columnKey="today" label="오늘" accessor={(r: CumRow) => r.todayRate} sort={sort} />
                {CUM_SPANS.map((s) => (
                  <SortableTh
                    key={s.key}
                    columnKey={s.key}
                    label={`${s.label} 누적`}
                    accessor={(r: CumRow) => r[s.key] ?? -999}
                    sort={sort}
                  />
                ))}
                <SortableTh columnKey="tv" label="거래대금(억)" accessor={(r: CumRow) => r.tradeValue} sort={sort} />
              </tr>
            </thead>
            <tbody>
              {sort.sorted.map((r) => (
                <tr key={r.code} className="clickable-row" onClick={() => onSelectStock(r.code, r.name)}>
                  <td className="sticky-col">
                    <WatchStar code={r.code} />
<SuperMark code={r.code} />
                    {r.name}
                  </td>
                  <td className="num">{fmtNum(r.price)}</td>
                  <td className={`num ${cls(r.todayRate)}`}>{pct(r.todayRate)}</td>
                  {CUM_SPANS.map((s) => {
                    const v = r[s.key];
                    return (
                      <td key={s.key} className={`num ${s.key === "r5" ? "strong-col " : ""}${cls(v)}`}>
                        {v === null ? "-" : pct(v)}
                      </td>
                    );
                  })}
                  <td className="num pt-n">{fmtNum(r.tradeValue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {note && <div className="table-note">{note} 60일치 봉이 아직 없는 신생 ETF 는 그 칸이 "-" 입니다.</div>}
    </>
  );
}

/* ── ② 수급 우위 (기관/외국인 동일 순매매 중 ETF) ───────── */

function EtfSupplyTab({ onSelectStock }: { onSelectStock: (code: string, name: string) => void }) {
  const [trade, setTrade] = useState("1");
  const [data, setData] = useState<RawRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData((await api.sameNetTradeRanking("000", trade)) as RawRecord);
    } catch (e) {
      setError(e instanceof Error ? e.message : "불러오기 실패");
    } finally {
      setLoading(false);
    }
  }, [trade]);
  useEffect(() => {
    void load();
  }, [load]);

  const rows = pickList(data ?? undefined, ["eql_nettrde_rank"]).filter(
    (r) => (r as { etf?: boolean }).etf === true,
  );
  const sort = useSortableTable(rows);

  return (
    <>
      <div className="filter-row">
        <RefreshBar onRefresh={() => void load()} loading={loading} />
        {[
          { key: "1", label: "동반 순매수" },
          { key: "2", label: "동반 순매도" },
        ].map((t) => (
          <button
            key={t.key}
            className={`filter-btn ${trade === t.key ? "active" : ""}`}
            onClick={() => setTrade(t.key)}
          >
            {t.label}
          </button>
        ))}
        <span className="pt-n">기관·외국인이 같은 방향인 ETF — 순매매 상위에서 골랐습니다</span>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {!loading && !error && rows.length === 0 && (
        <div className="empty">순매매 상위에 든 ETF 가 없습니다 — 오늘은 개별주 판이라는 뜻이기도 합니다.</div>
      )}
      {rows.length > 0 && (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <SortableTh columnKey="name" label="종목명" accessor={(r: RawRecord) => String(r.stk_nm ?? "")} sort={sort} className="sticky-col" />
                <SortableTh columnKey="price" label="현재가" accessor={(r: RawRecord) => Math.abs(Number(r.cur_prc)) || 0} sort={sort} />
                <SortableTh columnKey="rate" label="등락률" accessor={(r: RawRecord) => Number(r.flu_rt) || 0} sort={sort} />
                <SortableTh columnKey="orgn" label="기관(백만)" accessor={(r: RawRecord) => Number(r.orgn_nettrde_amt) || 0} sort={sort} />
                <SortableTh columnKey="for" label="외국인(백만)" accessor={(r: RawRecord) => Number(r.for_nettrde_amt) || 0} sort={sort} />
                <SortableTh columnKey="net" label="합계(백만)" accessor={(r: RawRecord) => Number(r.nettrde_amt) || 0} sort={sort} />
              </tr>
            </thead>
            <tbody>
              {sort.sorted.map((r, i) => {
                const code = normalizeStockCode(String(r.stk_cd ?? ""));
                const name = String(r.stk_nm ?? "");
                return (
                  <tr key={`${code}-${i}`} className="clickable-row" onClick={() => onSelectStock(code, name)}>
                    <td className="sticky-col">
                      <WatchStar code={code} />
<SuperMark code={code} />
                      {name}
                    </td>
                    <td className={signClass(r.pred_pre)}>{fmtAbsNum(r.cur_prc)}</td>
                    <td className={signClass(r.flu_rt)}>{fmtNum(r.flu_rt)}%</td>
                    <td className={signClass(r.orgn_nettrde_amt)}>{fmtNum(r.orgn_nettrde_amt)}</td>
                    <td className={signClass(r.for_nettrde_amt)}>{fmtNum(r.for_nettrde_amt)}</td>
                    <td className={signClass(r.nettrde_amt)}>{fmtNum(r.nettrde_amt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="table-note">동일순매매순위(ka10062)에서 ETF 만 골랐습니다 · 당일 기준 · 백만원 단위</div>
    </>
  );
}

/* ── ③ 연속 매매 (기관/외국인 연속 순매수 중 ETF) ───────── */

function EtfContTab({ onSelectStock }: { onSelectStock: (code: string, name: string) => void }) {
  const [market, setMarket] = useState("001");
  const [data, setData] = useState<RawRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData((await api.continuousTradeRanking(market, "1")) as RawRecord);
    } catch (e) {
      setError(e instanceof Error ? e.message : "불러오기 실패");
    } finally {
      setLoading(false);
    }
  }, [market]);
  useEffect(() => {
    void load();
  }, [load]);

  const rows = pickList(data ?? undefined, ["orgn_frgnr_cont_trde_prst"]).filter(
    (r) => (r as { etf?: boolean }).etf === true,
  );
  const sort = useSortableTable(rows);

  return (
    <>
      <div className="filter-row">
        <RefreshBar onRefresh={() => void load()} loading={loading} />
        {[
          { key: "001", label: "코스피" },
          { key: "101", label: "코스닥" },
        ].map((m) => (
          <button
            key={m.key}
            className={`filter-btn ${market === m.key ? "active" : ""}`}
            onClick={() => setMarket(m.key)}
          >
            {m.label}
          </button>
        ))}
        <span className="pt-n">며칠째 이어서 사는가 — 연속일수가 길수록 의도가 있는 매집입니다</span>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {!loading && !error && rows.length === 0 && (
        <div className="empty">연속매매 목록에 든 ETF 가 없습니다.</div>
      )}
      {rows.length > 0 && (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <SortableTh columnKey="name" label="종목명" accessor={(r: RawRecord) => String(r.stk_nm ?? "")} sort={sort} className="sticky-col" />
                <SortableTh columnKey="orgnDays" label="기관 연속" accessor={(r: RawRecord) => Number(r.orgn_cont_netprps_dys) || 0} sort={sort} />
                <SortableTh columnKey="orgnAmt" label="기관 금액(백만)" accessor={(r: RawRecord) => Number(r.orgn_cont_netprps_amt) || 0} sort={sort} />
                <SortableTh columnKey="forDays" label="외인 연속" accessor={(r: RawRecord) => Number(r.frgnr_cont_netprps_dys) || 0} sort={sort} />
                <SortableTh columnKey="forAmt" label="외인 금액(백만)" accessor={(r: RawRecord) => Number(r.frgnr_cont_netprps_amt) || 0} sort={sort} />
              </tr>
            </thead>
            <tbody>
              {sort.sorted.map((r, i) => {
                const code = normalizeStockCode(String(r.stk_cd ?? ""));
                const name = String(r.stk_nm ?? "");
                return (
                  <tr key={`${code}-${i}`} className="clickable-row" onClick={() => onSelectStock(code, name)}>
                    <td className="sticky-col">
                      <WatchStar code={code} />
<SuperMark code={code} />
                      {name}
                    </td>
                    <td className={signClass(r.orgn_cont_netprps_dys)}>{fmtNum(r.orgn_cont_netprps_dys)}일</td>
                    <td className={signClass(r.orgn_cont_netprps_amt)}>{fmtNum(r.orgn_cont_netprps_amt)}</td>
                    <td className={signClass(r.frgnr_cont_netprps_dys)}>{fmtNum(r.frgnr_cont_netprps_dys)}일</td>
                    <td className={signClass(r.frgnr_cont_netprps_amt)}>{fmtNum(r.frgnr_cont_netprps_amt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="table-note">기관외국인 연속매매현황(ka10131)에서 ETF 만 골랐습니다 · 순매수 기준</div>
    </>
  );
}

export function EtfPage({ onSelectStock }: { onSelectStock: (code: string, name: string) => void }) {
  const [sub, setSub] = useState<Sub>("watch");
  return (
    <div>
      <div className="ov-subtabs">
        {SUBTABS.map((t) => (
          <button key={t.key} className={`ov-subtab${sub === t.key ? " on" : ""}`} onClick={() => setSub(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      {sub === "watch" && <EtfWatchTab onSelectStock={onSelectStock} />}
      {sub === "analysis" && <EtfThemeTab onSelectStock={onSelectStock} />}
      {sub === "holdings" && <EtfHoldingsTab onSelectStock={onSelectStock} />}
      {sub === "list" && <EtfListTab onSelectStock={onSelectStock} />}
      {sub === "cum" && <EtfCumTab onSelectStock={onSelectStock} />}
      {sub === "supply" && <EtfSupplyTab onSelectStock={onSelectStock} />}
      {sub === "cont" && <EtfContTab onSelectStock={onSelectStock} />}
    </div>
  );
}
