import { Fragment, useEffect, useState } from "react";
import {
  api,
  fmtNum,
  normalizeStockCode,
  signClass,
  type EvaluatedAccount,
  type EvaluatedHolding,
  type StockSearchResult,
} from "../api";
import { useListKeys } from "../useListKeys";
import { SortableTh, useSortableTable } from "../useSortableTable";
import { CollapsibleCard } from "../components/CollapsibleCard";
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

/**
 * 계좌의 **당일 손익** — 보유 종목의 등락률에서 되짚는다.
 *
 * ## 왜 계산해야 하나
 *
 * 연동 계좌는 키움이 `tdy_lspft`(당일 손익금)를 그대로 준다. 수동 계좌는 우리가
 * 평단가와 수량만 들고 있고 **어제 종가를 저장하지 않으므로** 받아올 데가 없다.
 * 다만 종목마다 오늘 등락률은 이미 조회하고 있으니, 거기서 어제 종가를 되짚을 수 있다.
 *
 *   어제 종가 = 현재가 ÷ (1 + 등락률/100)
 *   당일 손익 = Σ 수량 × (현재가 − 어제 종가)
 *
 * ## 예수금은 안 넣는다
 *
 * 계좌 등락률의 분모는 **어제 주식 평가금액**이지 총자산이 아니다. 예수금을 섞으면
 * 현금 비중이 큰 계좌일수록 등락률이 작아 보여서, 같은 종목을 같은 수량 들고 있어도
 * 계좌마다 다른 숫자가 나온다 — 오늘 주식이 얼마나 움직였나를 묻는 값이 아니게 된다.
 *
 * ## 못 하는 것
 *
 * **오늘 사고판 것은 반영이 안 된다.** 지금 들고 있는 것만 보므로, 오늘 산 종목은
 * 매수가가 아니라 어제 종가부터 잰 값이 잡히고 오늘 판 것은 아예 안 잡힌다.
 * 체결 내역을 적는 자리가 없으니 여기까지가 정직한 한계다.
 */
