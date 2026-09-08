import { useEffect, useRef, useState } from "react";
import { api, normalizeStockCode, type StockSearchResult } from "../api";
import { useRecentStocks, type RecentStock } from "../useRecentStocks";
import { useListKeys } from "../useListKeys";

/**
 * 종목 검색칸 — **누르면 최근 본 종목이 먼저 내려온다** (2026-09-04).
 *
 * 벤티지: "커서 올라가면 그 밑에 아래로 해서 최근 조회한 종목 나올 수 있게 해 줄래,
 * 매번 종목명 치기가 귀찮잖아. 다른 데 종목 검색하는 인풋 박스도 포커스되면 밑에
 * 박스 내려오면서 보이게끔."
 *
 * 이 규칙은 원래 **맨 위 종목 바로가기**(`QuickStockSearch`)에만 있었다. 같은 동작을
 * 화면마다 다시 짜면 어디는 되고 어디는 안 되는 상태가 된다 — 그래서 그 동작만 떼어
 * 여기 하나로 두고, 종목을 고르는 자리들이 이걸 쓴다.
 *
 * ## 두 목록을 같이 안 띄운다
 *
 * 아무것도 안 쳤을 때는 **최근 본 종목**, 글자를 치면 그때부터 **검색 결과**가 그 자리를
 * 쓴다. 둘이 같이 뜨면 어느 쪽을 누르는지 헷갈린다(QuickStockSearch 가 정한 규칙 그대로).
 *
 * ## 고르면 최근 목록에 쌓인다
 *
 * 그래야 다음에 열었을 때 바로 있다. 쌓는 곳은 `useRecentStocks` 하나라 어느 화면에서
 * 골랐든 모든 검색칸이 같은 목록을 본다.
 */
