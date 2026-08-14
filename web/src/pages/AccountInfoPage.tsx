import { useEffect, useState } from "react";
import { api, normalizeStockCode, pick, pickList, type RawRecord, type StockSearchResult } from "../api";
import { RawJson } from "../components/RawJson";
import { CollapsibleCard } from "../components/CollapsibleCard";
import { RefreshBar } from "../components/RefreshBar";

// 아래 필드명은 키움 REST API 공식 문서(kt00018 계좌평가잔고내역요청) 기준으로 확인된 값.
const HOLDINGS_LIST_KEYS = ["acnt_evlt_remn_indv_tot"];
const NAME_KEYS = ["stk_nm"];
const CODE_KEYS = ["stk_cd"];
const QTY_KEYS = ["rmnd_qty"];
const CUR_PRICE_KEYS = ["cur_prc"];
const EVAL_AMT_KEYS = ["evlt_amt"];
const PNL_KEYS = ["evltv_prft"];
const PNL_RATE_KEYS = ["prft_rt"];

// 계좌 요약: kt00018 응답의 총계 필드 (예수금은 kt00001에서 별도 조회)
const TOTAL_EVAL_KEYS = ["tot_evlt_amt"];
const TOTAL_PNL_KEYS = ["tot_evlt_pl"];
const TOTAL_PNL_RATE_KEYS = ["tot_prft_rt"];
const DEPOSIT_KEYS = ["entr"];

function fmtNumber(v: string): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return n.toLocaleString("ko-KR");
}

function signClass(v: string): string {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return "";
  return n > 0 ? "positive" : "negative";
}

export function AccountInfoPage({ onSelectStock }: { onSelectStock: (code: string, name: string) => void }) {
  const [deposit, setDeposit] = useState<RawRecord | null>(null);
  const [holdings, setHoldings] = useState<RawRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<StockSearchResult[]>([]);
  const [searching, setSearching] = useState(false);

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

  async function load() {
    try {
      const [depositRes, holdingsRes] = await Promise.all([api.accountDeposit(), api.holdings()]);
      setDeposit(depositRes as RawRecord);
      setHoldings(holdingsRes as RawRecord);
      setError(null);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "알 수 없는 오류");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const timer = setInterval(load, 20_000);
    return () => clearInterval(timer);
  }, []);

  const rows = pickList(holdings ?? undefined, HOLDINGS_LIST_KEYS);

  return (
    <div>
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
        />
        {query.trim() && (
          <div className="search-dropdown">
            {searching && <div className="empty">검색 중...</div>}
            {!searching && searchResults.length === 0 && <div className="empty">검색 결과 없음</div>}
            {!searching &&
              searchResults.map((r) => (
                <button
                  key={r.code}
                  className="search-result-row"
                  onClick={() => openStock(r.code, r.name)}
                >
                  <span className="name">{r.name}</span>
                  <span className="sub">
                    {r.code} · {r.marketName}
                  </span>
                </button>
              ))}
          </div>
        )}
      </div>

      <div className="account-grid">
      <CollapsibleCard id="acctSummary" title="계좌 요약" hint="예수금 · 평가금액 · 손익" defaultOpen>
        {loading && !holdings ? (
          <div className="empty">불러오는 중...</div>
        ) : (
          <div className="summary-grid">
            <div className="summary-item">
              <div className="label">예수금</div>
              <div className="value">{fmtNumber(pick(deposit ?? undefined, DEPOSIT_KEYS))}</div>
            </div>
            <div className="summary-item">
              <div className="label">총평가금액</div>
              <div className="value">{fmtNumber(pick(holdings ?? undefined, TOTAL_EVAL_KEYS))}</div>
            </div>
            <div className="summary-item">
              <div className="label">평가손익</div>
              <div className={`value ${signClass(pick(holdings ?? undefined, TOTAL_PNL_KEYS))}`}>
                {fmtNumber(pick(holdings ?? undefined, TOTAL_PNL_KEYS))}
              </div>
            </div>
            <div className="summary-item">
              <div className="label">수익률</div>
              <div className={`value ${signClass(pick(holdings ?? undefined, TOTAL_PNL_RATE_KEYS))}`}>
                {pick(holdings ?? undefined, TOTAL_PNL_RATE_KEYS)}%
              </div>
            </div>
          </div>
        )}
        {deposit && holdings && <RawJson data={{ deposit, holdings }} />}
      </CollapsibleCard>

      <CollapsibleCard id="acctHoldings" title={`보유종목 (${rows.length})`} hint="종목별 평가손익" defaultOpen>
        {rows.length === 0 && !loading && <div className="empty">보유종목이 없습니다.</div>}
        {rows.map((row, i) => {
          const code = normalizeStockCode(pick(row, CODE_KEYS));
          const name = pick(row, NAME_KEYS);
          const pnlRate = pick(row, PNL_RATE_KEYS);
          return (
            <button
              key={`${code}-${i}`}
              className="holding-row"
              onClick={() => onSelectStock(code, name)}
            >
              <div>
                <div className="name">{name}</div>
                <div className="sub">
                  {fmtNumber(pick(row, QTY_KEYS))}주 · 평가 {fmtNumber(pick(row, EVAL_AMT_KEYS))}
                </div>
              </div>
              <div className="right">
                <div className="price">{fmtNumber(pick(row, CUR_PRICE_KEYS))}</div>
                <div className={`pnl ${signClass(pnlRate)}`}>
                  {fmtNumber(pick(row, PNL_KEYS))} ({pnlRate}%)
                </div>
              </div>
            </button>
          );
        })}
      </CollapsibleCard>
      </div>
    </div>
  );
}
