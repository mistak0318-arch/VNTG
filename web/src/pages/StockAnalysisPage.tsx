import { useEffect, useState } from "react";
import { api, normalizeStockCode, type RawRecord, type StockSearchResult } from "../api";
import { IntradayLevelsBar } from "../components/IntradayLevelsBar";
import { StockSummaryPanel } from "../components/StockSummaryPanel";
import { StockTabsSection } from "../components/StockTabsSection";
import { PriceHeader } from "../components/PriceHeader";
import { RefreshBar } from "../components/RefreshBar";
import { useWatchedCodes } from "../useWatchedCodes";
import { useLive } from "../useLive";
import { useRecentStocks } from "../useRecentStocks";

/**
 * 개별종목분석 — 종목 하나를 **넓은 화면에서** 파고드는 페이지.
 *
 * 탭 안쪽은 종목 상세 시트와 **같은 모듈**(`StockTabsSection`)이다. 예전엔 둘이
 * 각자 탭 목록을 들고 있어서, 한쪽에 기능을 넣으면 다른 쪽엔 없었다 — 같은 종목을
 * 보는 화면인데 「담은 ETF 는 시트에만 있고 신용은 여기만 있는」 식이었다.
 *
 * 여기 남는 것은 **페이지의 껍데기**다: 종목 검색·최근 목록·새로고침·제목줄.
 * 시트에는 없는 것들이고, 시트의 모달 헤더는 여기 없다.
 */

