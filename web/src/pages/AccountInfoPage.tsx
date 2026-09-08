import { useEffect, useMemo, useState } from "react";
import { api, normalizeStockCode, pick, pickList, type RawRecord, type StockSearchResult } from "../api";
import { RawJson } from "../components/RawJson";
import { CollapsibleCard } from "../components/CollapsibleCard";
import { ConcentrationCard } from "../components/ConcentrationCard";
import { RefreshBar } from "../components/RefreshBar";
import { useListKeys } from "../useListKeys";

/**
 * 연동 계좌(키움) — **한 장으로 읽히게** (2026-09-08 다시).
 *
 * 벤티지: "연동계좌 부분 해상도가 길어지니까 내용도 너무 길어지네. 효율적으로 볼 수 있게 전면 개편."
 * 예전엔 왼쪽에 좁은 카드 둘(요약·보유)과 오른쪽에 집중도 막대가 있어서, 넓은 화면에서는 오른쪽이
 * 통째로 비고 보유 종목은 좁은 칸에 세로로 늘어졌다.
 *
 *   ① 요약 띠 — 총자산을 크게, 예수금·평가·손익·당일을 한 줄로
 *   ② 보유 표 — 화면 폭을 다 쓰는 표. 열을 눌러 정렬. 줄을 누르면 상세, 매수·매도는 주문으로
 *   ③ 집중도 — 접힘이 기본. 쏠림을 확인할 때만 편다
 *
 * 필드는 키움 공식 스펙(kt00018 계좌평가잔고내역·kt00001 예수금·kt00004 계좌평가현황) 기준.
 */

const TODAY_PNL_KEYS = ["tdy_lspft", "tdy_lspft_amt"];
const TODAY_PNL_RATE_KEYS = ["tdy_lspft_rt"];
const HOLDINGS_LIST_KEYS = ["acnt_evlt_remn_indv_tot"];
const TOTAL_EVAL_KEYS = ["tot_evlt_amt"];
const TOTAL_PUR_KEYS = ["tot_pur_amt"];
const TOTAL_PNL_KEYS = ["tot_evlt_pl"];
const TOTAL_PNL_RATE_KEYS = ["tot_prft_rt"];
const TOTAL_ASSET_KEYS = ["prsm_dpst_aset_amt"];
const DEPOSIT_KEYS = ["entr"];

interface Row {
  code: string;
  name: string;
  qty: number;
  able: number;
  buy: number;
  cur: number;
  evalAmt: number;
  pnl: number;
  rate: number;
  weight: number;
  credit: string;
  loanDate: string;
  todayBuy: number;
  todaySell: number;
}

