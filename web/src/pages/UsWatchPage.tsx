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

/** 검색 결과의 국기 — 나라가 섞이니 한눈에 갈라야 한다 */
const NATION_FLAG: Record<string, string> = {
  USA: "🇺🇸",
  JPN: "🇯🇵",
  HKG: "🇭🇰",
  CHN: "🇨🇳",
  TWN: "🇹🇼",
  VNM: "🇻🇳",
};
/** 야후 결과는 국가가 없다 — 거래소 코드로 유추한다 */
const EXCHANGE_FLAG: Record<string, string> = {
  GER: "🇩🇪", FRA: "🇩🇪", LSE: "🇬🇧", PAR: "🇫🇷", MIL: "🇮🇹", STO: "🇸🇪",
  AMS: "🇳🇱", SWX: "🇨🇭", EBS: "🇨🇭", CPH: "🇩🇰", OSL: "🇳🇴", MCE: "🇪🇸",
  JPX: "🇯🇵", TYO: "🇯🇵", TOKYO: "🇯🇵", HKG: "🇭🇰", HONG_KONG: "🇭🇰",
  SHH: "🇨🇳", SHZ: "🇨🇳", SHANGHAI: "🇨🇳", SHENZHEN: "🇨🇳", TAI: "🇹🇼",
};
function flagOf(r: { nation?: string; exchange: string }): string {
  return NATION_FLAG[r.nation ?? ""] ?? EXCHANGE_FLAG[r.exchange] ?? "🇺🇸";
}