function todayPnl(holdings: { qty: number; price: number; changeRate: number | null }[]): {
  profit: number;
  rate: number | null;
} {
  let profit = 0;
  let base = 0;
  for (const h of holdings) {
    const rate = h.changeRate;
    if (rate === null || !Number.isFinite(rate) || !Number.isFinite(h.price)) continue;
    const prev = h.price / (1 + rate / 100);
    if (!Number.isFinite(prev) || prev <= 0) continue;
    profit += h.qty * (h.price - prev);
    base += h.qty * prev;
  }
  return { profit, rate: base > 0 ? (profit / base) * 100 : null };
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

  const keys = useListKeys(
    results,
    (r) => setPicked({ code: normalizeStockCode(r.code), name: r.name }),
    { itemClass: "search-result-row" },
  );

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
            onKeyDown={(e) => e.key === "Enter" && !busy && submit()}
          />
          <input
            className="ma-input"
            type="number"
            inputMode="numeric"
            placeholder="수량"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !busy && submit()}
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
            {...keys.inputProps}
          />
          {results.length > 0 && (
            <div className="search-dropdown" role="listbox">
              {results.map((r, i) => (
                <button
                  key={r.code}
                  {...keys.itemProps(i)}
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

/**
 * 예수금이 총자산에서 차지하는 비율(%).
 * 총자산이 0 이면 낼 수 없다 — 0 으로 나누느니 없다고 말하는 게 맞다.
 */
function cashPct(a: { totalAssets: number; cash: number }): number | null {
  if (!Number.isFinite(a.totalAssets) || a.totalAssets <= 0) return null;
  return Math.round((a.cash / a.totalAssets) * 100);
}

export function ManualAccountPage({
  onSelectStock,
}: {
  onSelectStock: (code: string, name: string) => void;
}) {
  const [accounts, setAccounts] = useState<EvaluatedAccount[]>([]);
  const [brokers, setBrokers] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [cashDraft, setCashDraft] = useState<Record<string, string>>({});
  const [cashBusy, setCashBusy] = useState<string | null>(null);
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

  /**
   * 예수금 또는 총자산 저장 — 입력 중인 값은 계좌별로 따로 들고 있는다.
   *
   * 어느 쪽을 붙박이로 둘지는 계좌마다 고른다(`anchorDraft`, 없으면 저장된 anchor).
   * 총자산 기준이면 서버가 예수금을 `총자산 − 주식평가액` 으로 매번 다시 낸다 —
   * 벤티지: "잔고 기준이면 따로 예수금 수정 안 해도 되잖아".
   */
  const [anchorDraft, setAnchorDraft] = useState<Record<string, "cash" | "total">>({});
  const anchorOf = (a: { id: string; anchor?: "cash" | "total" }) => anchorDraft[a.id] ?? a.anchor ?? "cash";
  async function saveCash(id: string) {
    const raw = cashDraft[id];
    if (raw === undefined) return;
    const a = accounts.find((x) => x.id === id);
    setCashBusy(id);
    try {
      setAccounts((await api.manualAccountCash(id, Number(raw), a ? anchorOf(a) : "cash")).accounts);
      setCashDraft((p) => {
        const next = { ...p };
        delete next[id];
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "예수금 저장 실패");
    } finally {
      setCashBusy(null);
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

  /**
   * 보유 종목 고치기 (2026-09-08 — 벤티지 "일부매도 반영하려니깐 안되네").
   *
   * 서버 upsert 는 같은 종목이면 덮어쓰므로 **최종 평단·수량만 보내면 된다.**
   * 계산(매도 뒤 남는 수량, 추가 매수 뒤 새 평단)은 표 안에서 미리 보여 주고 한다.
   * 수량이 0 이 되면 삭제다 — 0주짜리 줄을 남길 이유가 없다.
   */
  async function saveHolding(id: string, h: { code: string; name: string; avgPrice: number; qty: number }) {
    if (h.qty <= 0) {
      await deleteHolding(id, h.code);
      return;
    }
    setAccounts((await api.manualHoldingAdd(id, h)).accounts);
  }

  return (
    <div>
      <RefreshBar onRefresh={load} loading={loading} updatedAt={updatedAt} />

      {error && <div className="error-banner">{error}</div>}

      <CollapsibleCard
        id="manualAdd"
        title="수동 계좌 추가"
        hint="키움 외 증권사 보유분을 직접 등록합니다."
      >
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
      </CollapsibleCard>

      {!loading && accounts.length === 0 && (
        <div className="page-note">등록된 수동 계좌가 없습니다. 위에서 증권사를 골라 추가하세요.</div>
      )}

      {accounts.map((a) => {
        const today = todayPnl(a.holdings);
        return (
        <CollapsibleCard
          key={a.id}
          id={`manualAcct-${a.id}`}
          title={`${a.broker} ${a.name}`}
          /*
            접힌 상태에서 **당일과 누적을 둘 다, 이름을 붙여서** 보여준다.

            ⚠️ 당일만 띄웠다가 크게 헷갈렸다. 누적 −20.79% 인 계좌가 오늘 올랐다는
            이유로 「+264,993 · +11.56%」라고 **빨갛게** 떠서, 접어 놓고 보면
            잘 가고 있는 계좌로 읽혔다. 둘은 방향이 정반대일 수 있는 값이라
            **한쪽만 보여주면 반드시 오해가 생긴다.**

            그렇다고 누적만 두면 오늘 어느 쪽으로 갔는지를 매번 펼쳐 봐야 한다.
            둘 다 두되 무엇이 무엇인지 글자로 못 박는다 — 색만으로는 못 가른다.
          */
          /*
            **누적이 먼저다.** 계좌를 보며 제일 먼저 알아야 할 것은
            「지금까지 얼마 벌었나·잃었나」지 오늘 얼마 움직였나가 아니다.
            당일을 앞에 두었더니 오늘 오른 것만 눈에 들어와서 **총 손익이 흐려졌다.**

            크기도 갈라 둔다. 나란히 같은 글씨로 두면 어느 쪽이 그 계좌의 성적인지
            매번 글자를 읽어 가려야 한다 — 누적은 굵게, 당일은 작게 괄호 안에.
          */
          badge={
            <span className="ma-badge">
              <span className={`ma-total ${signClass(a.totalProfit)}`}>
                {a.totalProfit > 0 ? "+" : ""}
                {fmtNum(Math.round(a.totalProfit))} {pct(a.totalReturnRate)}
              </span>
              <span className={`ma-today ${signClass(today.profit)}`}>
                (당일 {today.profit > 0 ? "+" : ""}
                {fmtNum(Math.round(today.profit))} {pct(today.rate)})
              </span>
            </span>
          }
          /*
            ⚠️ 셋을 「총자산 X · 주식 Y · 예수금 Z」로 **나열했더니 안 읽혔다.**
            같은 크기 같은 색 숫자가 셋이면 눈이 어디를 봐야 할지 모른다.

            총자산이 그 계좌의 크기이므로 **그것만 크게** 두고, 주식과 예수금은
            그것을 나눈 것이니 **아래에 작게, 막대로 비율까지** 보인다.
            현금 비중이 눈에 보이는 게 특히 쓸모 있다 — 지금처럼 관망이 많은 장에서는
            「얼마나 쉬고 있나」가 곧 그 계좌의 자세다.
          */
          hint={
            <span className="ma-hint">
              <span className="ma-hint-top">
                <em>총자산</em>
                <b>{fmtNum(Math.round(a.totalAssets))}</b>
              </span>
              {/*
                ⚠️ 총자산이 0 이면 **막대를 아예 안 그린다.** 빈 계좌에 파란 막대가 꽉 차
                있으면 「주식 100%」로 읽힌다 — 아무것도 없는 것과 다 주식인 것은 정반대다.
              */}
              {cashPct(a) !== null && (
                <span
                  className="ma-hint-bar"
                  title={`주식 ${100 - cashPct(a)!}% · 예수금 ${cashPct(a)}%`}
                >
                  <i className="ma-hint-stock" style={{ width: `${100 - cashPct(a)!}%` }} />
                </span>
              )}
              <span className="ma-hint-split">
                <span>
                  <em>주식</em> {fmtNum(Math.round(a.totalValue))}
                </span>
                <span className="ma-hint-cash">
                  <em>예수금</em> {fmtNum(Math.round(a.cash))}
                  {cashPct(a) !== null && <i> {cashPct(a)}%</i>}
                </span>
              </span>
            </span>
          }
        >
          <div className="ma-head">
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
            {/*
              **당일을 따로 세운다.** 연동 계좌와 같은 자리·같은 이름으로 둔다 —
              같은 것을 두 화면에서 다르게 부르면 견줄 때마다 헷갈린다.
            */}
            <div className="summary-item today">
              <div className="label">당일 손익</div>
              <div className={`value ${signClass(today.profit)}`}>
                {today.profit > 0 ? "+" : ""}
                {fmtNum(Math.round(today.profit))}
              </div>
            </div>
            <div className="summary-item today">
              <div className="label">당일 등락률</div>
              <div className={`value ${signClass(today.rate)}`}>{pct(today.rate)}</div>
            </div>
            <div className="summary-item">
              <div className="label">예수금</div>
              <div className="value">{fmtNum(Math.round(a.cash))}</div>
            </div>
            <div className="summary-item strong">
              <div className="label">총자산</div>
              <div className="value">{fmtNum(Math.round(a.totalAssets))}</div>
            </div>
          </div>

          {/*
            예수금은 받아올 수가 없어 직접 적는다.
            주식 평가액만 보면 같은 계좌라도 전액 매수한 상태인지 절반이 현금인지 구분이 안 된다.
          */}
          {/*
            **예수금 대신 총자산을 적을 수 있다** (2026-09-08 — 벤티지 "잔고에 총자산 입력할 수
            있게 해줘. 그래야 매도 매수 할 때마다 자동으로 예수금이랑 주식잔고랑 연동되지").
            예수금을 붙박이로 두면 종목을 담을 때마다 총자산이 늘어난 것처럼 보여서 예수금을
            손으로 깎아야 했다. 총자산을 붙박이로 두면 예수금 = 총자산 − 주식평가액이라
            종목을 담고 빼는 대로 예수금이 따라온다. 돈을 넣거나 뺐을 때만 총자산을 고친다.
          */}
          <div className="ma-cash">
            <span className="ma-anchor">
              {(["total", "cash"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  className={`filter-btn${anchorOf(a) === k ? " active" : ""}`}
                  title={k === "total" ? "총자산을 적으면 예수금은 주식평가액을 빼서 알아서 냅니다 — 매매할 때마다 예수금을 고칠 필요가 없습니다" : "예수금을 직접 적습니다 — 종목을 담으면 총자산이 그만큼 늘어납니다"}
                  onClick={() => {
                    setAnchorDraft((p) => ({ ...p, [a.id]: k }));
                    /* 기준을 바꾸면 입력칸엔 지금 값이 들어간다 — 빈 칸에서 시작하면 뭘 적어야 할지 모른다 */
                    setCashDraft((p) => ({ ...p, [a.id]: String(k === "total" ? Math.round(a.totalAssets) : Math.round(a.cash)) }));
                  }}
                >
                  {k === "total" ? "총자산" : "예수금"}
                </button>
              ))}
            </span>
            <input
              className="search-input"
              type="number"
              min={0}
              step={10000}
              value={cashDraft[a.id] ?? String(anchorOf(a) === "total" ? Math.round(a.totalAssets) : a.cash)}
              onChange={(e) => setCashDraft((p) => ({ ...p, [a.id]: e.target.value }))}
              onKeyDown={(e) => e.key === "Enter" && void saveCash(a.id)}
            />
            <button
              className="filter-btn"
              onClick={() => void saveCash(a.id)}
              disabled={cashBusy === a.id || cashDraft[a.id] === undefined}
            >
              {cashBusy === a.id ? "저장 중…" : "저장"}
            </button>
            {a.stockRatio !== null && (
              <span className="ma-cash-note">
                주식 {a.stockRatio.toFixed(0)}% · 현금 {(100 - a.stockRatio).toFixed(0)}%
                {a.cashUpdatedAt && ` · ${a.cashUpdatedAt.slice(5, 10)} 입력`}
                {a.anchor === "total" && " · 총자산 기준 — 예수금은 알아서"}
                {a.anchor === "total" && a.totalAnchor !== undefined && a.totalValue > a.totalAnchor && (
                  <b className="negative"> · 주식이 총자산보다 큽니다 — 총자산을 고쳐 주세요</b>
                )}
              </span>
            )}
          </div>

          {a.holdings.length > 0 && (
            <HoldingsTable
              holdings={a.holdings}
              onRow={onSelectStock}
              onDelete={(code) => deleteHolding(a.id, code)}
              onSave={(h) => saveHolding(a.id, h)}
            />
          )}

          <AddHoldingForm accountId={a.id} onDone={setAccounts} />
        </CollapsibleCard>
        );
      })}
    </div>
  );
}

/**
 * 보유 종목 고치기 (2026-09-08).
 *
 * 처음엔 「매도 / 추가 매수 / 직접」 세 탭으로 만들었다 — 판 수량을 넣으면 남는 수량을,
 * 산 수량·단가를 넣으면 새 평단을 계산해 주는 식. 벤티지가 바로 잡았다:
 * "판수량 입력하라고 하면 계산해야 하잖아. 현재 변경 수량 입력하게 해줘야지.
 * 새로 샀을때에도 매수단가를 일일히 모르니깐."
 *
 * 맞는 말이다. 증권사 앱을 열면 **지금 수량과 지금 평단이 그대로 보인다.** 그걸 옮기는
 * 자리에 계산기를 끼워 넣을 이유가 없다. 두 칸에 지금 값을 채워 두고, 바꿀 것만 고친다.
 * 수량을 0 으로 하면 삭제다 — 0주짜리 줄을 남기지 않는다.
 */
function HoldingEditor({
  h,
  onCancel,
  onSave,
}: {
  h: EvaluatedHolding;
  onCancel: () => void;
  onSave: (next: { avgPrice: number; qty: number }) => Promise<void>;
}) {
  const [qty, setQty] = useState(String(h.qty));
  const [avg, setAvg] = useState(String(h.avgPrice));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const n = (v: string) => Number(String(v).replace(/[^\d.]/g, "")) || 0;
  const nextQty = n(qty), nextAvg = n(avg);
  const changed = nextQty !== h.qty || nextAvg !== h.avgPrice;
  const valid = nextQty >= 0 && (nextQty === 0 || nextAvg > 0);
  const note =
    nextQty === 0
      ? "수량 0 — 이 줄이 지워집니다"
      : !changed
        ? ""
        : `${fmtNum(h.qty)}주 @ ${fmtNum(h.avgPrice)} → ${fmtNum(nextQty)}주 @ ${fmtNum(nextAvg)}`;

  async function save() {
    if (!valid || !changed) return;
    setBusy(true);
    setErr(null);
    try {
      await onSave({ avgPrice: nextAvg, qty: nextQty });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "저장 실패");
    } finally {
      setBusy(false);
    }
  }

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && valid && changed && !busy) {
      e.preventDefault();
      void save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };
  return (
    <div className="ma-editor" onClick={(e) => e.stopPropagation()}>
      <div className="ma-editor-row">
        <span className="ma-editor-name">{h.name}</span>
        <label className="ma-editor-field">
          <span>수량</span>
          {/* 엔터로 저장 (2026-09-08 — 벤티지 "꼭 저장을 마우스로 눌러야 되네"). Esc 는 취소 */}
          <input className="ma-input" type="number" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} autoFocus onFocus={(e) => e.target.select()} onKeyDown={onKey} />
        </label>
        <label className="ma-editor-field">
          <span>평단가</span>
          <input className="ma-input" type="number" inputMode="numeric" value={avg} onChange={(e) => setAvg(e.target.value)} onFocus={(e) => e.target.select()} onKeyDown={onKey} />
        </label>
        <button type="button" className="filter-btn active" disabled={!valid || !changed || busy} onClick={() => void save()}>
          {busy ? "저장 중" : nextQty === 0 ? "지우기" : "저장"}
        </button>
        <button type="button" className="filter-btn" onClick={onCancel} disabled={busy}>
          취소
        </button>
      </div>
      {note && <p className={`ma-editor-note${nextQty === 0 ? " bad" : ""}`}>{note}</p>}
      {err && <p className="ma-editor-note bad">{err}</p>}
    </div>
  );
}

/**
 * 계좌 보유 표 — 컬럼 정렬(모든 표 공통 규칙, 2026-08-26).
 * 계좌마다 표가 하나씩이라(맵 안) 훅을 못 쓰던 것을 컴포넌트로 떼어 정렬을 달았다.
 */
function HoldingsTable({
  holdings,
  onRow,
  onDelete,
  onSave,
}: {
  holdings: EvaluatedHolding[];
  onRow: (code: string, name: string) => void;
  onDelete: (code: string) => void;
  onSave: (h: { code: string; name: string; avgPrice: number; qty: number }) => Promise<void>;
}) {
  const sort = useSortableTable<EvaluatedHolding>(holdings);
  /** 지금 고치는 중인 종목 — 한 번에 하나 */
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <div className="data-table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <SortableTh columnKey="name" label="종목명" accessor={(h: EvaluatedHolding) => h.name} sort={sort} className="sticky-col" />
            <SortableTh columnKey="avg" label="평단가" accessor={(h: EvaluatedHolding) => h.avgPrice} sort={sort} />
            <SortableTh columnKey="qty" label="수량" accessor={(h: EvaluatedHolding) => h.qty} sort={sort} />
            <SortableTh columnKey="price" label="현재가" accessor={(h: EvaluatedHolding) => h.price} sort={sort} />
            <SortableTh columnKey="day" label="당일" accessor={(h: EvaluatedHolding) => h.changeRate} sort={sort} />
            <SortableTh columnKey="value" label="평가금액" accessor={(h: EvaluatedHolding) => h.value} sort={sort} />
            <SortableTh columnKey="profit" label="평가손익" accessor={(h: EvaluatedHolding) => h.profit} sort={sort} />
            <SortableTh columnKey="rr" label="수익률" accessor={(h: EvaluatedHolding) => h.returnRate ?? -9999} sort={sort} />
            <th></th>
          </tr>
        </thead>
        <tbody>
          {sort.sorted.map((h) => (
            <Fragment key={h.code}>
              <tr className="clickable-row" onClick={() => onRow(h.code, h.name)}>
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
                <td className="ma-row-acts">
                  <button
                    className={`row-del-btn ma-edit-btn${editing === h.code ? " on" : ""}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditing(editing === h.code ? null : h.code);
                    }}
                    title="수량·평단 고치기 (매도·추가 매수)"
                  >
                    ✎
                  </button>
                  <button
                    className="row-del-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(h.code);
                    }}
                    title="이 종목 삭제"
                  >
                    ✕
                  </button>
                </td>
              </tr>
            </Fragment>
          ))}
        </tbody>
      </table>
      {/*
        편집기는 **표 밖에** 둔다. 표는 폰에서 가로 스크롤인데, 표 안 줄에 넣으면 편집기도
        같이 스크롤되어 저장 단추가 화면 오른쪽으로 잘린다(2026-09-08 확인).
      */}
      {editing &&
        (() => {
          const h = holdings.find((x) => x.code === editing);
          return h ? (
            <HoldingEditor
              key={h.code}
              h={h}
              onCancel={() => setEditing(null)}
              onSave={async (next) => {
                await onSave({ code: h.code, name: h.name, ...next });
                setEditing(null);
              }}
            />
          ) : null;
        })()}
    </div>
  );
}