export function StockSearchBox({
  placeholder = "종목명 또는 6자리 코드",
  onPick,
  clearOnPick = true,
  autoFocus = false,
  disabled = false,
  note,
}: {
  placeholder?: string;
  onPick: (code: string, name: string) => void;
  /** 고른 뒤 입력칸을 비울까. 관심종목 담기처럼 계속 담는 자리는 비우는 게 맞다 */
  clearOnPick?: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
  /**
   * 줄 끝에 붙일 한마디 — 「이미 담김」처럼. 돌려주면 그 줄은 **못 누른다.**
   * 화면마다 사정이 달라서(관심종목은 중복, 원장은 이미 있는 것) 판단은 부르는 쪽이 한다.
   */
  note?: (code: string, name: string) => string | null;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<StockSearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const recent = useRecentStocks();

  /*
   * ⚠️ **늦게 온 옛 대답이 새 대답을 덮었다** (2026-09-08 — 벤티지 "주문메뉴에서 종목 검색하고
   * 아래에 나오는 검색 결과가 안 나올 때도 있고 이상하네. 딜레이가 있는 듯").
   *
   * 예전엔 요청마다 `setResults` 를 그냥 불렀다. 「하이닉스」를 치면 250ms 마다 요청이 나가는데
   * 응답이 순서대로 온다는 보장이 없다 — 「하이」의 대답이 「하이닉스」의 대답보다 **늦게**
   * 도착하면 맞는 목록이 옛 목록으로 덮이고, 「하」처럼 짧은 글자의 빈 결과가 마지막에 오면
   * 목록이 통째로 사라진다. 그게 「안 나올 때도 있다」의 정체다.
   *
   * 그래서 셋을 고쳤다:
   *   · **번호표**(`seq`) — 마지막으로 보낸 요청의 대답만 화면에 올린다
   *   · **덮지 않는다** — 새 글자를 치는 동안 옛 목록을 지우지 않는다(깜빡임이 사라진다).
   *     실패해도 지우지 않는다 — 한 번 튄 조회 때문에 목록이 비면 안 나온 것처럼 보인다
   *   · **한 번 받은 글자는 기억한다** — 지웠다 다시 치거나 한 글자 지울 때 즉시 뜬다
   */
  const seq = useRef(0);
  const cache = useRef(new Map<string, StockSearchResult[]>());
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setSearching(false);
      return;
    }
    const cached = cache.current.get(q);
    if (cached) {
      setResults(cached);
      setSearching(false);
      return;
    }
    const my = ++seq.current;
    setSearching(true);
    const t = setTimeout(() => {
      void api
        .searchStocks(q)
        .then((r) => {
          const rows = r.results.slice(0, 8);
          cache.current.set(q, rows);
          if (my !== seq.current) return; // 지나간 요청 — 화면은 더 새 글자를 보고 있다
          setResults(rows);
          setSearching(false);
        })
        .catch(() => {
          if (my !== seq.current) return;
          setSearching(false);
        });
    }, 180);
    return () => clearTimeout(t);
  }, [query]);

  /*
   * 바깥을 누르면 닫는다. blur 로 닫으면 **목록의 항목을 누르는 순간**에도 닫혀서
   * 클릭이 먹지 않는다 — 그 버그를 피하려고 문서 클릭을 본다.
   */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function pick(code: string, name: string) {
    const c = normalizeStockCode(code);
    recent.push(c, name);
    setOpen(false);
    setResults([]);
    if (clearOnPick) setQuery("");
    else setQuery(name);
    onPick(c, name);
  }

  const showRecent = open && !query.trim() && recent.recent.length > 0;
  const showResults = open && results.length > 0;
  /* 아직 아무것도 못 받았을 때 — 빈 화면은 「없다」로 읽힌다. 「찾는 중」이라고 말한다 */
  const showBusy = open && Boolean(query.trim()) && results.length === 0 && searching;

  /*
   * 최근 목록과 검색 결과가 **동시에는 안 뜨므로** 훅 하나를 같이 쓴다 — 어느 쪽이
   * 떠 있든 지금 보이는 목록(`activeList`)이 그 자리를 채운다. 이미 담긴 종목(`note`
   * 가 있는 줄)은 원래 클릭도 막혀 있었으니 방향키로 짚어 엔터를 눌러도 건너뛴다.
   */
  const activeList: (RecentStock | StockSearchResult)[] = showRecent
    ? recent.recent
    : showResults
      ? results
      : [];
  const keys = useListKeys(
    activeList,
    (r) => {
      if (note?.(normalizeStockCode(r.code), r.name)) return;
      pick(r.code, r.name);
    },
    { itemClass: "ssb-pick", onEscape: () => setOpen(false) },
  );

  return (
    <div className="ssb" ref={boxRef}>
      <input
        className="ord-in ssb-input"
        type="text"
        inputMode="search"
        autoFocus={autoFocus}
        disabled={disabled}
        placeholder={placeholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => setOpen(true)}
        {...keys.inputProps}
      />

      {showRecent && (
        <div className="ssb-drop" role="listbox">
          <div className="ssb-head">
            최근 본 종목
            <button type="button" onClick={() => recent.clear()} title="목록 비우기">
              비우기
            </button>
          </div>
          {recent.recent.map((r, i) => (
            <div className="ssb-row" key={r.code}>
              <button type="button" {...keys.itemProps(i)} onClick={() => pick(r.code, r.name)}>
                <b>{r.name}</b>
                <span>{r.code}</span>
              </button>
              {/* 잘못 눌러 들어간 것을 뺄 길이 없으면 목록이 지저분해진다 */}
              <button
                type="button"
                className="ssb-del"
                onClick={() => recent.remove(r.code)}
                title="이 종목만 목록에서 빼기"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {showBusy && (
        <div className="ssb-drop">
          <div className="ssb-busy">찾는 중…</div>
        </div>
      )}

      {showResults && (
        <div className="ssb-drop" role="listbox">
          {results.map((r, i) => {
            const n = note?.(normalizeStockCode(r.code), r.name) ?? null;
            return (
              <button
                type="button"
                key={r.code}
                disabled={Boolean(n)}
                onClick={() => pick(r.code, r.name)}
                {...keys.itemProps(i)}
              >
                <b>{r.name}</b>
                <span>{r.code}</span>
                <small>{n ?? r.marketName}</small>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
