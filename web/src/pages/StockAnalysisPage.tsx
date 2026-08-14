import { useEffect, useState } from "react";
import { api, normalizeStockCode, pickList, type RawRecord, type StockSearchResult } from "../api";
import { ChartPanel } from "../components/ChartPanel";
import { IntradayFlow, ProgramFlowBars } from "../components/IntradayPanels";
import { InvestorTrendTable } from "../components/InvestorTrendTable";
import { PriceHeader } from "../components/PriceHeader";
import { RefreshBar } from "../components/RefreshBar";
import { SectorMoodPanel } from "../components/SectorMoodPanel";
import { SignalPanel } from "../components/SignalLight";
import { StockNotes } from "../components/StockNotes";
import { SupplyMiniCharts } from "../components/SupplyDetailPanel";
import {
  BrokerPanel,
  CreditPanel,
  DailyDetailPanel,
  QuoteBookPanel,
  QuoteSummary,
  StockProgramPanel,
  StrengthPanel,
} from "../components/StockDepthPanels";
import { useWatchedCodes } from "../useWatchedCodes";
import { useLive } from "../useLive";
import { useRecentStocks } from "../useRecentStocks";

/**
 * 개별종목분석 — 키움 앱에서 종목 하나를 파고들 때 쓰는 화면들을 한 페이지에 모았다.
 * 종목 상세(모달)가 "기업을 이해하는" 화면이라면, 여기는 "지금 이 종목의 수급·체결을 보는" 화면.
 */

type AnalysisTab =
  | "chart"
  | "quote"
  | "broker"
  | "investor"
  | "program"
  | "credit"
  | "strength"
  | "daily"
  | "notes";

const TABS: { key: AnalysisTab; label: string }[] = [
  { key: "chart", label: "종합" },
  { key: "quote", label: "호가" },
  { key: "broker", label: "거래원" },
  { key: "investor", label: "투자자 수급" },
  { key: "program", label: "프로그램" },
  { key: "credit", label: "신용" },
  { key: "strength", label: "체결강도" },
  { key: "daily", label: "일별상세" },
  { key: "notes", label: "메모" },
];

export function StockAnalysisPage({
  stock,
  onSelectStock,
}: {
  stock: { code: string; name: string } | null;
  onSelectStock: (code: string, name: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<StockSearchResult[]>([]);
  const [tab, setTab] = useState<AnalysisTab>("chart");
  const [investorChart, setInvestorChart] = useState<RawRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const watched = useWatchedCodes();
  const recent = useRecentStocks();

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
   * 투자자 수급은 일별이라 자주 부를 이유가 없어 진입할 때만 받는다.
   */
  const live = useLive(
    () => (stock ? api.stockInfo(stock.code) : Promise.resolve(null)),
    [stock?.code, reloadKey],
    5000,
  );
  const info = (live.data ?? null) as RawRecord | null;

  useEffect(() => {
    if (!stock) {
      setInvestorChart(null);
      return;
    }
    let cancelled = false;
    setError(null);
    api
      .investorChart(stock.code)
      .then((v) => {
        if (!cancelled) setInvestorChart(v as RawRecord);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [stock?.code, reloadKey]);

  const investorRows = pickList(investorChart ?? undefined, ["stk_invsr_orgn_chart"]);

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
        />
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

      {recent.recent.length > 0 && (
        <div className="recent-row">
          <span className="recent-cap">최근</span>
          {recent.recent.map((r) => (
            <span
              className={`recent-chip${stock?.code === r.code ? " active" : ""}`}
              key={r.code}
            >
              <button onClick={() => onSelectStock(r.code, r.name)}>{r.name}</button>
              <button
                className="recent-x"
                onClick={() => recent.remove(r.code)}
                title="목록에서 제거"
              >
                ✕
              </button>
            </span>
          ))}
          <button className="recent-clear" onClick={recent.clear} title="최근 목록 비우기">
            지우기
          </button>
        </div>
      )}

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
              {watched.isWatched(stock.code) ? "★ " : ""}
              {stock.name} <span className="analysis-code">{stock.code}</span>
            </h2>
          </div>

          {error && <div className="error-banner">{error}</div>}
          <PriceHeader info={info} code={stock.code} />

          <SectorMoodPanel
            code={stock.code}
            onSelectStock={onSelectStock}
            key={`mood-${stock.code}-${reloadKey}`}
          />

          <nav className="detail-tabs">
            {TABS.map((t) => (
              <button
                key={t.key}
                className={`detail-tab${tab === t.key ? " active" : ""}`}
                onClick={() => setTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </nav>

          <div key={`${stock.code}-${tab}-${reloadKey}`}>
            {/* 차트 탭은 "오늘 이 종목이 어땠나"를 위에서 아래로 훑는 종합 화면 */}
            {tab === "chart" && (
              <>
                <SignalPanel code={stock.code} onSelectStock={onSelectStock} />
                <QuoteSummary code={stock.code} />
                <IntradayFlow code={stock.code} basePrice={Math.abs(Number(info?.base_pric)) || 0} />
                <ChartPanel code={stock.code} name={stock.name} />
                <h3 className="section-heading">투자자 수급</h3>
                <InvestorTrendTable rows={investorRows} />
                <h3 className="section-heading">프로그램 수급</h3>
                <ProgramFlowBars code={stock.code} />
                <SupplyMiniCharts code={stock.code} />
              </>
            )}
            {tab === "quote" && <QuoteBookPanel code={stock.code} />}
            {tab === "broker" && <BrokerPanel code={stock.code} />}
            {tab === "investor" && <InvestorTrendTable rows={investorRows} />}
            {tab === "program" && <StockProgramPanel code={stock.code} />}
            {tab === "credit" && <CreditPanel code={stock.code} />}
            {tab === "strength" && <StrengthPanel code={stock.code} />}
            {tab === "daily" && <DailyDetailPanel code={stock.code} />}
            {tab === "notes" && (
              <StockNotes
                code={stock.code}
                name={stock.name}
                currentPrice={Math.abs(Number(info?.cur_prc)) || undefined}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
