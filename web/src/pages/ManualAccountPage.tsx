import { useEffect, useState } from "react";
import {
  api,
  fmtNum,
  normalizeStockCode,
  signClass,
  type EvaluatedAccount,
  type StockSearchResult,
} from "../api";
import { RefreshBar } from "../components/RefreshBar";

/**
 * 수동 계좌 — 키움 외 증권사 보유 종목을 직접 적어두고 계좌별 수익률만 확인한다.
 * 평단가·수량만 저장하고 평가금액은 조회할 때 계산하므로 값이 낡지 않는다.
 * 연동 계좌와 합산하지 않고 계좌별로 따로 본다 (사용자 요청).
 */

function pct(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "-";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

/** 종목 검색 + 평단/수량 입력 폼 */
function AddHoldingForm({ accountId, onDone }: { accountId: string; onDone: (a: EvaluatedAccount[]) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<StockSearchResult[]>([]);
  const [picked, setPicked] = useState<{ code: string; name: string } | null>(null);
  const [avgPrice, setAvgPrice] = useState("");
  const [qty, setQty] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (!q || picked) {
      setResults([]);
      return;
    }
    const t = setTimeout(() => {
      api
        .searchStocks(q)
        .then((r) => setResults(r.results))
        .catch(() => setResults([]));
    }, 300);
    return () => clearTimeout(t);
  }, [query, picked]);

  async function submit() {
    if (!picked) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await api.manualHoldingAdd(accountId, {
        code: picked.code,
        name: picked.name,
        avgPrice: Number(avgPrice) || 0,
        qty: Number(qty) || 0,
      });
      onDone(res.accounts);
      setPicked(null);
      setQuery("");
      setAvgPrice("");
      setQty("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "추가 실패");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ma-form">
      {err && <div className="error-banner">{err}</div>}
      {picked ? (
        <div className="ma-form-row">
          <span className="ma-picked">
            {picked.name} <span className="rl-sub">{picked.code}</span>
          </span>
          <input
            className="ma-input"
            type="number"
            inputMode="numeric"
            placeholder="평단가"
            value={avgPrice}
            onChange={(e) => setAvgPrice(e.target.value)}
          />
          <input
            className="ma-input"
            type="number"
            inputMode="numeric"
            placeholder="수량"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
          />
          <button className="filter-btn active" onClick={submit} disabled={busy}>
            {busy ? "저장 중" : "추가"}
          </button>
          <button className="filter-btn" onClick={() => setPicked(null)}>
            취소
          </button>
        </div>
      ) : (
        <div className="search-box">
          <input
            className="search-input"
            placeholder="종목명 또는 종목코드로 검색해서 추가"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {results.length > 0 && (
            <div className="search-dropdown">
              {results.map((r) => (
                <button
                  key={r.code}
                  className="search-result-row"
                  onClick={() => setPicked({ code: normalizeStockCode(r.code), name: r.name })}
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
      )}
    </div>
  );
}

export function ManualAccountPage({
  onSelectStock,
}: {
  onSelectStock: (code: string, name: string) => void;
}) {
  const [accounts, setAccounts] = useState<EvaluatedAccount[]>([]);
  const [brokers, setBrokers] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [newBroker, setNewBroker] = useState("");
  const [newName, setNewName] = useState("");

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.manualAccounts();
      setAccounts(res.accounts);
      setUpdatedAt(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "불러오기 실패");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    api
      .manualBrokers()
      .then((r) => {
        setBrokers(r.brokers);
        setNewBroker(r.brokers[0] ?? "");
      })
      .catch(() => setBrokers([]));
  }, []);

  async function createAccount() {
    if (!newBroker) return;
    try {
      const res = await api.manualAccountAdd(newBroker, newName);
      setAccounts(res.accounts);
      setNewName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "계좌 추가 실패");
    }
  }

  async function deleteAccount(id: string, label: string) {
    if (!window.confirm(`'${label}' 계좌를 삭제할까요? 입력한 종목도 함께 사라집니다.`)) return;
    try {
      setAccounts((await api.manualAccountRemove(id)).accounts);
    } catch (err) {
      setError(err instanceof Error ? err.message : "계좌 삭제 실패");
    }
  }

  async function deleteHolding(id: string, code: string) {
    try {
      setAccounts((await api.manualHoldingRemove(id, code)).accounts);
    } catch (err) {
      setError(err instanceof Error ? err.message : "종목 삭제 실패");
    }
  }

  return (
    <div>
      <RefreshBar onRefresh={load} loading={loading} updatedAt={updatedAt} />

      {error && <div className="error-banner">{error}</div>}

      <section className="card">
        <h2>수동 계좌 추가</h2>
        <div className="ma-form-row">
          <select className="group-select" value={newBroker} onChange={(e) => setNewBroker(e.target.value)}>
            {brokers.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
          <input
            className="ma-input wide"
            placeholder="계좌 별칭 (예: 연금저축, ISA)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <button className="filter-btn active" onClick={createAccount}>
            계좌 추가
          </button>
        </div>
        <div className="table-note">
          키움 외 증권사 보유분을 직접 적어두는 곳입니다. 현재가는 키움 시세로 자동 계산되며,
          주문 기능은 없습니다.
        </div>
      </section>

      {!loading && accounts.length === 0 && (
        <div className="page-note">등록된 수동 계좌가 없습니다. 위에서 증권사를 골라 추가하세요.</div>
      )}

      {accounts.map((a) => (
        <section className="card ma-account" key={a.id}>
          <div className="ma-head">
            <div>
              <span className="ma-broker">{a.broker}</span>
              <span className="ma-name">{a.name}</span>
            </div>
            <button className="row-del-btn" onClick={() => deleteAccount(a.id, `${a.broker} ${a.name}`)}>
              계좌 삭제
            </button>
          </div>

          <div className="summary-grid">
            <div className="summary-item">
              <div className="label">매입금액</div>
              <div className="value">{fmtNum(Math.round(a.totalCost))}</div>
            </div>
            <div className="summary-item">
              <div className="label">평가금액</div>
              <div className="value">{fmtNum(Math.round(a.totalValue))}</div>
            </div>
            <div className="summary-item">
              <div className="label">평가손익</div>
              <div className={`value ${signClass(a.totalProfit)}`}>
                {a.totalProfit > 0 ? "+" : ""}
                {fmtNum(Math.round(a.totalProfit))}
              </div>
            </div>
            <div className="summary-item">
              <div className="label">수익률</div>
              <div className={`value ${signClass(a.totalReturnRate)}`}>{pct(a.totalReturnRate)}</div>
            </div>
          </div>

          {a.holdings.length > 0 && (
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="sticky-col">종목명</th>
                    <th>평단가</th>
                    <th>수량</th>
                    <th>현재가</th>
                    <th>당일</th>
                    <th>평가금액</th>
                    <th>평가손익</th>
                    <th>수익률</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {a.holdings.map((h) => (
                    <tr
                      key={h.code}
                      className="clickable-row"
                      onClick={() => onSelectStock(h.code, h.name)}
                    >
                      <td className="sticky-col">{h.name}</td>
                      <td>{fmtNum(h.avgPrice)}</td>
                      <td>{fmtNum(h.qty)}</td>
                      <td>{fmtNum(h.price)}</td>
                      <td className={signClass(h.changeRate)}>{pct(h.changeRate)}</td>
                      <td>{fmtNum(Math.round(h.value))}</td>
                      <td className={signClass(h.profit)}>
                        {h.profit > 0 ? "+" : ""}
                        {fmtNum(Math.round(h.profit))}
                      </td>
                      <td className={signClass(h.returnRate)}>{pct(h.returnRate)}</td>
                      <td>
                        <button
                          className="row-del-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteHolding(a.id, h.code);
                          }}
                          title="이 종목 삭제"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <AddHoldingForm accountId={a.id} onDone={setAccounts} />
        </section>
      ))}
    </div>
  );
}
