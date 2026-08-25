import { Fragment, useEffect, useState } from "react";
import {
  api,
  fmtNum,
  normalizeStockCode,
  signClass,
  type StockSearchResult,
  type TrackedStock,
  type WatchStatus,
} from "../api";
import { RefreshBar } from "../components/RefreshBar";
import { ScenarioCard } from "../components/ScenarioCard";
import { useAutoRefresh } from "../useAutoRefresh";
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
/** 슈퍼신호등 자동 편입이 담기는 그룹 — 서버가 삭제·개명을 거부하고, 화면도 그 버튼을 안 낸다 */
const SUPER_GROUP = "슈퍼신호등";


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
  /*
   * 펼친 종목 (2026-08-25 UI 개편) — 스물세 칸을 옆으로 늘어놓던 표를
   * **핵심 아홉 칸 + 행 펼침**으로 바꿨다. 수급 여섯 값·판정 여섯 개·편입 정보·
   * 그룹·상태 편집은 ▼ 를 눌러야 나온다. PC 는 안 넓어도 되고 폰은 옆으로 안 민다.
   */
  const [expanded, setExpanded] = useState<string | null>(null);
  const [activeGroup, setActiveGroup] = useState<string>(ALL);
  /** 그룹 정리 모드 — 평소엔 고르는 자리이고, 켤 때만 옮기고 이름을 바꾼다 */
  const [editGroupBar, setEditGroupBar] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  // 종목 추가 — 이름으로 찾아 고르게 한다 (코드를 손으로 적으면 틀린다)
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<StockSearchResult[]>([]);
  const [adding, setAdding] = useState(false);
  const watchedCodes = useWatchedCodes();
  /*
   * 상태 목록은 **서버에서 받는다.** 화면에 박아 두면 서버가 하나 늘렸을 때
   * 여기만 모르는 채로 남는다 — 그러면 저장은 되는데 화면에 안 뜬다.
   */
  const [statuses, setStatuses] = useState<{ key: WatchStatus; label: string; hint: string }[]>([]);
  /** 상태로 좁혀 보기. `null` 이면 전부 */
  const [statusFilter, setStatusFilter] = useState<WatchStatus | null>(null);
  /** 「보유」 전환 관문 — 열려 있으면 시나리오 카드가 뜬다 */
  const [scenario, setScenario] = useState<{ code: string; name: string; price: number | null } | null>(null);
  /** 섹터 집중도 — 관심·보유가 어느 업종에 쏠렸나 */
  const [conc, setConc] = useState<Awaited<ReturnType<typeof api.watchConcentration>> | null>(null);
  /*
   * 자동 갱신 — 다른 목록 화면은 다 붙어 있는데 **정작 제일 오래 띄워 두는 이 화면만**
   * 없었다. 손으로 새로고침을 눌러야 값이 바뀌니, 안 누르면 아침 값을 오후까지 본다.
   *
   * 40초다. 시세만 있는 목록(20초)보다 느린 이유는 여기가 **수급·재무까지 붙은 무거운
   * 조회**라서다 — 20초로 잡으면 갱신이 끝나기 전에 다음 갱신이 걸린다.
   */
  const auto = useAutoRefresh(() => void load(true), {
    storeKey: "vntg.auto.watch",
    intervalMs: 40_000,
  });
  useEffect(() => {
    api
      .watchStatuses()
      .then((r) => setStatuses(r.statuses))
      .catch(() => undefined);
    api
      .watchConcentration()
      .then(setConc)
      .catch(() => undefined);
  }, []);

  // 그룹 필터를 먼저 적용한 뒤 정렬한다
  const byGroup =
    activeGroup === ALL
      ? items
      // 한 종목이 여러 그룹에 담기므로 "포함하는가"로 거른다
      : items.filter((i) => (i.groups ?? [DEFAULT_GROUP]).includes(activeGroup));
  /*
   * 상태 필터는 **그룹 필터와 겹쳐서** 건다. 둘은 다른 축이라 「반도체 중에서 대기인 것」이
   * 자연스러운 질문이다 — 하나만 고르게 하면 그 질문을 못 한다.
   *
   * 상태를 안 정한 종목은 「관찰」로 친다. 기본값이라 굳이 눌러 두지 않아도 되게.
   */
  const visible =
    statusFilter === null
      ? byGroup
      : byGroup.filter((i) => (i.status ?? "watching") === statusFilter);
  /*
   * **내가 정한 자리대로** 세운다.
   *
   * 관심종목은 순위가 아니라 **내가 배치한 목록**이다 — 자주 보는 것을 위에 두고 관련된
   * 것끼리 붙여 놓는다. 그래서 기본은 이름순도 등락률순도 아닌 내 순서다. 열 이름을
   * 누르면 그때만 다시 세운다.
   *
   * 자리를 정한 적 없는 종목(새로 담은 것)은 맨 아래로 간다.
   */
  const ordered = [...visible].sort((a, b) => {
    const g = activeGroup === ALL ? DEFAULT_GROUP : activeGroup;
    const av = a.order?.[g] ?? Number.MAX_SAFE_INTEGER;
    const bv = b.order?.[g] ?? Number.MAX_SAFE_INTEGER;
    if (av !== bv) return av - bv;
    return a.addedAt.localeCompare(b.addedAt);
  });
  const sort = useSortableTable(ordered);
  /* 순서를 손대는 중인가 — 켤 때만 ▲▼ 가 붙는다 */
  const [arranging, setArranging] = useState(false);

  /** 한 칸 옮기고 **보이는 순서를 통째로** 저장한다 */
  async function moveStock(code: string, dir: -1 | 1) {
    const g = activeGroup === ALL ? DEFAULT_GROUP : activeGroup;
    const codes = ordered.map((r) => r.code);
    const i = codes.indexOf(code);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= codes.length) return;
    [codes[i], codes[j]] = [codes[j], codes[i]];

    /*
     * **화면을 먼저 바꾼다.**
     *
     * 서버에 저장한 뒤 다시 받아 오면 그건 **캐시된 목록**이라 방금 바꾼 자리가 안 보인다
     * (전 종목 시세를 다시 받는 조회라 캐시가 길다). 강제로 새로 받게 하면 이번엔 몇 초씩
     * 걸린다 — 한 칸 옮기는 데 그건 말이 안 된다.
     *
     * 자리는 우리가 이미 아는 값이므로 손에 든 목록에 바로 반영하고, 서버에는 조용히
     * 적어 둔다. 실패하면 다음에 새로 받을 때 원래 자리로 돌아온다.
     */
    const at = new Map(codes.map((c, k) => [c, k]));
    setItems((prev) =>
      prev.map((it) =>
        at.has(it.code) ? { ...it, order: { ...(it.order ?? {}), [g]: at.get(it.code)! } } : it,
      ),
    );

    try {
      await api.watchReorder(g, codes);
    } catch {
      /* 실패하면 다음에 새로 받을 때 원래 자리로 돌아온다 */
    }
  }

  async function addDivider() {
    const g = activeGroup === ALL ? DEFAULT_GROUP : activeGroup;
    const label = window.prompt("구분선 이름 (비워도 됩니다)", "") ?? "";
    try {
      await api.watchAddDivider(g, label);
      /* 새 줄은 우리가 만든 게 아니라 서버가 코드를 지어 주므로 다시 받아야 한다 */
      await load(true);
    } catch {
      /* 실패는 다음 조회에서 드러난다 */
    }
  }

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

  /**
   * 그룹 순서 바꾸기.
   *
   * 끌어 옮기기(drag)를 쓰지 않았다. **폰에서 안 되기 때문이다** —
   * 이 앱은 폰으로 보는 시간이 더 길고, 터치 드래그는 스크롤과 싸운다.
   * ◀ ▶ 두 칸이면 어디서든 되고 한 칸씩 정확히 움직인다.
   */
  async function moveGroup(name: string, dir: -1 | 1) {
    const movable = groups.filter((g) => g !== DEFAULT_GROUP);
    const i = movable.indexOf(name);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= movable.length) return;
    const next = [...movable];
    [next[i], next[j]] = [next[j], next[i]];
    // 화면을 먼저 바꾼다 — 서버를 기다리면 누른 느낌이 늦다
    setGroups([DEFAULT_GROUP, ...next]);
    try {
      setGroups((await api.watchGroupReorder(next)).groups);
    } catch (err) {
      setError(err instanceof Error ? err.message : "순서 변경 실패");
      await loadGroups();
    }
  }

  async function renameGroupNow(name: string) {
    const to = window.prompt("새 그룹 이름", name)?.trim();
    if (!to || to === name) return;
    try {
      setGroups((await api.watchGroupRename(name, to)).groups);
      if (activeGroup === name) setActiveGroup(to);
      await load(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "이름 변경 실패");
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

  /**
   * 상태를 바꾼다.
   *
   * **화면을 먼저 바꾼다.** 상태는 한 번 눌러 바꾸는 값이라, 서버를 기다렸다 그리면
   * 누른 게 안 먹은 것처럼 보인다. 실패하면 되돌리고 그때 말한다.
   * (관심종목 순서에서 같은 문제를 이미 겪었다 — `load(false)` 가 캐시를 줬다)
   */
  async function setStatus(code: string, status: WatchStatus) {
    /*
     * 「보유」로 바꿀 때는 시나리오 카드가 먼저다 (2026-08-25) — 손절선·목표·근거를
     * 사기 **전**에 적는 관문. 저장하면 복기 노트의 오늘 매수가 되고, 그 뒤에 상태가
     * 바뀐다. 카드에서 「기록 없이 표시만」을 고르면 예전처럼 바로 바뀐다.
     */
    if (status === "holding" && (items.find((i) => i.code === code)?.status ?? "watching") !== "holding") {
      const r = items.find((i) => i.code === code);
      setScenario({ code, name: r?.name ?? code, price: r?.price ?? null });
      return;
    }
    await applyStatus(code, status);
  }

  async function applyStatus(code: string, status: WatchStatus) {
    const before = items;
    setItems((cur) => cur.map((i) => (i.code === code ? { ...i, status } : i)));
    try {
      await api.watchlistSetStatus(code, status);
      // 보유 구성이 바뀌었으니 집중도도 다시 센다
      api.watchConcentration().then(setConc).catch(() => undefined);
    } catch (err) {
      setItems(before);
      setError(err instanceof Error ? err.message : "상태 변경 실패");
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
      <RefreshBar onRefresh={() => load(true)} loading={loading} updatedAt={updatedAt} auto={auto} />

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

      {/*
        그룹 바.
        예전엔 이름과 개수만 있는 버튼 줄이었다. 그룹이 늘면 **만든 순서대로** 늘어서
        자주 보는 게 뒤로 밀렸고, 옮길 방법이 없었다.

        평소에는 고르는 자리로 두고, 「정리」를 켰을 때만 옮기고 이름을 바꾼다 —
        늘 화살표가 붙어 있으면 고르려다 잘못 눌러 순서가 바뀐다.
      */}
      {/*
        상태 필터는 **그룹 줄과 따로** 둔다. 같은 줄에 섞으면 둘이 같은 축으로 보이는데,
        실제로는 겹쳐서 걸린다 — 「반도체 중에서 대기인 것」이 되는 게 맞다.
      */}
      {/*
        섹터 집중도 (2026-08-25) — 「다 초록인데 전부 반도체」를 잡는 안전벨트 한 줄.
        신호등은 종목 하나하나를 보지만 묶음이 한 방향으로 쏠렸는지는 여기만 본다.
      */}
      {conc && conc.all.total >= 3 && (
        <div className="wl-conc">
          <span className="wl-conc-part">
            <i>관심 {conc.all.total}종목</i>
            {conc.all.top.map((t) => (
              <b key={t.sector} className={t.pct >= 50 ? "hot" : ""}>
                {t.sector} {Math.round(t.pct)}%
              </b>
            ))}
          </span>
          {conc.holding.total > 0 && (
            <span className="wl-conc-part">
              <i>보유 {conc.holding.total}종목</i>
              {conc.holding.top.map((t) => (
                <b key={t.sector} className={t.pct >= 50 ? "hot" : ""}>
                  {t.sector} {Math.round(t.pct)}%
                </b>
              ))}
            </span>
          )}
          {(conc.holding.top[0]?.pct ?? 0) >= 60 && conc.holding.total >= 2 && (
            <span className="wl-conc-warn">한 업종에 쏠려 있습니다</span>
          )}
        </div>
      )}

      {statuses.length > 0 && (
        <div className="filter-row">
          <span className="filter-label" title="그룹은 성격, 상태는 나와의 관계입니다">
            상태
          </span>
          <button
            className={`filter-btn ${statusFilter === null ? "active" : ""}`}
            onClick={() => setStatusFilter(null)}
          >
            전체
          </button>
          {statuses.map((s) => {
            const n = byGroup.filter((i) => (i.status ?? "watching") === s.key).length;
            return (
              <button
                key={s.key}
                className={`filter-btn ${statusFilter === s.key ? "active" : ""}`}
                title={s.hint}
                onClick={() => setStatusFilter(statusFilter === s.key ? null : s.key)}
              >
                {s.label} <span className="gt-n">{n}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="filter-row group-tabs">
        <button
          className={`filter-btn ${activeGroup === ALL ? "active" : ""}`}
          onClick={() => setActiveGroup(ALL)}
        >
          전체 <span className="gt-n">{items.length}</span>
        </button>
        {groups.map((g, gi) => {
          const n = items.filter((i) => (i.groups ?? [DEFAULT_GROUP]).includes(g)).length;
          const movable = groups.filter((x) => x !== DEFAULT_GROUP);
          const mi = movable.indexOf(g);
          /* 슈퍼신호등은 자동 편입의 자리 — 이름을 못 바꾸고 못 지운다. 배지도 다르다 */
          const locked = g === DEFAULT_GROUP || g === SUPER_GROUP;
          return (
            <span className={`gt-item${activeGroup === g ? " active" : ""}`} key={g}>
              {editGroupBar && g !== DEFAULT_GROUP && (
                <button
                  className="gt-move"
                  onClick={() => void moveGroup(g, -1)}
                  disabled={mi <= 0}
                  title="앞으로"
                >
                  ◀
                </button>
              )}
              <button
                className={`filter-btn ${activeGroup === g ? "active" : ""}${g === SUPER_GROUP ? " gt-super" : ""}`}
                onClick={() => (editGroupBar && !locked ? renameGroupNow(g) : setActiveGroup(g))}
                title={
                  g === SUPER_GROUP
                    ? "슈퍼신호등 자동 편입이 담기는 그룹 — 이름 변경·삭제가 안 됩니다"
                    : editGroupBar && !locked
                      ? "눌러서 이름 바꾸기"
                      : undefined
                }
              >
                {g === SUPER_GROUP && "🌟 "}
                {g} <span className="gt-n">{n}</span>
                {editGroupBar && !locked && <span className="gt-pen"> ✎</span>}
              </button>
              {editGroupBar && g !== DEFAULT_GROUP && (
                <button
                  className="gt-move"
                  onClick={() => void moveGroup(g, 1)}
                  disabled={mi < 0 || mi >= movable.length - 1}
                  title="뒤로"
                >
                  ▶
                </button>
              )}
              {/* gi 는 키 경고를 피하려고 받는다 — 실제 순서는 서버가 들고 있다 */}
              <span hidden>{gi}</span>
            </span>
          );
        })}
        <button className="filter-btn" onClick={createGroup} title="새 그룹 만들기">
          + 그룹
        </button>
        <button
          className={`filter-btn ${editGroupBar ? "active" : ""}`}
          onClick={() => setEditGroupBar((v) => !v)}
          title="그룹 이름 바꾸기 · 순서 옮기기 · 삭제"
        >
          {/*
            **이름이 기능을 말해야 한다.**
            「정리」로는 무엇을 하는 버튼인지 알 수가 없어서, 그룹 이름을 바꾸는 기능이
            있는데도 없는 줄 알고 계셨다. 하는 일을 그대로 적는다.
          */}
          {editGroupBar ? "편집 끝" : "그룹 편집"}
        </button>
        {editGroupBar && activeGroup !== ALL && activeGroup !== DEFAULT_GROUP && activeGroup !== SUPER_GROUP && (
          <button className="filter-btn danger" onClick={removeGroupNow} title="이 그룹 삭제">
            «{activeGroup}» 삭제
          </button>
        )}
        {/*
          자리 바꾸기. **켤 때만 ▲▼ 가 붙는다** — 늘 떠 있으면 종목을 누르려다 화살표를
          누르게 된다. 끌어 옮기기(drag)는 안 쓴다: 이 앱은 폰으로 보는 시간이 더 길고
          터치 드래그는 스크롤과 싸운다. 두 칸이면 어디서든 되고 한 칸씩 정확히 움직인다.
        */}
        <button
          className={`filter-btn ${arranging ? "active" : ""}`}
          onClick={() => setArranging((v) => !v)}
          title="종목을 원하는 자리로 옮깁니다"
        >
          {arranging ? "자리 끝" : "⇅ 자리 바꾸기"}
        </button>
        {arranging && (
          <button className="filter-btn" onClick={() => void addDivider()} title="종목 사이를 가르는 빈 줄">
            ― 구분선 넣기
          </button>
        )}
      </div>
      {arranging && (
        <div className="table-note">
          <b>▲▼</b> 로 옮깁니다 — 지금 보고 있는 <b>«{activeGroup === ALL ? DEFAULT_GROUP : activeGroup}»</b>
          안에서의 자리이고, 같은 종목이 다른 그룹에서는 그 그룹의 자리를 따로 갖습니다.
          <b> 구분선</b>은 그룹을 새로 만들 만큼은 아닌데 눈으로는 갈라 보고 싶을 때 씁니다.
          {sort.sortKey && (
            <b className="scr-idle"> 지금은 열 이름으로 정렬 중이라 옮겨도 그대로 안 보입니다 — 정렬을 풀어 주세요.</b>
          )}
        </div>
      )}
      {editGroupBar && (
        <div className="table-note">
          ◀ ▶ 로 순서를 옮기고, 그룹 이름을 누르면 이름을 바꿉니다. 순서는 저장되어 다음에도
          그대로입니다. <b>기본 그룹은 늘 맨 앞</b>이라 옮길 수 없습니다.
        </div>
      )}

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
            {/*
              스물세 칸 → **아홉 칸** (2026-08-25 개편 — 「옆으로 너무 길어 PC 도
              폰도 못 본다」). 수급 여섯 값은 부호 점 여섯 개로, 판정 여섯 개도
              점으로 줄이고, 숫자·편집은 ▼ 펼침에 들어갔다. 어느 화면 폭에서든
              옆으로 밀지 않고 다 보인다.
            */}
            <thead>
              <tr>
                <SortableTh columnKey="name" label="종목명" accessor={(r: TrackedStock) => r.name} sort={sort} className="sticky-col" />
                <SortableTh columnKey="price" label="현재가" accessor={(r: TrackedStock) => r.price} sort={sort} />
                <SortableTh columnKey="changeRate" label="당일" accessor={(r: TrackedStock) => r.changeRate} sort={sort} />
                <SortableTh columnKey="returnRate" label="수익률" accessor={(r: TrackedStock) => r.returnRate ?? 0} sort={sort} />
                <SortableTh columnKey="pass" label="충족" accessor={(r: TrackedStock) => r.passCount} sort={sort} />
                <th title="외인 5·10·20일 / 기관 5·20·60일 순매수 방향 — 빨강이 순매수. 값은 ▼ 를 펴면 나옵니다">수급</th>
                <th title="정배열·캔들·공매도·대차·영익·섹터 — 초록이 좋은 쪽. 자세한 건 ▼">판정</th>
                <SortableTh
                  columnKey="upside"
                  label="목표가"
                  accessor={(r: TrackedStock) => r.upside ?? -999}
                  sort={sort}
                />
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sort.sorted.map((r, i, arr) =>
                /*
                  ⚠️ **구분선은 종목이 아니다.**
                  값 칸을 비우고 한 줄을 통째로 쓴다 — 시세를 안 받으므로 채울 것도 없다.
                  키움 HTS 관심종목의 그 빈 줄과 같은 물건이다.
                */
                r.divider ? (
                  <tr key={r.code} className="mg-divider">
                    <td colSpan={99}>
                      <span className="mg-divider-line" />
                      {r.name && <span className="mg-divider-label">{r.name}</span>}
                      {arranging && (
                        <span className="mg-move">
                          <button className="gt-move" onClick={() => void moveStock(r.code, -1)} disabled={i === 0}>
                            ▲
                          </button>
                          <button
                            className="gt-move"
                            onClick={() => void moveStock(r.code, 1)}
                            disabled={i === arr.length - 1}
                          >
                            ▼
                          </button>
                          <button className="row-del-btn" onClick={() => void remove(r.code)} title="구분선 지우기">
                            ✕
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                ) : (
                <Fragment key={r.code}>
                <tr className="clickable-row" onClick={() => onSelectStock(r.code, r.name)}>
                  <td className="sticky-col">
                    {arranging && (
                      <span className="mg-move" onClick={(e) => e.stopPropagation()}>
                        <button className="gt-move" onClick={() => void moveStock(r.code, -1)} disabled={i === 0}>
                          ▲
                        </button>
                        <button
                          className="gt-move"
                          onClick={() => void moveStock(r.code, 1)}
                          disabled={i === arr.length - 1}
                        >
                          ▼
                        </button>
                      </span>
                    )}
                    {r.name}
                    {/* 그룹·상태는 이름 아래 한 줄 — 칼럼 두 개가 통째로 줄었다 */}
                    <span className="wl-sub">
                      {(r.groups ?? [DEFAULT_GROUP]).map((g, i) => (
                        <Fragment key={g}>
                          {i > 0 && " · "}
                          {g === SUPER_GROUP ? <em className="wl-super">🌟 {g}</em> : g}
                        </Fragment>
                      ))}
                      <i className={`wl-st st-${r.status ?? "watching"}`}>
                        {statuses.find((s) => s.key === (r.status ?? "watching"))?.label}
                      </i>
                    </span>
                  </td>
                  <td>{fmtNum(r.price)}</td>
                  <td className={signClass(r.changeRate)}>{fmtPct(r.changeRate)}</td>
                  <td className={signClass(r.returnRate)}>{fmtPct(r.returnRate)}</td>
                  <td>
                    <span className={`wl-pass ${passClass(r)}`}>
                      {r.passCount}/{r.passTotal}
                    </span>
                  </td>
                  {/* 수급 — 값 여섯을 부호 점 여섯으로. 값은 펼침에 있고, 점에 마우스를 올리면 보인다 */}
                  <td className="wl-flow-cell" onClick={(e) => { e.stopPropagation(); setExpanded(expanded === r.code ? null : r.code); }}>
                    <span className="wl-flow">
                      <i>외</i>
                      {([["5일", r.foreign5], ["10일", r.foreign10], ["20일", r.foreign20]] as const).map(([l, v]) => (
                        <b key={l} className={v > 0 ? "up" : v < 0 ? "down" : "flat"} title={`외국인 ${l} ${fmtNum(v)}백만`} />
                      ))}
                      <i>기</i>
                      {([["5일", r.inst5], ["20일", r.inst20], ["60일", r.inst60]] as const).map(([l, v]) => (
                        <b key={l} className={v > 0 ? "up" : v < 0 ? "down" : "flat"} title={`기관 ${l} ${fmtNum(v)}백만`} />
                      ))}
                    </span>
                  </td>
                  {/* 판정 — 여섯 항목을 점으로. 초록 = 좋은 쪽 */}
                  <td className="wl-flow-cell" onClick={(e) => { e.stopPropagation(); setExpanded(expanded === r.code ? null : r.code); }}>
                    <span className="wl-judge">
                      {([
                        ["정", r.trendPass, "정배열"],
                        ["캔", r.above5 === null && r.above20 === null ? null : Boolean(r.above5 || r.above20), "종가가 5·20일선 위인가"],
                        ["공", r.shortTrend == null ? null : r.shortTrend < 0, "공매도 — 줄어야 좋다"],
                        ["대", r.lendingTrend == null ? null : r.lendingTrend < 0, "대차잔고 — 줄어야 좋다"],
                        ["영", r.profitUp, "최근 분기 영업이익 증가"],
                        ["섹", r.sectorStrong, "업종이 시장 대비 강한가"],
                      ] as const).map(([l, ok, hint]) => (
                        <em key={l} className={ok === null || ok === undefined ? "na" : ok ? "ok" : "bad"} title={hint}>
                          {l}
                        </em>
                      ))}
                    </span>
                  </td>
                  {/* 목표가는 금액이 아니라 남은 폭으로 — 금액은 종목마다 자릿수가 달라 못 견준다 */}
                  <td className={r.upside == null ? "" : r.upside > 0 ? "positive" : "negative"}>
                    {r.upside == null ? "-" : `${r.upside > 0 ? "+" : ""}${r.upside.toFixed(0)}%`}
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <button
                      className={`wl-more${expanded === r.code ? " on" : ""}`}
                      onClick={() => setExpanded(expanded === r.code ? null : r.code)}
                      title="수급 숫자·편입 정보·그룹·상태 편집"
                    >
                      {expanded === r.code ? "▲" : "▼"}
                    </button>
                  </td>
                </tr>
                {/*
                  펼침 행 — 표에서 뺀 것들이 전부 여기 있다. 폭이 아니라 **아래**로
                  펼치므로 폰에서도 안 밀린다. 그룹·상태 편집도 여기서 한다.
                */}
                {expanded === r.code && (
                  <tr className="wl-expand">
                    <td colSpan={9} onClick={(e) => e.stopPropagation()}>
                      <div className="wl-ex">
                        <div className="wl-ex-grid">
                          <span><em>편입일</em><b>{fmtDate(r.addedAt)}</b></span>
                          <span><em>편입가</em><b>{fmtNum(r.addedPrice)}</b></span>
                          <span><em>외인 5/10/20일</em><b className="num">{fmtNum(r.foreign5)} / {fmtNum(r.foreign10)} / {fmtNum(r.foreign20)}</b></span>
                          <span><em>기관 5/20/60일</em><b className="num">{fmtNum(r.inst5)} / {fmtNum(r.inst20)} / {fmtNum(r.inst60)}</b></span>
                          <span>
                            <em>캔들</em>
                            <b>
                              {r.above5 === null && r.above20 === null
                                ? "-"
                                : [r.above5 ? "5일선 위" : null, r.above20 ? "20일선 위" : null].filter(Boolean).join(" · ") || "둘 다 아래"}
                            </b>
                          </span>
                          <span><em>공매도 / 대차</em><b>{trendMark(r.shortTrend, true)} / {trendMark(r.lendingTrend, true)}</b></span>
                          <span>
                            <em>증권사 의견</em>
                            <b>
                              {r.opinionMove == null
                                ? "-"
                                : `${r.opinionMove > 0 ? "▲상향" : r.opinionMove < 0 ? "▼하향" : "유지"} (${r.brokerCount ?? 0}곳)`}
                            </b>
                          </span>
                        </div>
                        <div className="wl-ex-edit">
                          <div className="mg-cell wl-status">
                            <em className="wl-ex-k">상태</em>
                            {statuses.map((s) => (
                              <button
                                key={s.key}
                                className={`mg-chip st-${s.key}${(r.status ?? "watching") === s.key ? " on" : ""}`}
                                title={s.hint}
                                onClick={() => void setStatus(r.code, s.key)}
                              >
                                {s.label}
                              </button>
                            ))}
                          </div>
                          <div className="mg-cell">
                            <em className="wl-ex-k">그룹</em>
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
                          <button
                            className="row-del-btn"
                            onClick={() => {
                              setExpanded(null);
                              remove(r.code);
                            }}
                            title="관심종목에서 제거"
                          >
                            ✕ 관심종목에서 빼기
                          </button>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
                </Fragment>
                ),
              )}
            </tbody>
          </table>
          <div className="table-note">
            수익률은 편입가 대비 · 순매매 단위는 백만원 · 정배열은 현재가≥5일≥20일≥60일≥120일선 ·
            캔들은 종가가 어느 선 위인지 · <b>공매도·대차는 줄어야(▼) 좋습니다</b> ·
            충족은 판단 가능한 항목만 셉니다(데이터가 없으면 분모에서도 뺍니다)
          </div>
        </div>
      )}

      {scenario && (
        <ScenarioCard
          code={scenario.code}
          name={scenario.name}
          price={scenario.price}
          onDone={() => {
            void applyStatus(scenario.code, "holding");
            setScenario(null);
          }}
          onSkip={() => {
            void applyStatus(scenario.code, "holding");
            setScenario(null);
          }}
          onCancel={() => setScenario(null)}
        />
      )}
    </div>
  );
}
