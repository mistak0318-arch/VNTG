import { useEffect, useRef, useState } from "react";
import { api, type UsSearchResult, type UsWatchGroup , type UsQuoteRow } from "../api";
import { RefreshBar } from "../components/RefreshBar";
import { liveQuote } from "../usSession";
import { UsWatchTable } from "../components/UsWatchTable";
import { useDragOrder } from "../useDragOrder";
import { YahooChartSheet, type ChartTarget } from "../components/overview/YahooChartSheet";

/**
 * 관심종목 (해외).
 *
 * 처음엔 미국만 담으려고 만들었는데 일본·홍콩·중국·베트남(한투)과 유럽(야후)까지
 * 붙으면서 이름이 실제와 어긋났다 — 유럽 방산 8종목이 「미국」 안에 있었다.
 *
 * 국내 테마는 키움이 시세를 주지만 미국은 안 준다. 그런데 **밤사이 미국이 오늘 국내를
 * 정한다** — 미국↔국내 테마 연동에서 이미 확인한 것이고, 그래서 미국 쪽도 내가 짠
 * 그룹으로 들고 있어야 한다.
 *
 * 그룹·종목은 전부 직접 편집한다. 티커를 외울 필요는 없다 — 이름으로 찾아 담는다.
 */

function pct(n: number | null): string {
  if (n === null) return "-";
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function cls(n: number | null): string {
  if (n === null) return "";
  return n > 0 ? "positive" : n < 0 ? "negative" : "";
}

/**
 * "실시간이야?" 에 답하려면 두 시각이 다 있어야 한다.
 *   체결  = 거래소에서 마지막으로 거래된 시각 (Yahoo 가 알려준 것)
 *   조회  = 우리가 그걸 받아온 시각
 * 둘이 붙어 있으면 장중 실시간에 가깝고, 벌어져 있으면 장이 닫힌 것이다.
 * marketState 는 안 올 때가 많아서 그것만 믿지 않는다.
 */
function ago(ms: number): string {
  const m = Math.floor((Date.now() - ms) / 60_000);
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

function stampKst(ms: number): string {
  return new Date(ms + 9 * 3600_000).toISOString().slice(5, 16).replace("T", " ");
}

/**
 * 정렬. **기본은 내가 넣은 순서**(서버가 준 배열 그대로)다.
 * 정렬을 걸면 원본 배열을 건드리지 않도록 복사해서 정렬한다.
 */
function sortStocks(stocks: UsQuoteRow[], by: "mine" | "rate" | "name" | "power"): UsQuoteRow[] {
  if (by === "mine") return stocks;
  const copy = [...stocks];
  /*
   * 정렬도 **지금 값** 기준이다.
   * 정규장 등락률로 줄을 세우면 애프터장에 크게 움직인 종목이 한참 아래에 남는다 —
   * 마감 뒤에 이 화면을 보는 이유가 바로 그 종목을 찾으려는 것인데.
   */
  if (by === "rate")
    copy.sort((a, b) => (liveQuote(b).changeRate ?? -999) - (liveQuote(a).changeRate ?? -999));
  else if (by === "power") copy.sort((a, b) => (b.power ?? -999) - (a.power ?? -999));
  else copy.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return copy;
}

const SORTS: { key: "mine" | "rate" | "name" | "power"; label: string }[] = [
  { key: "mine", label: "내 순서" },
  { key: "rate", label: "등락률" },
  { key: "power", label: "체결강도" },
  { key: "name", label: "티커" },
];

export function UsWatchPage() {
  const [groups, setGroups] = useState<UsWatchGroup[]>([]);
  const [quotedAt, setQuotedAt] = useState<number | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  /** 눌러서 여는 해외종목 상세 */
  const [detail, setDetail] = useState<ChartTarget | null>(null);
  /*
   * **기본은 내가 넣은 순서다.**
   *
   * 예전엔 늘 등락률로 정렬했다. 그런데 5초마다 갱신되니 **줄이 계속 뒤바뀌어서**
   * 방금 보던 종목이 어디로 갔는지 알 수가 없었다. 키움 HTS 도 내가 넣은 순서를 지킨다.
   *
   * 등락률 정렬이 필요한 때가 있으니 고를 수 있게만 남긴다.
   */
  const [sortBy, setSortBy] = useState<"mine" | "rate" | "name" | "power">("mine");
  const [openGroup, setOpenGroup] = useState<string | null>(null);

  // 종목 추가
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<UsSearchResult[]>([]);
  const [newGroup, setNewGroup] = useState("");

  /*
   * **조용히 갱신한다.**
   *
   * 예전엔 갱신할 때마다 loading 을 켜서 표가 "불러오는 중"으로 바뀌었다가 돌아왔다.
   * HTS 는 그러지 않는다 — 숫자만 제자리에서 바뀐다.
   *
   * 그래서 `quiet` 갱신에서는 loading 을 건드리지 않는다. React 는 key 가 같은 행을
   * 다시 그리지 않고 바뀐 칸만 손대므로, 화면이 깜빡이지 않고 값만 움직인다.
   */
  async function load(force = false, quiet = false) {
    if (!quiet) setLoading(true);
    if (!quiet) setError(null);
    try {
      const r = await api.usWatch(force);
      setGroups(r.groups);
      setQuotedAt(r.quotedAt);
      setFetchedAt(r.fetchedAt);
      if (!openGroup && r.groups.length > 0) setOpenGroup(r.groups[0].id);
    } catch (e) {
      // 조용한 갱신이 실패하면 조용히 넘어간다 — 잘 뜨던 값을 지우면 안 된다
      if (!quiet) setError(e instanceof Error ? e.message : "불러오기 실패");
    } finally {
      if (!quiet) setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
   * 자동 갱신 주기.
   *
   * 한투가 `state` 로 장 상태를 알려 주므로(“장중(실시간)” 등) **장이 열려 있을 때만
   * 자주** 부른다. 닫혀 있는데 5초마다 부르는 건 같은 값을 받아 오는 낭비다.
   *
   * 탭이 뒤에 있으면 아예 쉰다 — 안 보는 화면 때문에 한도를 쓰지 않는다.
   */
  const openMarket = groups.some((g) => g.stocks.some((s) => (s.state ?? "").includes("실시간")));
  useEffect(() => {
    if (!autoRefresh) return;
    const period = openMarket ? 5_000 : 60_000;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load(true, true);
    }, period);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, openMarket]);

  /*
   * 값이 움직인 칸을 잠깐 반짝인다 — HTS 의 틱 표시.
   *
   * 숫자만 조용히 바뀌면 **바뀐 줄을 놓친다.** 111종목이 한 화면에 있으면 더 그렇다.
   * 오른 것은 붉게, 내린 것은 푸르게 0.7초.
   */
  /*
   * **화면에 보이는 등락률**을 기준으로 잡는다.
   *
   * 예전엔 가격이 조금이라도 바뀌면 깜빡였고, 그것도 현재가·등락률·원화·편입대비
   * **네 칸이 한꺼번에** 번쩍였다. 111종목이면 화면 절반이 매 갱신마다 물결쳤다 —
   * 무엇이 바뀌었는지 알리려던 것이 오히려 아무것도 못 읽게 만들었다.
   *
   * 이제 소수 둘째 자리까지 **찍히는 값이 달라졌을 때만**, **등락률 칸에만** 붙인다.
   * 눈에 안 보이는 자릿수가 움직인 것으로 깜빡이면 그건 거짓 신호다.
   */
  const prevRates = useRef<Map<string, string>>(new Map());
  const [ticks, setTicks] = useState<Map<string, "up" | "down">>(new Map());
  useEffect(() => {
    const next = new Map<string, "up" | "down">();
    for (const g of groups) {
      for (const s of g.stocks) {
        if (s.changeRate === null) continue;
        const shown = s.changeRate.toFixed(2);
        const before = prevRates.current.get(s.symbol);
        if (before !== undefined && before !== shown) {
          next.set(s.symbol, Number(shown) > Number(before) ? "up" : "down");
        }
        prevRates.current.set(s.symbol, shown);
      }
    }
    if (next.size === 0) return;
    setTicks(next);
    const t = setTimeout(() => setTicks(new Map()), 700);
    return () => clearTimeout(t);
  }, [groups]);

  /** 이 종목의 등락률이 방금 바뀌었나 — **등락률 칸에만** 붙인다 */
  const tick = (symbol: string) => ticks.get(symbol) ?? "";

  /** 한 칸 위·아래로. 서버에 새 순서를 통째로 보낸다 */
  function moveStock(arr: UsQuoteRow[], symbol: string, delta: number) {
    const order = arr.map((x) => x.symbol);
    const at = order.indexOf(symbol);
    const to = at + delta;
    order.splice(to, 0, ...order.splice(at, 1));
    return api.usWatchStockOrder(openGroup ?? "", order);
  }

  // 검색은 늦춰서 — 타이핑마다 Yahoo 를 부르지 않는다
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      api
        .usWatchSearch(q)
        .then((r) => setResults(r.results))
        .catch(() => setResults([]));
    }, 350);
    return () => clearTimeout(timer);
  }, [query]);

  async function run(fn: () => Promise<{ groups: UsWatchGroup[] }>) {
    setError(null);
    try {
      setGroups((await fn()).groups);
    } catch (e) {
      setError(e instanceof Error ? e.message : "실패");
    }
  }

  /**
   * 그룹 순서 옮기기.
   *
   * 화면을 **먼저** 바꾸고 서버에 보낸다 — 서버 응답이 시세를 다시 붙여 오느라 한 박자 늦는데,
   * 그때까지 버튼이 안 먹은 것처럼 보이면 두 번 누르게 된다.
   * 실패하면 서버가 돌려준 것으로 되돌린다.
   */
  async function moveGroup(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= groups.length) return;
    const next = [...groups];
    [next[i], next[j]] = [next[j], next[i]];
    setGroups(next);
    await run(() => api.usWatchGroupOrder(next.map((g) => g.id)));
  }

  /* 그룹 칩 끌어서 옮기기 — 화살표와 같은 저장. 편집 모드에서만 스프레드된다 */
  const groupDrag = useDragOrder(
    groups.map((g) => g.id),
    (nextIds) => {
      const byId = new Map(groups.map((g) => [g.id, g]));
      const next = nextIds.map((id) => byId.get(id)).filter((g): g is UsWatchGroup => Boolean(g));
      setGroups(next);
      void run(() => api.usWatchGroupOrder(nextIds));
    },
  );

  const current = groups.find((g) => g.id === openGroup) ?? groups[0] ?? null;

  return (
    <div>
      <div className="uw-bar">
        <RefreshBar onRefresh={() => load(true)} loading={loading} />
        {/* 자동 갱신은 끌 수 있어야 한다 — 값이 계속 움직이면 읽기 어려운 때가 있다 */}
        {SORTS.map((o) => (
          <button
            key={o.key}
            className={`filter-btn ${sortBy === o.key ? "active" : ""}`}
            onClick={() => setSortBy(o.key)}
          >
            {o.label}
          </button>
        ))}
        <button
          className={`filter-btn ${autoRefresh ? "active" : ""}`}
          onClick={() => setAutoRefresh((v) => !v)}
          title={openMarket ? "장중에는 5초마다" : "장이 닫혀 있어 1분마다"}
        >
          {autoRefresh ? `자동 ${openMarket ? "5초" : "1분"}` : "자동 꺼짐"}
        </button>
      </div>
      {error && <div className="error-banner">{error}</div>}

      {/* 어느 시점 값인지 못 박는다 — "실시간이야?" 를 화면이 스스로 답해야 한다 */}
      <div className="uw-stamp">
        {quotedAt ? (
          <>
            시세 기준 <b>{stampKst(quotedAt)}</b> (한국시각) · <b>{ago(quotedAt)}</b> 체결
          </>
        ) : (
          <>시세 기준 불명</>
        )}
        {fetchedAt && <> · 조회 {ago(fetchedAt)}</>}
        <span className="uw-stamp-note">
          Yahoo Finance · 실시간이 아닐 수 있고 서버에서 1분 캐시합니다. ↻ 를 누르면 캐시를
          무시하고 새로 받습니다.
        </span>
      </div>

      {/*
        그룹 — 등락률까지 붙여서 어느 판이 도는지 목록에서 바로 보이게.
        편집을 켜면 ◀ ▶ 가 붙어 순서를 옮긴다. 끌어 옮기기는 폰에서 안 되므로 쓰지 않는다.
      */}
      <div className="filter-row group-tabs">
        {groups.map((g, i) => (
          <span className="gt-item" key={g.id}>
            {editing && (
              <button
                className="gt-move"
                onClick={() => void moveGroup(i, -1)}
                disabled={i === 0}
                title="앞으로"
              >
                ◀
              </button>
            )}
            <button
              className={`filter-btn ${current?.id === g.id ? "active" : ""}${editing ? groupDrag.cls(g.id) : ""}`}
              onClick={() => setOpenGroup(g.id)}
              title={g.memo}
              {...(editing ? groupDrag.props(g.id) : {})}
            >
              {g.name}
              <span className={`uw-grate ${cls(g.changeRate)}`}> {pct(g.changeRate)}</span>
            </button>
            {editing && (
              <button
                className="gt-move"
                onClick={() => void moveGroup(i, 1)}
                disabled={i >= groups.length - 1}
                title="뒤로"
              >
                ▶
              </button>
            )}
          </span>
        ))}
        <button
          className={`filter-btn ${editing ? "active" : ""}`}
          onClick={() => setEditing(!editing)}
        >
          {editing ? "편집 끝" : "✏ 편집"}
        </button>

      </div>

      {editing && (
        <section className="pt-entry">
          <div className="pt-entry-row">
            <input
              className="pt-input"
              placeholder="새 그룹 이름"
              value={newGroup}
              onChange={(e) => setNewGroup(e.target.value)}
            />
            <button
              className="filter-btn"
              disabled={!newGroup.trim()}
              onClick={() =>
                void run(async () => {
                  const r = await api.usWatchGroupAdd(newGroup.trim());
                  setNewGroup("");
                  return r;
                })
              }
            >
              + 그룹 추가
            </button>
            {current && (
              <>
                <span className="news-scope-sep" />
                <button
                  className="filter-btn danger"
                  onClick={() => {
                    if (!window.confirm(`「${current.name}」 그룹을 지웁니다.`)) return;
                    void run(() => api.usWatchGroupRemove(current.id));
                  }}
                >
                  「{current.name}」 그룹 삭제
                </button>
              </>
            )}
          </div>

          {current && (
            <div className="pt-entry-row">
              <div className="pt-search">
                <input
                  className="pt-input"
                  placeholder="종목 검색 (예: nvidia, rocket lab, OKLO)"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                {results.length > 0 && (
                  <ul className="pt-results">
                    {results.map((r) => (
                      <li key={r.symbol}>
                        <button
                          onClick={() =>
                            void run(async () => {
                              const res = await api.usWatchStockAdd(current.id, r.symbol, r.name);
                              setQuery("");
                              setResults([]);
                              return res;
                            })
                          }
                        >
                          <b>{r.symbol}</b> <span className="pt-n">{r.name}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <span className="tg-ctl-hint">
                「{current.name}」에 담깁니다 · 편입가는 지금 가격으로 자동
              </span>
            </div>
          )}
        </section>
      )}

      {loading && groups.length === 0 && <div className="page-note">불러오는 중…</div>}

      {groups.length === 0 && !loading && (
        <div className="page-note">
          그룹이 없습니다. <b>✏ 편집</b>을 눌러 그룹을 만들고 종목을 담아 보세요. 티커를 외울
          필요 없이 <b>이름으로 검색</b>됩니다.
        </div>
      )}

      {current && (
        <>
          <div className="uw-head">
            <b>{current.name}</b>
            {current.memo && <span className="pt-n"> {current.memo}</span>}
            <span className={`uw-grate big ${cls(current.changeRate)}`}>{pct(current.changeRate)}</span>
            <span className="pt-n">
              ▲{current.rising} / ▼{current.falling} · {current.stocks.length}종목
            </span>
          </div>

          <UsWatchTable
            stocks={sortStocks(current.stocks, sortBy)}
            editing={editing}
            onOpen={(symbol, label) => setDetail({ kind: "usStock", symbol, label })}
            /* 순서 바꾸기는 **내 순서로 볼 때만** — 정렬을 걸어 놓고 위아래로 옮기면
               화면에서 보이는 자리와 저장되는 자리가 달라진다 */
            onMove={
              sortBy === "mine"
                ? (symbol, dir) =>
                    void run(() => moveStock(sortStocks(current.stocks, sortBy), symbol, dir))
                : undefined
            }
            /* 끌어서 옮기기 — 화살표와 같은 조건(내 순서)·같은 저장 */
            onReorder={
              sortBy === "mine"
                ? (order) => void run(() => api.usWatchStockOrder(current.id, order))
                : undefined
            }
            onRemove={(symbol) => void run(() => api.usWatchStockRemove(current.id, symbol))}
            tick={tick}
          />

          <div className="table-note">
            그룹 등락률은
            구성종목의 <b>단순평균</b>입니다 — 미국은 시가총액을 받아오지 않아 가중을 줄 수
            없습니다. 「편입 대비」는 담은 시점 가격 대비 수익률입니다.
          </div>
        </>
      )}

      {detail && <YahooChartSheet target={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}
