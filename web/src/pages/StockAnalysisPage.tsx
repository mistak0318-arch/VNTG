import { useEffect, useState } from "react";
import { TradeSizePanel } from "../components/TradeSizePanel";
import { api, normalizeStockCode, pickList, type RawRecord, type StockSearchResult } from "../api";
import { ChartPanel } from "../components/ChartPanel";
import { IntradayFlow, ProgramFlowBars } from "../components/IntradayPanels";
import { InvestorTrendTable } from "../components/InvestorTrendTable";
import { CompanyPanel } from "../components/CompanyPanel";
import { IntradayLevelsBar } from "../components/IntradayLevelsBar";
import { NewsDisclosurePanel } from "../components/NewsDisclosurePanel";
import { OpinionPanel } from "../components/OpinionPanel";
import { StockSummaryPanel } from "../components/StockSummaryPanel";
import { SupplyDetailPanel } from "../components/SupplyDetailPanel";
import { TabScroller } from "../components/TabScroller";
import { useCardOrder } from "../useCardOrder";
import { PriceHeader } from "../components/PriceHeader";
import { RefreshBar } from "../components/RefreshBar";
import { SectorMoodPanel } from "../components/SectorMoodPanel";
import { SignalPanel } from "../components/SignalLight";
import { StockNotes } from "../components/StockNotes";
import { SupplyMiniCharts } from "../components/SupplyDetailPanel";
import {
  CreditPanel,
  DailyDetailPanel,
  QuoteSummary,
  StrengthPanel,
} from "../components/StockDepthPanels";
import { useWatchedCodes } from "../useWatchedCodes";
import { useLive } from "../useLive";
import { useRecentStocks } from "../useRecentStocks";
import { OrderBookPanel } from "../components/OrderBookPanel";
import { BrokerFlowPanel } from "../components/BrokerFlowPanel";
import { ProgramFlowPanel } from "../components/ProgramFlowPanel";

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
  | "tradeSize"
  | "daily"
  | "opinion"
  | "supply"
  | "feed"
  | "finance"
  | "notes";