const num = (v: string): number => {
  const n = Number(String(v ?? "").replace(/[+,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const fmt = (n: number, d = 0): string => n.toLocaleString("ko-KR", { maximumFractionDigits: d, minimumFractionDigits: d });
const signOf = (n: number): string => (n > 0 ? "positive" : n < 0 ? "negative" : "");
const pctKo = (n: number): string => `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;

type SortKey = keyof Pick<Row, "name" | "qty" | "buy" | "cur" | "evalAmt" | "pnl" | "rate" | "weight">;

export function AccountInfoPage({ onSelectStock }: { onSelectStock: (code: string, name: string) => void }) {
  const [summary, setSummary] = useState<RawRecord | null>(null);
  const [deposit, setDeposit] = useState<RawRecord | null>(null);
  const [holdings, setHoldings] = useState<RawRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<StockSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "evalAmt", dir: -1 });

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      api
        .searchStocks(q)
        .then((res) => setSearchResults(res.results))
        .catch(() => setSearchResults([]))
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  function openStock(code: string, name: string) {
    onSelectStock(normalizeStockCode(code), name);
    setQuery("");
    setSearchResults([]);
  }

  const keys = useListKeys(searchResults, (r) => openStock(r.code, r.name), { itemClass: "search-result-row" });

  async function load() {
    try {
      const [depositRes, holdingsRes, summaryRes] = await Promise.all([api.accountDeposit(), api.holdings(), api.accountSummary().catch(() => null)]);
      setDeposit(depositRes as RawRecord);
      setHoldings(holdingsRes as RawRecord);
      setSummary(summaryRes as RawRecord | null);
      setError(null);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "알 수 없는 오류");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 20_000);
    /* 체결 알림이 오면 즉시 — 주문 화면과 같은 방아쇠 */
    const f = () => void load();
    window.addEventListener("vntg:fill", f);
    return () => {
      clearInterval(timer);
      window.removeEventListener("vntg:fill", f);
    };
  }, []);

  const rows: Row[] = useMemo(
    () =>
      pickList(holdings ?? undefined, HOLDINGS_LIST_KEYS).map((r) => ({
        code: normalizeStockCode(pick(r, ["stk_cd"])),
        name: pick(r, ["stk_nm"]),
        qty: num(pick(r, ["rmnd_qty"])),
        able: num(pick(r, ["trde_able_qty"])),
        buy: num(pick(r, ["pur_pric"])),
        cur: num(pick(r, ["cur_prc"])),
        evalAmt: num(pick(r, ["evlt_amt"])),
        pnl: num(pick(r, ["evltv_prft"])),
        rate: num(pick(r, ["prft_rt"])),
        weight: num(pick(r, ["poss_rt"])),
        credit: pick(r, ["crd_tp_nm"]).trim(),
        loanDate: pick(r, ["crd_loan_dt"]).replace(/\D/g, "").slice(0, 8),
        todayBuy: num(pick(r, ["tdy_buyq"])),
        todaySell: num(pick(r, ["tdy_sellq"])),
      })),
    [holdings],
  );
  const sorted = useMemo(() => {
    const k = sort.key;
    return [...rows].sort((a, b) => {
      const x = a[k];
      const y = b[k];
      if (typeof x === "string" && typeof y === "string") return x.localeCompare(y) * sort.dir;
      return ((Number(x) || 0) - (Number(y) || 0)) * sort.dir;
    });
  }, [rows, sort]);
  const th = (key: SortKey, label: string, right = true) => (
    <th className={`${right ? "r" : ""}${sort.key === key ? " on" : ""}`} onClick={() => setSort((s) => ({ key, dir: s.key === key ? ((s.dir * -1) as 1 | -1) : -1 }))} title="눌러서 정렬">
      {label}
      {sort.key === key ? (sort.dir < 0 ? " ▼" : " ▲") : ""}
    </th>
  );

  const cash = num(pick(deposit ?? undefined, DEPOSIT_KEYS));
  const evalTotal = num(pick(holdings ?? undefined, TOTAL_EVAL_KEYS));
  const purTotal = num(pick(holdings ?? undefined, TOTAL_PUR_KEYS));
  const pnlTotal = num(pick(holdings ?? undefined, TOTAL_PNL_KEYS));
  const rateTotal = num(pick(holdings ?? undefined, TOTAL_PNL_RATE_KEYS));
  const assetTotal = num(pick(holdings ?? undefined, TOTAL_ASSET_KEYS)) || cash + evalTotal;
  const todayPnl = num(pick(summary ?? undefined, TODAY_PNL_KEYS));
  const todayRate = num(pick(summary ?? undefined, TODAY_PNL_RATE_KEYS));
  const stockPct = assetTotal > 0 ? (evalTotal / assetTotal) * 100 : 0;

  return (
    <div className="page acct2">
      <RefreshBar onRefresh={load} loading={loading} updatedAt={lastUpdated} />
      {error && <div className="error-banner">{error}</div>}

      <div className="search-box">
        <input
          className="search-input"
          type="text"
          inputMode="search"
          placeholder="종목명 또는 종목코드 검색"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          {...keys.inputProps}
        />
        {query.trim() && (
          <div className="search-dropdown" role="listbox">
            {searching && <div className="empty">검색 중...</div>}
            {!searching && searchResults.length === 0 && <div className="empty">검색 결과 없음</div>}
            {searchResults.map((r, i) => (
              <button key={r.code} {...keys.itemProps(i)} onClick={() => openStock(r.code, r.name)}>
                <span className="name">{r.name}</span>
                <span className="sub">
                  {r.code} · {r.marketName}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ① 요약 띠 */}
      <div className={`acct2-band ${signOf(pnlTotal)}`}>
        <div className="acct2-main">
          <span className="acct2-l">총자산 (추정예탁자산)</span>
          <b className="acct2-big">{fmt(assetTotal)}</b>
          <span className="acct2-sub">
            주식 {stockPct.toFixed(0)}% · 현금 {(100 - stockPct).toFixed(0)}%
          </span>
          {assetTotal > 0 && (
            <span className="acct2-bar" title={`주식 ${stockPct.toFixed(0)}% · 현금 ${(100 - stockPct).toFixed(0)}%`}>
              <i style={{ width: `${stockPct}%` }} />
            </span>
          )}
        </div>
        <div className="acct2-cells">
          <div className="acct2-cell">
            <span>예수금</span>
            <b>{fmt(cash)}</b>
          </div>
          <div className="acct2-cell">
            <span>매입금액</span>
            <b>{fmt(purTotal)}</b>
          </div>
          <div className="acct2-cell">
            <span>평가금액</span>
            <b>{fmt(evalTotal)}</b>
          </div>
          <div className={`acct2-cell ${signOf(pnlTotal)}`}>
            <span>평가손익</span>
            <b>
              {pnlTotal > 0 ? "+" : ""}
              {fmt(pnlTotal)}
            </b>
            <small>{pctKo(rateTotal)}</small>
          </div>
          <div className={`acct2-cell today ${signOf(todayPnl)}`}>
            <span>당일 손익</span>
            <b>
              {todayPnl > 0 ? "+" : ""}
              {fmt(todayPnl)}
            </b>
            <small>{pctKo(todayRate)}</small>
          </div>
        </div>
      </div>

      {/* ② 보유 표 */}
      <section className="card acct2-hold">
        <div className="acct2-hold-h">
          <b>보유종목 {rows.length}</b>
          <small>열을 누르면 정렬 · 줄을 누르면 종목 상세 · 매수·매도는 주문 메뉴로</small>
          <RawJson data={holdings} />
        </div>
        {rows.length === 0 && !loading && <div className="empty">보유종목이 없습니다.</div>}
        {rows.length > 0 && (
          <div className="ord-scroll">
            <table className="ord-table acct2-table">
              <thead>
                <tr>
                  {th("name", "종목", false)}
                  {th("qty", "수량")}
                  {th("buy", "매입가")}
                  {th("cur", "현재가")}
                  {th("evalAmt", "평가금액")}
                  {th("pnl", "평가손익")}
                  {th("rate", "수익률")}
                  {th("weight", "비중")}
                  <th />
                </tr>
              </thead>
              <tbody>
                {sorted.map((r, i) => (
                  <tr key={`${r.code}-${r.credit}-${r.loanDate ?? ""}`} className="acct2-row" onClick={() => onSelectStock(r.code, r.name)}>
                    <td className="acct2-name">
                      <b>{r.name}</b>
                      <span className="ord-code">{r.code}</span>
                      {r.credit && r.credit !== "현금" && (
                        <i className="ord-crd ok" title={r.loanDate ? `대출일 ${r.loanDate}` : undefined}>
                          {r.credit}
                        </i>
                      )}
                      {(r.todayBuy > 0 || r.todaySell > 0) && (
                        <small className="acct2-today">
                          오늘 {r.todayBuy > 0 ? `+${fmt(r.todayBuy)}` : ""}
                          {r.todaySell > 0 ? ` −${fmt(r.todaySell)}` : ""}
                        </small>
                      )}
                    </td>
                    <td className="r num">
                      {fmt(r.qty)}
                      {r.able !== r.qty && <small className="acct2-dim"> / 가능 {fmt(r.able)}</small>}
                    </td>
                    <td className="r num">{fmt(r.buy)}</td>
                    <td className={`r num ${signOf(r.cur - r.buy)}`}>{fmt(r.cur)}</td>
                    <td className="r num">{fmt(r.evalAmt)}</td>
                    <td className={`r num ${signOf(r.pnl)}`}>
                      {r.pnl > 0 ? "+" : ""}
                      {fmt(r.pnl)}
                    </td>
                    <td className={`r num ${signOf(r.rate)}`}>{pctKo(r.rate)}</td>
                    <td className="r num">
                      <span className="acct2-w">
                        <i style={{ width: `${Math.min(100, r.weight)}%` }} />
                      </span>
                      {r.weight.toFixed(1)}%
                    </td>
                    <td className="acct2-acts" onClick={(e) => e.stopPropagation()}>
                      <a className="ord-x buy" href={`#/order?stk=${r.code}&name=${encodeURIComponent(r.name)}&side=buy`}>
                        매수
                      </a>
                      <a
                        className="ord-x sell"
                        href={`#/order?stk=${r.code}&name=${encodeURIComponent(r.name)}&side=sell&qty=${r.able || r.qty}${r.credit && r.credit !== "현금" ? `&credit=1&loan=${r.loanDate}` : ""}`}
                      >
                        매도
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ③ 집중도 — 접힘이 기본 */}
      <CollapsibleCard id="acctConc" title="보유 집중도" hint="업종·내 테마별 비중 — 쏠림을 확인할 때만 편다">
        <ConcentrationCard />
      </CollapsibleCard>
    </div>
  );
}
