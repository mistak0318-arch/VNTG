import { useEffect, useState } from "react";
import {
  api,
  fmtNum,
  normalizeStockCode,
  signClass,
  type EvaluatedTrade,
  type PaperResult,
  type StockSearchResult,
} from "../api";
import { RefreshBar } from "../components/RefreshBar";

/**
 * 모의투자.
 *
 * 잔고 화면처럼 보이지만 목적이 다르다. 증권사 잔고는 "지금 얼마인가"만 말한다.
 * 여기서 답해야 하는 건 **"내 판단이 맞았나, 그리고 무엇을 보고 그렇게 판단했나"** 다.
 *
 * 그래서 살 때의 신호등·시장 상태·테마·업종 수급을 통째로 박제해 두고,
 * 맨 아래에서 **근거별 승률**을 갈라 보여준다 — 내가 믿고 있던 조건이 실제로
 * 값어치를 했는지가 거기서 드러난다.
 */

function pct(n: number): string {
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function stamp(iso: string): string {
  return new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
}

export function PaperTradePage({
  onSelectStock,
}: {
  onSelectStock: (code: string, name: string) => void;
}) {
  const [data, setData] = useState<PaperResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // 새 매수 입력
  const [pick, setPick] = useState<{ code: string; name: string } | null>(null);
  const [entryPrice, setEntryPrice] = useState("");
  const [qty, setQty] = useState("");
  const [thesis, setThesis] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<StockSearchResult[]>([]);

  // 다른 화면과 같은 방식 — 300ms 늦춰서 타이핑마다 조회하지 않는다
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      api
        .searchStocks(q)
        .then((r) => setResults(r.results))
        .catch(() => setResults([]));
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  /** 종목을 고르면 매수가를 현재가로 채워 준다 — 대개 지금 값으로 기록하므로 */
  async function choose(r: StockSearchResult) {
    const code = normalizeStockCode(r.code);
    setPick({ code, name: r.name });
    setQuery("");
    setResults([]);
    try {
      const info = (await api.stockInfo(code)) as Record<string, unknown>;
      const price = Math.abs(Number(String(info.cur_prc ?? "").replace(/[+,]/g, ""))) || 0;
      if (price > 0) setEntryPrice(String(price));
    } catch {
      // 현재가를 못 받아도 직접 적으면 되므로 조용히 넘어간다
    }
  }

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setData(await api.paperTrades());
    } catch (e) {
      setError(e instanceof Error ? e.message : "불러오기 실패");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function submit() {
    if (!pick || !entryPrice || !qty) return;
    setAdding(true);
    setError(null);
    try {
      setData(
        await api.paperTradeAdd({
          code: pick.code,
          name: pick.name,
          entryPrice: Number(entryPrice.replace(/,/g, "")),
          qty: Number(qty.replace(/,/g, "")),
          thesis,
        }),
      );
      setPick(null);
      setEntryPrice("");
      setQty("");
      setThesis("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "기록 실패");
    } finally {
      setAdding(false);
    }
  }

  async function close(t: EvaluatedTrade) {
    const raw = window.prompt(`${t.name} 청산가 (현재 ${fmtNum(t.price)})`, String(t.price));
    if (!raw) return;
    const price = Number(raw.replace(/,/g, ""));
    if (!Number.isFinite(price) || price <= 0) return;
    const note = window.prompt("왜 팔았나요? (복기용, 비워도 됩니다)", "") ?? "";
    try {
      setData(await api.paperTradeClose(t.id, price, note));
    } catch (e) {
      setError(e instanceof Error ? e.message : "청산 실패");
    }
  }

  async function remove(t: EvaluatedTrade) {
    if (!window.confirm(`${t.name} 기록을 지웁니다. 근거도 함께 사라집니다.`)) return;
    try {
      setData(await api.paperTradeRemove(t.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "삭제 실패");
    }
  }

  const s = data?.stats;
  const open = data?.trades.filter((t) => t.open) ?? [];
  const closed = data?.trades.filter((t) => !t.open) ?? [];

  return (
    <div>
      <RefreshBar onRefresh={load} loading={loading} />

      {error && <div className="error-banner">{error}</div>}

      {/* 증권사 잔고처럼 — 먼저 지금 얼마인지 */}
      {s && (
        <section className="pt-summary">
          <div className="pt-sum-cell">
            <span className="pt-sum-label">투자원금</span>
            <span className="pt-sum-value num">{fmtNum(Math.round(s.invested))}원</span>
          </div>
          <div className="pt-sum-cell">
            <span className="pt-sum-label">평가금액</span>
            <span className="pt-sum-value num">{fmtNum(Math.round(s.value))}원</span>
          </div>
          <div className="pt-sum-cell">
            <span className="pt-sum-label">평가손익</span>
            <span className={`pt-sum-value num ${signClass(s.pnl)}`}>
              {s.pnl > 0 ? "+" : ""}
              {fmtNum(Math.round(s.pnl))}원
            </span>
          </div>
          <div className="pt-sum-cell">
            <span className="pt-sum-label">수익률</span>
            <span className={`pt-sum-value num ${signClass(s.returnRate)}`}>{pct(s.returnRate)}</span>
          </div>
          <div className="pt-sum-cell">
            <span className="pt-sum-label">보유 / 청산</span>
            <span className="pt-sum-value num">
              {s.openCount} / {s.closedCount}
            </span>
          </div>
          <div className="pt-sum-cell">
            <span className="pt-sum-label">승률 (청산분)</span>
            <span className="pt-sum-value num">
              {s.winRate === null ? "-" : `${s.winRate.toFixed(0)}%`}
              {s.avgReturn !== null && (
                <span className="pt-sum-sub"> 평균 {pct(s.avgReturn)}</span>
              )}
            </span>
          </div>
        </section>
      )}

      {/* 새 매수 */}
      <section className="pt-entry">
        <div className="pt-entry-row">
          <div className="pt-search">
            <input
              className="pt-input"
              placeholder="종목 검색"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {results.length > 0 && (
              <ul className="pt-results">
                {results.slice(0, 8).map((r) => (
                  <li key={r.code}>
                    <button onClick={() => void choose(r)}>
                      {r.name} <span className="pt-n">{normalizeStockCode(r.code)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {pick && <span className="pt-picked">{pick.name}</span>}
          <input
            className="pt-input"
            inputMode="numeric"
            placeholder="매수가"
            value={entryPrice}
            onChange={(e) => setEntryPrice(e.target.value)}
          />
          <input
            className="pt-input short"
            inputMode="numeric"
            placeholder="수량"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
          />
          <button
            className="algo-run-btn"
            onClick={() => void submit()}
            disabled={adding || !pick || !entryPrice || !qty}
          >
            {adding ? "근거 수집 중…" : "매수 기록"}
          </button>
        </div>
        <input
          className="pt-input wide"
          placeholder="왜 사는가 — 한 줄로 (나중에 이걸 보고 복기합니다)"
          value={thesis}
          onChange={(e) => setThesis(e.target.value)}
        />
        <p className="page-note">
          기록하는 순간의 <b>신호등·시장 상태·테마·업종 수급</b>을 그대로 박제합니다. 나중에
          결과가 나오면 그 근거들과 대조해 <b>무엇을 보고 이겼는지</b>를 셉니다. 실제 주문은
          나가지 않습니다.
        </p>
      </section>

      {/* 보유 */}
      <h3 className="section-heading">보유 {open.length}건</h3>
      {open.length === 0 ? (
        <div className="empty">아직 없습니다. 위에서 첫 매수를 기록해 보세요.</div>
      ) : (
        <TradeTable
          rows={open}
          openId={openId}
          setOpenId={setOpenId}
          onSelectStock={onSelectStock}
          onClose={close}
          onRemove={remove}
        />
      )}

      {closed.length > 0 && (
        <>
          <h3 className="section-heading">청산 {closed.length}건</h3>
          <TradeTable
            rows={closed}
            openId={openId}
            setOpenId={setOpenId}
            onSelectStock={onSelectStock}
            onRemove={remove}
          />
        </>
      )}

      {/* 이 화면의 존재 이유 */}
      <h3 className="section-heading">근거별 성적 — 무엇을 보고 이겼나</h3>
      {data && data.edges.length === 0 ? (
        <div className="page-note">
          청산한 거래가 쌓이면 여기에 나옵니다. 매수 시점의 신호등 항목별로 <b>통과했을 때</b>와
          <b> 못 했을 때</b>의 승률을 갈라 보여줍니다 — 내가 믿고 있던 조건이 실제로 값어치를
          했는지가 거기서 드러납니다. 아직 들고 있는 거래는 결과가 안 나온 것이라 세지 않습니다.
        </div>
      ) : (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th className="sticky-col">조건</th>
                <th>통과 시 승률</th>
                <th>통과 시 평균</th>
                <th>미달 시 승률</th>
                <th>미달 시 평균</th>
                <th>차이</th>
              </tr>
            </thead>
            <tbody>
              {data?.edges.map((e) => (
                <tr key={e.key}>
                  <td className="sticky-col">{e.label}</td>
                  <td className="num">
                    {e.withWinRate === null ? "-" : `${e.withWinRate.toFixed(0)}%`}
                    <span className="pt-n"> ({e.withCount})</span>
                  </td>
                  <td className={`num ${signClass(e.withAvgReturn ?? 0)}`}>
                    {e.withAvgReturn === null ? "-" : pct(e.withAvgReturn)}
                  </td>
                  <td className="num">
                    {e.withoutWinRate === null ? "-" : `${e.withoutWinRate.toFixed(0)}%`}
                    <span className="pt-n"> ({e.withoutCount})</span>
                  </td>
                  <td className={`num ${signClass(e.withoutAvgReturn ?? 0)}`}>
                    {e.withoutAvgReturn === null ? "-" : pct(e.withoutAvgReturn)}
                  </td>
                  <td className={`num ${signClass(e.edge ?? 0)}`}>
                    {e.edge === null ? "-" : `${e.edge > 0 ? "+" : ""}${e.edge.toFixed(0)}%p`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="table-note">
            「차이」가 클수록 그 조건이 실제로 값어치를 했다는 뜻입니다. <b>0에 가깝거나 음수면
            믿고 있었지만 상관이 없던 조건</b>입니다 — 그걸 아는 게 이 화면의 목적입니다.
            표본이 적으면(괄호 안 숫자) 아직 우연일 수 있습니다.
          </div>
        </div>
      )}
    </div>
  );
}

/** 보유·청산 공통 표. 행을 누르면 그때의 근거가 펼쳐진다 */
function TradeTable({
  rows,
  openId,
  setOpenId,
  onSelectStock,
  onClose,
  onRemove,
}: {
  rows: EvaluatedTrade[];
  openId: string | null;
  setOpenId: (id: string | null) => void;
  onSelectStock: (code: string, name: string) => void;
  onClose?: (t: EvaluatedTrade) => void;
  onRemove: (t: EvaluatedTrade) => void;
}) {
  return (
    <div className="data-table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th className="sticky-col">종목명</th>
            <th>매수가</th>
            <th>{onClose ? "현재가" : "청산가"}</th>
            <th>수량</th>
            <th>평가손익</th>
            <th>수익률</th>
            <th>보유일</th>
            <th>매수시 신호등</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <>
              <tr key={t.id}>
                <td className="sticky-col">
                  <button className="link-btn" onClick={() => onSelectStock(t.code, t.name)}>
                    {t.name}
                  </button>
                </td>
                <td className="num">{fmtNum(t.entryPrice)}</td>
                <td className="num">{fmtNum(t.price)}</td>
                <td className="num">{fmtNum(t.qty)}</td>
                <td className={`num ${signClass(t.pnl)}`}>
                  {t.pnl > 0 ? "+" : ""}
                  {fmtNum(Math.round(t.pnl))}
                </td>
                <td className={`num ${signClass(t.returnRate)}`}>{pct(t.returnRate)}</td>
                <td className="num">
                  {t.holdingDays}일
                  {/* 편입일을 같이 — "며칠 됐나"만으로는 언제 산 건지 못 짚는다 */}
                  <span className="pt-n"> ({stamp(t.entryAt).slice(0, 10)})</span>
                </td>
                <td>
                  <span className={`sig-dot ${t.evidence.level}`} /> {t.evidence.score}점
                </td>
                <td className="pt-actions">
                  <button className="filter-btn" onClick={() => setOpenId(openId === t.id ? null : t.id)}>
                    {openId === t.id ? "근거 닫기" : "근거"}
                  </button>
                  {onClose && (
                    <button className="filter-btn" onClick={() => onClose(t)}>
                      청산
                    </button>
                  )}
                  <button className="row-del-btn" onClick={() => onRemove(t)} title="기록 삭제">
                    ✕
                  </button>
                </td>
              </tr>
              {openId === t.id && (
                <tr key={`${t.id}-ev`}>
                  <td colSpan={9} className="pt-evidence-cell">
                    <Evidence t={t} />
                  </td>
                </tr>
              )}
            </>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 매수 시점에 박제된 근거 */
function Evidence({ t }: { t: EvaluatedTrade }) {
  const e = t.evidence;
  return (
    <div className="pt-evidence">
      <div className="pt-ev-head">
        <b>{stamp(t.entryAt)}</b> 기준 — 이때 화면에 이렇게 나와 있었습니다
      </div>

      {t.thesis && <div className="pt-thesis">“{t.thesis}”</div>}

      <div className="pt-ev-grid">
        <div>
          <div className="pt-ev-title">종목 신호등</div>
          {e.checks.length === 0 ? (
            <div className="pt-ev-none">기록 없음</div>
          ) : (
            e.checks.map((c) => (
              <div className="pt-ev-row" key={c.key}>
                <span
                  className={`msig-mark ${c.pass === true ? "ok" : c.pass === false ? "bad" : "mid"}`}
                >
                  {c.pass === true ? "통과" : c.pass === false ? "미달" : "불명"}
                </span>
                <span className="pt-ev-label">{c.label}</span>
                <span className="pt-ev-value">{c.value}</span>
              </div>
            ))
          )}
        </div>

        <div>
          <div className="pt-ev-title">그때 시장</div>
          {e.market ? (
            <div className="pt-ev-row">
              <span className={`sig-dot ${e.market.level}`} />
              <span className="pt-ev-value">{e.market.summary}</span>
            </div>
          ) : (
            <div className="pt-ev-none">기록 없음</div>
          )}
          {e.marketBreadth && <div className="pt-ev-row"><span className="pt-ev-value">시장 폭 — {e.marketBreadth}</span></div>}

          <div className="pt-ev-title" style={{ marginTop: 8 }}>
            내 테마
          </div>
          {e.themes.length === 0 ? (
            <div className="pt-ev-none">이 종목이 담긴 내 테마 없음</div>
          ) : (
            e.themes.map((th) => (
              <div className="pt-ev-row" key={th.name}>
                <span className="chan-tag theme">🎯 {th.name}</span>
                <span className={`pt-ev-value ${signClass(th.changeRate ?? 0)}`}>
                  {th.changeRate === null ? "-" : pct(th.changeRate)}
                </span>
              </div>
            ))
          )}

          <div className="pt-ev-title" style={{ marginTop: 8 }}>
            업종 수급 (5일 누적)
          </div>
          {e.sector ? (
            <div className="pt-ev-row">
              <span className="pt-ev-label">{e.sector.name}</span>
              <span className="pt-ev-value">
                외국인 <b className={signClass(e.sector.foreign5)}>{fmtNum(Math.round(e.sector.foreign5))}억</b>
                {" · "}
                기관 <b className={signClass(e.sector.inst5)}>{fmtNum(Math.round(e.sector.inst5))}억</b>
              </span>
            </div>
          ) : (
            <div className="pt-ev-none">기록 없음</div>
          )}
        </div>
      </div>

      {t.exitNote && (
        <div className="pt-thesis exit">청산 사유 — “{t.exitNote}”</div>
      )}
    </div>
  );
}