export function UsWatchPage() {
  const [groups, setGroups] = useState<UsWatchGroup[]>([]);
  const [quotedAt, setQuotedAt] = useState<number | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
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

  // 종목 추가 (2026-08-27 개편 — 편집 모드 밖으로. "추가하는 게 너무 불편하거든")
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<UsSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  /** 담을 그룹 — 기본은 지금 보고 있는 그룹 */
  const [addTo, setAddTo] = useState<string>("");
  /** 방금 담은 것 — "담았습니다"를 그 자리에서 말한다 (연속으로 담게 패널은 유지) */
  const [addedMsg, setAddedMsg] = useState<string | null>(null);
  // 그룹 추가 — 역시 편집 모드 밖, 그룹 탭줄의 ＋
  const [groupAdding, setGroupAdding] = useState(false);
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

  /*
   * 빠른 시세 오버레이 (2026-08-25 — 「5초 갱신뿐이라 느리다」).
   *
   * 본 시세는 종목당 조회라 서버가 1분 캐시다 — 5초로 폴링해도 **값의 나이가
   * 최대 1분**이었다. 야후 spark 는 배치(한 요청에 심볼 여러 개)라 지금 보는
   * 그룹만 3초로 물어 현재가·등락률을 덧씌운다. FE 실시간은 프레임을 안 주는 게
   * 실측 결론이라 이게 미장의 실질 실시간이다.
   */
  const [fast, setFast] = useState<Record<string, { price: number; changeRate: number | null; at: number }>>({});
  const fastSymbols = (groups.find((g) => g.id === openGroup) ?? groups[0])?.stocks
    .map((s) => s.symbol)
    .join(",");
  useEffect(() => {
    if (!fastSymbols) return;
    let alive = true;
    const period = openMarket ? 3_000 : 30_000;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      api
        .usWatchFast(fastSymbols.split(","))
        .then((r) => alive && setFast(r.quotes))
        .catch(() => undefined);
    };
    tick();
    const t = setInterval(tick, period);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [fastSymbols, openMarket]);
  /*
   * 본 시세(52주·강도·시간외 등) 자동 갱신 (2026-08-26 — 「5초 옵션 필요 없는거
   * 아니냐」는 지적이 맞았다).
   *
   * 가격·등락률은 위의 3초 빠른 시세가 이미 덮고 있고, 본 시세는 서버가 1분
   * 캐시라 5초로 조를수록 같은 값만 다시 받았다. 토글도 없앴다 — 국내 관심종목처럼
   * **그냥 조용히 도는 것**이 맞고, 끌 이유가 있는 주기가 아니다.
   * 장중 30초 · 마감 1분, 탭이 뒤에 있으면 쉰다.
   */
  useEffect(() => {
    const period = openMarket ? 30_000 : 60_000;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load(false, true);
    }, period);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openMarket]);

  /*
   * 틱 깜빡임은 **없앴다** (2026-08-26 사용자 요청). 등락률 칸만 0.7초 붉게/푸르게
   * 물들이던 것인데, 3초 빠른 시세가 붙은 뒤로는 상시 명멸이 되어 눈만 피로했다.
   */

  /** 한 칸 위·아래로. 서버에 새 순서를 통째로 보낸다 */
  function moveStock(arr: UsQuoteRow[], symbol: string, delta: number) {
    const order = arr.map((x) => x.symbol);
    const at = order.indexOf(symbol);
    const to = at + delta;
    order.splice(to, 0, ...order.splice(at, 1));
    return api.usWatchStockOrder(openGroup ?? "", order);
  }

  // 검색은 늦춰서 — 타이핑마다 네이버·야후를 부르지 않는다
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      api
        .usWatchSearch(q)
        .then((r) => setResults(r.results))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 350);
    return () => clearTimeout(timer);
  }, [query]);

  /** 결과를 눌러 담는다 — 패널은 유지 (연속으로 담는 게 보통이다) */
  async function addStock(r: UsSearchResult) {
    const target = addTo || current?.id || groups[0]?.id;
    if (!target) return;
    const gname = groups.find((g) => g.id === target)?.name ?? "";
    try {
      setError(null);
      const res = await api.usWatchStockAdd(target, r.symbol, r.name);
      setGroups(res.groups);
      setAddedMsg(`✓ ${r.name} → 「${gname}」에 담았습니다`);
      setTimeout(() => setAddedMsg(null), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "담기 실패");
    }
  }

  /** ＋ 그룹 — 편집 모드 없이 그 자리에서 */
  async function addGroup() {
    const name = newGroup.trim();
    if (!name) return;
    try {
      const r = await api.usWatchGroupAdd(name);
      setGroups(r.groups);
      setNewGroup("");
      setGroupAdding(false);
      const made = r.groups.find((g) => g.name === name);
      if (made) {
        setOpenGroup(made.id);
        setAddTo(made.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "그룹 추가 실패");
    }
  }

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
        {SORTS.map((o) => (
          <button
            key={o.key}
            className={`filter-btn ${sortBy === o.key ? "active" : ""}`}
            onClick={() => setSortBy(o.key)}
          >
            {o.label}
          </button>
        ))}
        {/* 자동 갱신 토글은 없앴다(2026-08-26) — 가격은 3초 빠른 시세, 나머지는 30초 조용히 */}
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
      {/*
        폰 — 그룹 칩이 **일곱 줄 274px** 로 쌓여 화면을 통째로 먹었다 (2026-08-28 실측).
        좁은 화면에서는 고르개 하나로 (관심종목 VNTG 와 같은 문법).
        편집 중에는 칩을 남긴다 — 순서 옮기기·이름 바꾸기가 칩에만 있다.
      */}
      {!editing && (
        <div className="my-group-pick">
          <select
            className="group-select"
            value={current?.id ?? ""}
            onChange={(e) => setOpenGroup(e.target.value)}
            aria-label="그룹 고르기"
          >
            {groups.map((g) => (
              <option value={g.id} key={g.id}>
                {g.name} ({g.stocks.length}) {pct(g.changeRate)}
              </option>
            ))}
          </select>
        </div>
      )}

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
        {/* ＋ 그룹 — 편집 모드 없이 바로 (2026-08-27 "추가가 너무 불편") */}
        {groupAdding ? (
          <span className="gt-item">
            <input
              className="ma-input uw-newgroup"
              autoFocus
              placeholder="새 그룹 이름"
              value={newGroup}
              onChange={(e) => setNewGroup(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void addGroup();
                if (e.key === "Escape") setGroupAdding(false);
              }}
            />
            <button className="filter-btn active" onClick={() => void addGroup()}>
              추가
            </button>
            <button className="filter-btn" onClick={() => setGroupAdding(false)}>
              ✕
            </button>
          </span>
        ) : (
          <button className="filter-btn" onClick={() => setGroupAdding(true)} title="새 그룹 만들기">
            ＋ 그룹
          </button>
        )}
        <button
          className={`filter-btn ${adding ? "active" : ""}`}
          onClick={() => {
            setAdding((v) => !v);
            setAddTo(current?.id ?? "");
          }}
          title="이름으로 검색해서 담습니다 — 한국어로도 됩니다 (테슬라, 도요타, 텐센트…)"
        >
          ＋ 종목 담기
        </button>
        <button
          className={`filter-btn ${editing ? "active" : ""}`}
          onClick={() => setEditing(!editing)}
        >
          {editing ? "편집 끝" : "✏ 편집"}
        </button>
      </div>

      {/*
        종목 담기 패널 — 상시 접근 (2026-08-27 전면 개편).
        예전엔 ✏ 편집을 켜야 검색창이 나왔다 — 담으려고 편집 모드에 들어가는 건
        길이 아니다. 한국어 검색(네이버)·미국 외 국가(일본·홍콩·중국·유럽)도 된다.
      */}
      {adding && (
        <section className="pt-entry uw-add">
          <div className="pt-entry-row">
            <div className="pt-search">
              <input
                className="pt-input"
                autoFocus
                placeholder="한국어·영어·티커 (예: 테슬라, 도요타, 텐센트, rocket lab, 7203)"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {(results.length > 0 || searching) && query.trim() && (
                <ul className="pt-results">
                  {searching && results.length === 0 && <li className="pt-n uw-searching">찾는 중…</li>}
                  {results.map((r) => (
                    <li key={r.symbol}>
                      <button onClick={() => void addStock(r)} title={`${r.symbol} · ${r.exchange}`}>
                        <span className="uw-flag">{flagOf(r)}</span>
                        <b>{r.name}</b> <span className="pt-n">{r.symbol}</span>
                        {r.type === "ETF" && <em className="uw-etf-badge">ETF</em>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <select
              className="group-select"
              value={addTo || current?.id || ""}
              onChange={(e) => setAddTo(e.target.value)}
              title="어느 그룹에 담을까"
            >
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
            <button className="filter-btn" onClick={() => setAdding(false)}>
              닫기
            </button>
          </div>
          {addedMsg ? (
            <div className="alert-note">{addedMsg} — 계속 검색해서 더 담을 수 있습니다</div>
          ) : (
            <span className="tg-ctl-hint">
              결과를 누르면 바로 담깁니다 · 편입가는 지금 가격으로 자동 · 일본·홍콩·중국·유럽도 검색됩니다
            </span>
          )}
        </section>
      )}

      {/* 편집 모드는 이제 지우고 옮기는 자리다 — 추가는 위의 상시 패널이 맡는다 */}
      {editing && current && (
        <section className="pt-entry">
          <div className="pt-entry-row">
            <button
              className="filter-btn danger"
              onClick={() => {
                if (!window.confirm(`「${current.name}」 그룹을 지웁니다.`)) return;
                void run(() => api.usWatchGroupRemove(current.id));
              }}
            >
              「{current.name}」 그룹 삭제
            </button>
            <span className="tg-ctl-hint">
              그룹 순서는 ◀▶, 종목 순서는 표의 ▲▼ 또는 끌기 (내 순서로 볼 때)
            </span>
          </div>
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
            fast={fast}
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
