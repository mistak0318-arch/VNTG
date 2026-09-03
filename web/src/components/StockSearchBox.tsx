import { useEffect, useRef, useState } from "react";
import { api, normalizeStockCode, type StockSearchResult } from "../api";
import { useRecentStocks } from "../useRecentStocks";

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

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    const t = setTimeout(() => {
      void api
        .searchStocks(q)
        .then((r) => setResults(r.results.slice(0, 8)))
        .catch(() => setResults([]));
    }, 250);
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
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
          if (e.key === "Enter") {
            e.preventDefault();
            const first = results[0];
            if (first) pick(first.code, first.name);
          }
        }}
      />

      {showRecent && (
        <div className="ssb-drop">
          <div className="ssb-head">
            최근 본 종목
            <button type="button" onClick={() => recent.clear()} title="목록 비우기">
              비우기
            </button>
          </div>
          {recent.recent.map((r) => (
            <div className="ssb-row" key={r.code}>
              <button type="button" className="ssb-pick" onClick={() => pick(r.code, r.name)}>
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

      {showResults && (
        <div className="ssb-drop">
          {results.map((r) => {
            const n = note?.(normalizeStockCode(r.code), r.name) ?? null;
            return (
              <button
                type="button"
                className="ssb-pick"
                key={r.code}
                disabled={Boolean(n)}
                onClick={() => pick(r.code, r.name)}
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