export function StockAnalysisPage({
  stock,
  onSelectStock,
}: {
  stock: { code: string; name: string } | null;
  onSelectStock: (code: string, name: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<StockSearchResult[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const watched = useWatchedCodes();
  const recent = useRecentStocks();
  /**
   * 검색칸에 포커스가 있나 — 최근 목록을 펼 시점을 정한다 (2026-08-31).
   *
   * ⚠️ 끄는 것은 **한 박자 늦춘다**(`onBlur` 에 150ms). 목록의 단추를 누르는 순간
   * 입력창이 먼저 포커스를 잃는데, 그때 바로 닫으면 그 클릭이 허공을 친다.
   * 목록 단추들이 `onMouseDown` 에서 기본 동작을 막는 것도 같은 이유다.
   */
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      api
        .searchStocks(q)
        .then((res) => setResults(res.results))
        .catch(() => setResults([]));
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  /*
   * 시세 헤더는 장중에 5초마다 조용히 갱신된다.
   * 아래 시가·고가·저가는 갱신되는데 맨 위 현재가만 멈춰 있으면 오히려 헷갈린다.
   */
  const live = useLive(
    () => (stock ? api.stockInfo(stock.code) : Promise.resolve(null)),
    [stock?.code, reloadKey],
    5000,
  );
  const info = (live.data ?? null) as RawRecord | null;

  function pickResult(r: StockSearchResult) {
    const code = normalizeStockCode(r.code);
    recent.push(code, r.name);
    onSelectStock(code, r.name);
    setQuery("");
    setResults([]);
  }

  /*
   * 주소로 바로 들어온 경우(관심종목 클릭, 링크 공유)도 최근 목록에 남긴다.
   * 검색으로 고른 것만 기억하면 정작 자주 오가는 종목이 목록에 안 쌓인다.
   */
  useEffect(() => {
    if (stock?.code && stock.name) recent.push(stock.code, stock.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stock?.code]);

  return (
    <div>
      <div className="search-box">
        <input
          className="search-input"
          type="text"
          inputMode="search"
          placeholder="종목명 또는 종목코드 입력 (예: 삼성전자, 000660)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
        />
        {/*
          포커스가 갔는데 **아무것도 안 쳤을 때** 최근 목록을 편다 (2026-08-31 요청 —
          「밑에 포도알처럼 붙지 말고 검색 인풋에 포인트 갔을 때 아래 목록 펼쳐지고
          바로 클릭하게」). 글자를 치면 그때부터 검색 결과가 그 자리를 쓴다.
        */}
        {focused && !query.trim() && recent.recent.length > 0 && (
          <div className="search-dropdown">
            <div className="qss-recent-head">
              최근 본 종목
              <button onMouseDown={(e) => e.preventDefault()} onClick={() => recent.clear()}>
                비우기
              </button>
            </div>
            {recent.recent.map((r) => (
              <div className="qss-recent-row" key={r.code}>
                <button
                  className="search-result-row"
                  /* mousedown 에서 blur 가 먼저 나면 클릭이 안 먹는다 — 막아 둔다 */
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setFocused(false);
                    onSelectStock(r.code, r.name);
                  }}
                >
                  <span className="name">{r.name}</span>
                  <span className="sub">{r.code}</span>
                </button>
                <button
                  className="qss-recent-del"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => recent.remove(r.code)}
                  title="이 종목만 목록에서 빼기"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
        {query.trim() && results.length > 0 && (
          <div className="search-dropdown">
            {results.map((r) => (
              <button key={r.code} className="search-result-row" onClick={() => pickResult(r)}>
                <span className="name">{r.name}</span>
                <span className="sub">
                  {r.code} · {r.marketName}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/*
        ⚠️ 최근 본 종목을 **칩 줄로 깔아 두지 않는다** (2026-08-31 요청 — 「포도알처럼
        붙지 않아? 그거 말고」). 열두 개가 두 줄로 쌓이면 화면 위쪽을 늘 차지하는데,
        정작 쓰는 순간은 **검색하려고 할 때**뿐이다. 그때만 검색칸 아래로 편다.
      */}

      {!stock && (
        <div className="page-note">
          종목을 검색하면 호가·거래원·프로그램매매·신용·체결강도를 한 화면에서 볼 수 있습니다.
        </div>
      )}

      {stock && (
        <>
          <RefreshBar onRefresh={() => setReloadKey((k) => k + 1)} />

          <div className="analysis-title">
            <h2>
              {/* 코스피/코스닥 — 같은 +5% 라도 판이 다르다 */}
              {info && String(info._market ?? "") && (
                <span className={`mkt-badge ${String(info._market).includes("코스닥") ? "kq" : "ks"}`}>
                  {String(info._market).includes("코스닥") ? "코스닥" : "코스피"}
                </span>
              )}
              {watched.isWatched(stock.code) ? "★ " : ""}
              {stock.name} <span className="analysis-code">{stock.code}</span>
            </h2>
            {/* 제목줄에도 현재가 — 이미 5초 폴링 중인 info 를 그릴 뿐이다 */}
            {info && Math.abs(Number(info.cur_prc)) > 0 && (
              <span
                className={`sheet-live num ${
                  Number(info.flu_rt) > 0 ? "positive" : Number(info.flu_rt) < 0 ? "negative" : ""
                }`}
              >
                <b>{Math.abs(Number(info.cur_prc)).toLocaleString("ko-KR")}</b>
                <i>
                  {Number(info.flu_rt) > 0 ? "+" : ""}
                  {Number(info.flu_rt).toFixed(2)}%
                </i>
              </span>
            )}
          </div>

          <PriceHeader info={info} code={stock.code} />
          {/*
            가격 바로 아래다 — **견줄 선은 견줄 값 옆에 있어야** 한다.
            탭 안에 넣으면 눌러야 보이는데, 이건 늘 보면서 판단하는 값이다.
          */}
          <IntradayLevelsBar code={stock.code} key={`idl-${stock.code}-${reloadKey}`} />
          {/* 한 장 요약 — 시트와 같은 자리, 같은 컴포넌트 */}
          <StockSummaryPanel code={stock.code} />

          <StockTabsSection
            code={stock.code}
            name={stock.name}
            info={info}
            onSelectStock={onSelectStock}
            reloadKey={reloadKey}
          />
        </>
      )}
    </div>
  );
}
