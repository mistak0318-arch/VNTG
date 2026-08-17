import { useEffect, useState } from "react";
import {
  api,
  fmtNum,
  normalizeStockCode,
  signClass,
  type StockSearchResult,
  type TrackedStock,
} from "../api";
import { RefreshBar } from "../components/RefreshBar";
import { SortableTh, useSortableTable } from "../useSortableTable";
import { useWatchedCodes } from "../useWatchedCodes";

function fmtPct(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "-";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

const ALL = "__all__";
const DEFAULT_GROUP = "기본";


/** 통과=O, 미달=빈칸, 모름=- . 빈칸이 낫다 — X 가 많으면 눈이 그리로 쏠린다 */
function mark(v: boolean | null) {
  return v === null ? "-" : v ? <b className="positive">O</b> : "";
}

/**
 * 추세 표시. 공매도·대차는 **줄어야 좋다** — 늘면 빨강, 줄면 파랑.
 * 등락률 색과 반대라 헷갈리기 쉬워서 화살표를 같이 둔다.
 */
function trendMark(v: number | null, lowerIsBetter: boolean) {
  if (v === null) return "-";
  if (v === 0) return <span className="pt-n">–</span>;
  const good = lowerIsBetter ? v < 0 : v > 0;
  return <b className={good ? "positive" : "negative"}>{v > 0 ? "▲" : "▼"}</b>;
}

/** 충족 비율로 색을 준다 — 70% 넘으면 초록, 40% 아래면 빨강 */
function passClass(r: TrackedStock): string {
  if (r.passTotal === 0) return "";
  const p = r.passCount / r.passTotal;
  return p >= 0.7 ? "good" : p >= 0.4 ? "mid" : "bad";
}

export function MyPage({ onSelectStock }: { onSelectStock: (code: string, name: string) => void }) {
  const [items, setItems] = useState<TrackedStock[]>([]);
  const [groups, setGroups] = useState<string[]>([DEFAULT_GROUP]);
  /** 그룹 편집을 펼친 행 — 한 번에 하나만 */
  const [editGroups, setEditGroups] = useState<string | null>(null);
  const [activeGroup, setActiveGroup] = useState<string>(ALL);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  // 종목 추가 — 이름으로 찾아 고르게 한다 (코드를 손으로 적으면 틀린다)
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<StockSearchResult[]>([]);
  const [adding, setAdding] = useState(false);
  const watchedCodes = useWatchedCodes();

  // 그룹 필터를 먼저 적용한 뒤 정렬한다
  const visible =
    activeGroup === ALL
      ? items
      // 한 종목이 여러 그룹에 담기므로 "포함하는가"로 거른다
      : items.filter((i) => (i.groups ?? [DEFAULT_GROUP]).includes(activeGroup));
  const sort = useSortableTable(visible);

  async function loadGroups() {
    try {
      setGroups((await api.watchGroups()).groups);
    } catch {
      // 그룹 조회 실패가 목록 표시를 막지 않게 한다
    }
  }

  async function createGroup() {
    const name = window.prompt("새 그룹 이름")?.trim();
    if (!name) return;
    try {
      setGroups((await api.watchGroupAdd(name)).groups);
      setActiveGroup(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "그룹 추가 실패");
    }
  }

  async function removeGroupNow() {
    if (activeGroup === ALL || activeGroup === DEFAULT_GROUP) return;
    if (!window.confirm(`'${activeGroup}' 그룹을 삭제할까요?
소속 종목은 기본 그룹으로 이동합니다.`)) return;
    try {
      setGroups((await api.watchGroupRemove(activeGroup)).groups);
      setActiveGroup(ALL);
      await load(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "그룹 삭제 실패");
    }
  }

  /**
   * 그룹 하나를 넣거나 뺀다.
   *
   * 서버가 갱신된 전체 목록을 돌려주므로 그걸 그대로 쓴다 — 화면이 계산해서 맞추면
   * 두 창을 띄웠을 때 서로 어긋난다.
   */
  async function toggleGroup(code: string, group: string) {
    try {
      await api.watchGroupToggle(code, group);
      // 표는 시세까지 붙은 TrackedStock 이라 서버 목록을 그대로 못 쓴다. 다시 받는다
      await load(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "그룹 변경 실패");
    }
  }

  async function load(force = false) {
    setLoading(true);
    setError(null);
    try {
      const res = await api.watchlistTracking(force);
      setItems(res.items);
      setUpdatedAt(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "알 수 없는 오류");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    loadGroups();
  }, []);

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

  /**
   * 관심종목에 담는다.
   *
   * 편입가는 **지금 현재가**로 잡는다. 사용자가 직접 적게 하면 매번 입력하기 번거롭고,
   * 여기서 재는 것은 매수 단가가 아니라 "지켜보기 시작한 시점 대비 얼마나 움직였나"이므로
   * 담은 순간의 가격이 기준으로 맞다. (실제 매수 단가는 계좌 화면이 따로 본다)
   */
  async function addStock(r: StockSearchResult) {
    setAdding(true);
    setError(null);
    try {
      const code = normalizeStockCode(r.code);
      const info = (await api.stockInfo(code)) as Record<string, unknown>;
      const price = Math.abs(Number(String(info.cur_prc ?? "").replace(/[+,]/g, ""))) || 0;
      await api.watchlistAdd({
        code,
        name: r.name,
        addedPrice: price,
        group: activeGroup === ALL ? DEFAULT_GROUP : activeGroup,
      });
      setQuery("");
      setResults([]);
      await load(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "관심종목 추가 실패");
    } finally {
      setAdding(false);
    }
  }

  async function remove(code: string) {
    try {
      await api.watchlistRemove(code);
      setItems((prev) => prev.filter((i) => i.code !== code));
      watchedCodes.markRemoved(code);
    } catch (err) {
      setError(err instanceof Error ? err.message : "삭제 실패");
    }
  }

  // 요약: 수급이 살아있는 종목이 몇 개인지
  const foreignBuying = items.filter((i) => i.foreign5 > 0).length;
  const instBuying = items.filter((i) => i.inst5 > 0).length;
  const trendOk = items.filter((i) => i.trendPass === true).length;
  const profitable = items.filter((i) => (i.returnRate ?? 0) > 0).length;

  return (
    <div>
      <RefreshBar onRefresh={() => load(true)} loading={loading} updatedAt={updatedAt} />

      {error && <div className="error-banner">{error}</div>}

      <div className="search-box">
        <input
          className="search-input"
          type="text"
          inputMode="search"
          placeholder={`종목명·코드로 검색해서 ${activeGroup === ALL ? DEFAULT_GROUP : activeGroup} 그룹에 추가`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={adding}
        />
        {query.trim() && results.length > 0 && (
          <div className="search-dropdown">
            {results.map((r) => {
              const already = items.some((i) => i.code === normalizeStockCode(r.code));
              return (
                <button
                  key={r.code}
                  className="search-result-row"
                  disabled={already || adding}
                  onClick={() => void addStock(r)}
                >
                  <span className="name">{r.name}</span>
                  <span className="sub">
                    {r.code} · {r.marketName}
                    {already && " · 이미 담김"}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="filter-row group-tabs">
        <button
          className={`filter-btn ${activeGroup === ALL ? "active" : ""}`}
          onClick={() => setActiveGroup(ALL)}
        >
          전체 ({items.length})
        </button>
        {groups.map((g) => {
          const n = items.filter((i) => (i.groups ?? [DEFAULT_GROUP]).includes(g)).length;
          return (
            <button
              key={g}
              className={`filter-btn ${activeGroup === g ? "active" : ""}`}
              onClick={() => setActiveGroup(g)}
            >
              {g} ({n})
            </button>
          );
        })}
        <button className="filter-btn" onClick={createGroup} title="새 그룹 만들기">
          + 그룹
        </button>
        {activeGroup !== ALL && activeGroup !== DEFAULT_GROUP && (
          <button className="filter-btn danger" onClick={removeGroupNow} title="이 그룹 삭제">
            그룹 삭제
          </button>
        )}
      </div>

      <section className="card">
        <h2>관심종목 요약 ({items.length})</h2>
        <div className="summary-grid">
          <div className="summary-item">
            <div className="label">수익 중</div>
            <div className="value">
              {profitable} / {items.length}
            </div>
          </div>
          <div className="summary-item">
            <div className="label">정배열</div>
            <div className="value">
              {trendOk} / {items.length}
            </div>
          </div>
          <div className="summary-item">
            <div className="label">외인 5일 순매수</div>
            <div className="value positive">{foreignBuying}</div>
          </div>
          <div className="summary-item">
            <div className="label">기관 5일 순매수</div>
            <div className="value positive">{instBuying}</div>
          </div>
        </div>
      </section>

      {loading && items.length === 0 && <div className="empty">불러오는 중...</div>}

      {!loading && items.length > 0 && visible.length === 0 && (
        <div className="page-note">이 그룹에 담긴 종목이 없습니다.</div>
      )}

      {!loading && items.length === 0 && (
        <div className="page-note">
          관심종목이 없습니다. 시황·거래상위·알고리즘 탭에서 종목을 열고 ☆ 버튼을 눌러 추가하세요.
        </div>
      )}

      {visible.length > 0 && (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <SortableTh columnKey="name" label="종목명" accessor={(r: TrackedStock) => r.name} sort={sort} className="sticky-col" />
                <th>그룹</th>
                <SortableTh columnKey="addedAt" label="편입일" accessor={(r: TrackedStock) => r.addedAt} sort={sort} />
                <SortableTh columnKey="addedPrice" label="편입가" accessor={(r: TrackedStock) => r.addedPrice} sort={sort} />
                <SortableTh columnKey="price" label="현재가" accessor={(r: TrackedStock) => r.price} sort={sort} />
                {/* 조건충족수를 수익률 앞에 — 열세 칸을 가로로 훑으며 세는 건 사람이 할 일이 아니다 */}
                <SortableTh columnKey="pass" label="충족" accessor={(r: TrackedStock) => r.passCount} sort={sort} />
                <SortableTh columnKey="returnRate" label="수익률" accessor={(r: TrackedStock) => r.returnRate ?? 0} sort={sort} />
                <SortableTh columnKey="changeRate" label="당일" accessor={(r: TrackedStock) => r.changeRate} sort={sort} />
                <SortableTh columnKey="foreign5" label="외인5" accessor={(r: TrackedStock) => r.foreign5} sort={sort} />
                <SortableTh columnKey="foreign10" label="외인10" accessor={(r: TrackedStock) => r.foreign10} sort={sort} />
                <SortableTh columnKey="foreign20" label="외인20" accessor={(r: TrackedStock) => r.foreign20} sort={sort} />
                <SortableTh columnKey="inst5" label="기관5" accessor={(r: TrackedStock) => r.inst5} sort={sort} />
                <SortableTh columnKey="inst20" label="기관20" accessor={(r: TrackedStock) => r.inst20} sort={sort} />
                <SortableTh columnKey="inst60" label="기관60" accessor={(r: TrackedStock) => r.inst60} sort={sort} />
                <SortableTh columnKey="trend" label="정배열" accessor={(r: TrackedStock) => (r.trendPass ? 1 : 0)} sort={sort} />
                <th title="종가가 5일선·20일선 위에 있는가">캔들</th>
                <th title="최근 3일 공매도 추세 — 줄어야 좋다">공매도</th>
                <th title="최근 3일 대차잔고 추세 — 줄어야 좋다">대차</th>
                <th title="최근 분기 영업이익 증가">영익</th>
                <th title="속한 업종이 시장 대비 강한가">섹터</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sort.sorted.map((r) => (
                <tr key={r.code} className="clickable-row" onClick={() => onSelectStock(r.code, r.name)}>
                  <td className="sticky-col">{r.name}</td>
                  {/*
                    드롭다운은 하나만 고를 수 있어서 다중 그룹을 못 담는다.
                    칩을 눌러 넣고 뺀다 — 담긴 것만 진하게, 나머지는 흐리게.
                  */}
                  {/*
                    담긴 그룹만 보여준다.
                    처음엔 모든 그룹을 칩으로 깔고 켜고 끄게 했는데, 그룹이 일곱 개가 되니
                    행마다 다섯 줄이 됐다 — 그룹은 계속 늘어나므로 이 방식은 무너진다.
                    편집은 ✎ 를 눌렀을 때만 펼친다.
                  */}
                  <td onClick={(e) => e.stopPropagation()}>
                    <div className="mg-cell">
                      {(r.groups ?? [DEFAULT_GROUP]).map((g) => (
                        <span className="mg-chip on" key={g}>
                          {g}
                        </span>
                      ))}
                      <button
                        className="mg-edit"
                        onClick={() => setEditGroups(editGroups === r.code ? null : r.code)}
                        title="그룹 편집"
                      >
                        ✎
                      </button>
                    </div>
                    {editGroups === r.code && (
                      <div className="mg-picker">
                        {groups.map((g) => {
                          const on = (r.groups ?? [DEFAULT_GROUP]).includes(g);
                          return (
                            <button
                              key={g}
                              className={`mg-chip${on ? " on" : ""}`}
                              onClick={() => void toggleGroup(r.code, g)}
                            >
                              {on ? "☑" : "☐"} {g}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </td>
                  <td>{fmtDate(r.addedAt)}</td>
                  <td>{fmtNum(r.addedPrice)}</td>
                  <td>{fmtNum(r.price)}</td>
                  <td>
                    <span className={`wl-pass ${passClass(r)}`}>
                      {r.passCount}/{r.passTotal}
                    </span>
                  </td>
                  <td className={signClass(r.returnRate)}>{fmtPct(r.returnRate)}</td>
                  <td className={signClass(r.changeRate)}>{fmtPct(r.changeRate)}</td>
                  <td className={signClass(r.foreign5)}>{fmtNum(r.foreign5)}</td>
                  <td className={signClass(r.foreign10)}>{fmtNum(r.foreign10)}</td>
                  <td className={signClass(r.foreign20)}>{fmtNum(r.foreign20)}</td>
                  <td className={signClass(r.inst5)}>{fmtNum(r.inst5)}</td>
                  <td className={signClass(r.inst20)}>{fmtNum(r.inst20)}</td>
                  <td className={signClass(r.inst60)}>{fmtNum(r.inst60)}</td>
                  <td>{mark(r.trendPass)}</td>
                  {/* 5일선·20일선 위 여부를 한 칸에 — 둘 다 위면 "5·20" */}
                  <td className="wl-candle">
                    {r.above5 === null && r.above20 === null
                      ? "-"
                      : [r.above5 ? "5" : null, r.above20 ? "20" : null].filter(Boolean).join("·") || "↓"}
                  </td>
                  <td>{trendMark(r.shortTrend, true)}</td>
                  <td>{trendMark(r.lendingTrend, true)}</td>
                  <td>{mark(r.profitUp)}</td>
                  <td>{mark(r.sectorStrong)}</td>
                  <td>
                    <button
                      className="row-del-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        remove(r.code);
                      }}
                      title="관심종목에서 제거"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="table-note">
            수익률은 편입가 대비 · 순매매 단위는 백만원 · 정배열은 현재가≥5일≥20일≥60일≥120일선 ·
            캔들은 종가가 어느 선 위인지 · <b>공매도·대차는 줄어야(▼) 좋습니다</b> ·
            충족은 판단 가능한 항목만 셉니다(데이터가 없으면 분모에서도 뺍니다)
          </div>
        </div>
      )}
    </div>
  );
}