const TABS: { key: AnalysisTab; label: string }[] = [
  { key: "chart", label: "종합" },
  { key: "quote", label: "호가" },
  { key: "broker", label: "거래원" },
  { key: "investor", label: "투자자 수급" },
  { key: "program", label: "프로그램" },
  { key: "credit", label: "신용" },
  { key: "strength", label: "체결강도" },
  { key: "tradeSize", label: "체결금액대" },
  { key: "daily", label: "일별상세" },
  /*
   * ── 아래 넷은 **종목 상세 시트에만 있던 것들**이다 (P27).
   *
   * 「개별종목분석」이 호가·거래원·체결강도로는 더 깊은데, 정작 **목표주가·재무·뉴스**가
   * 없어서 그걸 보려면 다른 화면으로 나가야 했다. 같은 종목을 두 화면으로 나눠 보는
   * 셈이라, 종목을 깊게 볼수록 화면을 더 자주 옮겨 다녀야 했다 — 거꾸로다.
   *
   * 시트가 쓰던 **그 컴포넌트를 그대로** 붙인다. 새로 그리면 두 화면이 언젠가 갈린다.
   */
  { key: "opinion", label: "목표주가" },
  { key: "supply", label: "외국인·공매도·대차" },
  { key: "feed", label: "뉴스·공시" },
  /* 상세 시트와 같은 통합 화면 — 한 줄 진단 → 핵심 칩 → 추정·분기·연간 */
  { key: "finance", label: "기업·재무" },
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
  const [editTabs, setEditTabs] = useState(false);
  /* 카드 배치·상세 시트와 **같은 훅**. 키만 다르다 — 탭 구성이 달라서다 */
  const tabOrder = useCardOrder(
    "stockAnalysis.tabs",
    TABS.map((t) => t.key),
  );
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
              {/* 코스피/코스닥 — 같은 +5% 라도 판이 다르다 */}
              {info && String(info._market ?? "") && (
                <span
                  className={`mkt-badge ${String(info._market).includes("코스닥") ? "kq" : "ks"}`}
                >
                  {String(info._market).includes("코스닥") ? "코스닥" : "코스피"}
                </span>
              )}
              {watched.isWatched(stock.code) ? "★ " : ""}
              {stock.name} <span className="analysis-code">{stock.code}</span>
            </h2>
            {/* 제목줄에도 현재가 — 시트 헤더와 같은 이유(아이디어노트 4). 이미 5초 폴링 중인 info 를 그릴 뿐이다 */}
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

          {error && <div className="error-banner">{error}</div>}
          <PriceHeader info={info} code={stock.code} />
          {/*
            가격 바로 아래다 — **견줄 선은 견줄 값 옆에 있어야** 한다.
            탭 안에 넣으면 눌러야 보이는데, 이건 늘 보면서 판단하는 값이다.
          */}
          <IntradayLevelsBar code={stock.code} key={`idl-${stock.code}-${reloadKey}`} />

          <SectorMoodPanel
            code={stock.code}
            onSelectStock={onSelectStock}
            key={`mood-${stock.code}-${reloadKey}`}
          />

          {/*
            탭 순서 바꾸기 — **종목 상세 시트와 같은 훅**이다(서버 저장, 기기가 달라도 같은 순서).
            탭이 열둘을 넘으면서 자주 보는 게 뒤로 밀렸다. JSX 를 재배열하지 않고 CSS `order` 만 준다.
            ⚠️ 저장 키는 시트와 **따로** 둔다 — 탭 구성이 다르므로 같은 키를 쓰면 서로 흔든다.
          */}
          <TabScroller className="detail-tabs" activeKey={tab}>
            {TABS.map((t) => (
              <button
                key={t.key}
                className={`detail-tab${tab === t.key ? " active" : ""}`}
                style={{ order: tabOrder.orderOf(t.key) }}
                onClick={() => setTab(t.key)}
              >
                {t.label}
                {editTabs && (
                  <>
                    <span
                      className="dt-move"
                      role="button"
                      title="앞으로"
                      onClick={(e) => {
                        e.stopPropagation();
                        tabOrder.move(t.key, -1);
                      }}
                    >
                      ◀
                    </span>
                    <span
                      className="dt-move"
                      role="button"
                      title="뒤로"
                      onClick={(e) => {
                        e.stopPropagation();
                        tabOrder.move(t.key, 1);
                      }}
                    >
                      ▶
                    </span>
                  </>
                )}
              </button>
            ))}
            <button
              className={`detail-tab dt-edit${editTabs ? " active" : ""}`}
              style={{ order: 999 }}
              onClick={() => setEditTabs((v) => !v)}
              title="자주 보는 탭을 앞으로 옮깁니다"
            >
              {editTabs ? "순서 끝" : "탭 순서"}
            </button>
          </TabScroller>

          {editTabs && (
            <div className="table-note">
              탭 이름 옆 <b>◀ ▶</b> 로 옮깁니다. 서버에 저장되어 <b>다른 기기에서도 같은
              순서</b>입니다.
              {tabOrder.customized && (
                <button className="filter-btn dt-reset" onClick={tabOrder.reset}>
                  원래대로
                </button>
              )}
            </div>
          )}

          <div key={`${stock.code}-${tab}-${reloadKey}`}>
            {/* 차트 탭은 "오늘 이 종목이 어땠나"를 위에서 아래로 훑는 종합 화면 */}
            {tab === "chart" && (
              <>
                {/*
                  **한 장 요약이 맨 위다.**

                  값이 흩어져 있어서 「이 종목 지금 어떤가」를 보려고 화면을 위아래로
                  훑어야 했다. 몸값(시총·회전율·체결강도)과 오늘 수급(개인·외국인·
                  기관 세부·프로그램)을 표 두 개로 모은다 — 줄을 맞춰 세워야 눈이 한 번에 훑는다.
                */}
                <StockSummaryPanel code={stock.code} />
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
            {/*
              **종목 상세와 같은 컴포넌트를 쓴다.**
              예전엔 이 페이지가 자기 호가·거래원을 따로 갖고 있어서, 같은 종목인데
              화면마다 보이는 값이 달랐다. 고칠 때도 한쪽만 고쳐지기 쉬웠다.
            */}
            {tab === "quote" && <OrderBookPanel code={stock.code} />}
            {tab === "broker" && <BrokerFlowPanel code={stock.code} />}
            {tab === "investor" && <InvestorTrendTable rows={investorRows} />}
            {tab === "program" && <ProgramFlowPanel code={stock.code} />}
            {tab === "credit" && <CreditPanel code={stock.code} />}
            {tab === "strength" && <StrengthPanel code={stock.code} />}
            {/*
              체결 한 건의 금액 크기별 분포. 체결강도 바로 옆에 둔다 —
              둘 다 "체결을 어떻게 쪼개 보나"라 같이 읽힌다.
            */}
            {tab === "tradeSize" && <TradeSizePanel code={stock.code} />}
            {tab === "daily" && <DailyDetailPanel code={stock.code} />}
            {/* 종목 상세 시트가 쓰는 그 컴포넌트 그대로 — 새로 그리면 두 화면이 갈린다 */}
            {tab === "opinion" && <OpinionPanel code={stock.code} />}
            {tab === "supply" && <SupplyDetailPanel code={stock.code} />}
            {tab === "feed" && <NewsDisclosurePanel code={stock.code} name={stock.name} />}
            {tab === "finance" && <CompanyPanel code={stock.code} info={info} />}
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
