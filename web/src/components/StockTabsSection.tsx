import { useEffect, useState } from "react";
import { api, pickList, type RawRecord } from "../api";
import { ChartPanel } from "./ChartPanel";
import { EtfPanel } from "./EtfPanel";
import { EtfHoldersPanel } from "./EtfHoldersPanel";
import { IntradayFlow, ProgramFlowBars } from "./IntradayPanels";
import { CompanyPanel } from "./CompanyPanel";
import { type PeriodReturns } from "./CompanySnapshot";
import { InvestorTrendTable } from "./InvestorTrendTable";
import { NewsDisclosurePanel } from "./NewsDisclosurePanel";
import { OpinionPanel } from "./OpinionPanel";
import { RawJson } from "./RawJson";
import { SectorMoodPanel } from "./SectorMoodPanel";
import { SignalPanel } from "./SignalLight";
import { StockNotes } from "./StockNotes";
import { SupplyDetailPanel, SupplyMiniCharts } from "./SupplyDetailPanel";
import { TabScroller } from "./TabScroller";
import { TradeSizePanel } from "./TradeSizePanel";
import { OrderBookPanel } from "./OrderBookPanel";
import { BrokerFlowPanel } from "./BrokerFlowPanel";
import { ProgramFlowPanel } from "./ProgramFlowPanel";
import { CreditPanel, DailyDetailPanel, QuoteSummary, StrengthPanel } from "./StockDepthPanels";
import { useCardOrder } from "../useCardOrder";
import { useSwipeTabs, visualOrder } from "../useSwipeTabs";

/**
 * 종목 하나를 보는 **탭 묶음 — 화면 두 곳이 같이 쓴다.**
 *
 * ## 왜 합쳤나 (2026-08-27)
 *
 * 「종목 상세 시트」와 「개별종목분석 페이지」가 각자 탭 목록과 패널 배치를 들고 있었다.
 * 둘 다 같은 종목을 보는 화면인데 탭 구성이 갈려서, **한쪽에 기능을 넣으면 다른 쪽엔
 * 없었다.** 실제로 「담은 ETF」·「차트만」·「업종·테마」는 시트에만 있었고, 「호가」는
 * 이름부터 quote/orderbook 으로 달랐다. 그때마다 사용자가 두 번 말해야 했다.
 *
 * 이제 **탭 목록도 패널도 여기 하나뿐이다.** 새 탭은 `STOCK_TABS` 에 한 줄, 렌더는
 * `panel()` 에 한 줄 — 그러면 두 화면에 동시에 생긴다.
 *
 * 화면마다 다른 것(검색창·최근 목록·모달 헤더·닫기 버튼)은 **각자 바깥에** 남는다.
 * 여기는 「종목을 어떻게 들여다보나」만 책임진다.
 */

export type StockTab =
  | "chart"
  | "chartOnly"
  | "orderbook"
  | "broker"
  | "program"
  | "investor"
  | "credit"
  | "strength"
  | "tradeSize"
  | "daily"
  | "opinion"
  | "supply"
  | "notes"
  | "sector"
  | "etfHolders"
  | "feed"
  | "finance"
  | "raw"
  /** ETF 일 때만 나타난다 — 저장되는 순서 배열에는 안 낀다 */
  | "etf";

/**
 * 기본 순서 — 「실제 매매에 바로 쓰는 것」이 앞이다.
 * 차트 → 체결·호가 → 수급 → 공매도/대차 → 이 종목이 속한 묶음 → 뉴스·재무.
 * 저장된 순서가 있으면 그게 이긴다(`useCardOrder`). 여기 없는 탭은 화면에 안 뜬다.
 */
export const STOCK_TABS: { key: StockTab; label: string }[] = [
  { key: "chart", label: "종합" },
  /*
    「차트만」 — 종합 탭은 신호등과 장중 수급이 위에 얹혀 차트가 아래로 밀린다.
    차트를 크게 오래 보고 싶을 때가 따로 있어서 그 탭을 둔다.
  */
  { key: "chartOnly", label: "차트만" },
  { key: "orderbook", label: "호가" },
  { key: "broker", label: "거래원" },
  { key: "program", label: "프로그램" },
  { key: "investor", label: "투자자 수급" },
  { key: "credit", label: "신용" },
  { key: "strength", label: "체결강도" },
  { key: "tradeSize", label: "체결금액대" },
  { key: "daily", label: "일별상세" },
  { key: "opinion", label: "목표주가" },
  { key: "supply", label: "외국인·공매도·대차" },
  { key: "notes", label: "메모" },
  { key: "sector", label: "테마" },
  /* 이 종목을 편입한 ETF 들 — 업종·테마 옆이다. 셋 다 「어느 묶음에 속하나」를 답한다 */
  { key: "etfHolders", label: "담은 ETF" },
  { key: "feed", label: "뉴스·공시" },
  { key: "finance", label: "기업·재무" },
  { key: "raw", label: "원본 데이터" },
];

/**
 * ETF 에서 숨기는 탭 — 개별 기업의 것만 뺀다.
 * 목표주가·업종테마·기업재무·담은ETF 는 ETF 에서 빈 화면이거나 뜻이 없다.
 * 호가·거래원·프로그램·수급·공매도는 ETF 도 똑같이 거래되는 값이라 남는다.
 */
const ETF_HIDDEN = new Set<StockTab>(["opinion", "sector", "finance", "etfHolders"]);

// 거래일수 근사치 (달력상 개월수를 거래일로 환산)
const RETURN_WINDOWS = { m1: 21, m3: 63, m6: 126, y1: 252 };

function computeReturns(dailyCloses: number[]): PeriodReturns {
  // dailyCloses: 최신순(0번째=오늘)
  const latest = dailyCloses[0];
  function ret(days: number): number | null {
    if (!Number.isFinite(latest) || dailyCloses.length <= days) return null;
    const past = dailyCloses[days];
    if (!Number.isFinite(past) || past === 0) return null;
    return ((latest - past) / past) * 100;
  }
  return { m1: ret(RETURN_WINDOWS.m1), m3: ret(RETURN_WINDOWS.m3), m6: ret(RETURN_WINDOWS.m6), y1: ret(RETURN_WINDOWS.y1) };
}

export function StockTabsSection({
  code,
  name,
  info,
  onSelectStock,
  reloadKey = 0,
}: {
  code: string;
  name: string;
  /** 현재가 폴링 결과 — 폴링 주기는 화면마다 달라서 **바깥에서** 받는다 */
  info: RawRecord | null;
  onSelectStock?: (code: string, name: string) => void;
  /** 새로고침 버튼을 누르면 올린다 — 패널들이 통째로 다시 마운트된다 */
  reloadKey?: number;
}) {
  const [tab, setTab] = useState<StockTab>("chart");
  const [editTabs, setEditTabs] = useState(false);
  const [investorChart, setInvestorChart] = useState<RawRecord | null>(null);
  const [daily, setDaily] = useState<RawRecord | null>(null);
  const [isEtf, setIsEtf] = useState(false);

  /* ETF 인가 — 맞으면 「ETF 정보」 탭이 종합 옆에 나타나고 기업 전용 탭이 빠진다 */
  useEffect(() => {
    let alive = true;
    setIsEtf(false);
    api
      .etfInfo(code)
      .then((r) => alive && setIsEtf(r.etf))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [code]);

  // 사라진 탭에 남아 있으면 빠져나온다 (ETF ↔ 일반 종목을 오갈 때)
  useEffect(() => {
    if (!isEtf && tab === "etf") setTab("chart");
    if (isEtf && ETF_HIDDEN.has(tab)) setTab("chart");
  }, [isEtf, tab]);

  /*
   * 투자자 수급 — 종합 탭에도 들어가므로 종목이 바뀌면 바로 받는다. 일별이라 폴링 안 한다.
   *
   * `investorDays` 는 표가 「더 긴 기간을 골랐다」고 알려 줄 때만 오른다 (2026-08-31).
   * 기본값 0 은 **예전처럼 한 번만** 부른다는 뜻이다 — 한 번에 100줄이 오므로
   * 120일까지는 이걸로 이미 충분하고, 240일을 고른 사람만 한 쪽을 더 받는다.
   */
  const [investorDays, setInvestorDays] = useState(0);
  useEffect(() => setInvestorDays(0), [code]); // 종목이 바뀌면 다시 기본으로
  useEffect(() => {
    let cancelled = false;
    setInvestorChart(null);
    api
      .investorChart(code, investorDays || undefined)
      .then((v) => !cancelled && setInvestorChart(v as RawRecord))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [code, reloadKey, investorDays]);

  /*
   * 기간수익률용 일봉은 **기업·재무 탭에 들어갈 때만** 받는다.
   * 예전엔 시트가 열리자마자 받았는데, 쓰는 곳은 재무 카드 한 곳뿐이라
   * 열어 보지도 않는 값을 매번 받는 셈이었다. (원본 데이터 탭도 이걸 쓴다)
   */
  useEffect(() => {
    if (tab !== "finance" && tab !== "raw") return;
    if (daily) return;
    let cancelled = false;
    api
      .dailyChart(code)
      .then((v) => !cancelled && setDaily(v as RawRecord))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [tab, code, daily]);

  // 종목이 바뀌면 지난 종목의 일봉을 들고 있으면 안 된다
  useEffect(() => {
    setDaily(null);
  }, [code]);

  const visibleTabs = isEtf ? STOCK_TABS.filter((t) => !ETF_HIDDEN.has(t.key)) : STOCK_TABS;
  /*
   * 탭 순서 — 카드 배치와 **같은 훅**(서버 저장, 기기가 달라도 같은 순서).
   * ETF 는 순서를 따로 저장한다: 보는 정보가 다르니 배치도 따로가 맞다.
   * 키는 시트가 쓰던 것을 그대로 쓴다 — 이미 정해 둔 순서가 안 날아간다.
   */
  const tabOrder = useCardOrder(
    isEtf ? "stockDetail.tabs.etf" : "stockDetail.tabs",
    visibleTabs.map((t) => t.key),
  );

  /*
   * 폰 — 본문 좌우 스와이프로 이웃 탭 (2026-08-28). 열여덟 탭이라 여기가 제일 절실하다:
   * 탭 줄을 밀어 찾는 대신 본문을 밀면 다음 탭이다.
   */
  const swipe = useSwipeTabs({
    order: visualOrder(visibleTabs.map((t) => t.key), tabOrder.orderOf),
    current: tab,
    onChange: (k) => setTab(k as StockTab),
  });

  const investorRows = pickList(investorChart ?? undefined, ["stk_invsr_orgn_chart"]);
  const dailyCloses = pickList(daily ?? undefined, ["stk_dt_pole_chart_qry"])
    .map((c) => Number(c.cur_prc))
    .filter((n) => Number.isFinite(n));
  const returns = dailyCloses.length > 0 ? computeReturns(dailyCloses) : null;
  const basePrice = Math.abs(Number(info?.base_pric)) || 0;
  const curPrice = Math.abs(Number(info?.cur_prc)) || undefined;

  return (
    /* Fragment 였다 — 스와이프 핸들러를 얹으려면 실제 요소가 필요하다 */
    <div {...swipe}>
      <TabScroller className="detail-tabs" activeKey={tab}>
        {visibleTabs.map((t) => (
          <button
            key={t.key}
            className={`detail-tab${tab === t.key ? " active" : ""}${tabOrder.drag.cls(t.key)}`}
            style={{ order: tabOrder.orderOf(t.key) }}
            onClick={() => setTab(t.key)}
            {...tabOrder.drag.props(t.key)}
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
        {/*
          ETF 정보 — ETF 일 때만. order 를 종합과 같게 주면 flex 동점 규칙(DOM 순서)으로
          종합 바로 옆에 선다. 저장되는 순서 배열에는 안 끼운다 — 종목 따라 있다 없다 하는
          탭이 섞이면 저장분이 지저분해진다.
        */}
        {isEtf && (
          <button
            className={`detail-tab${tab === "etf" ? " active" : ""}`}
            style={{ order: tabOrder.orderOf("chart") }}
            onClick={() => setTab("etf")}
          >
            ETF 정보
          </button>
        )}
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
          탭 이름 옆 <b>◀ ▶</b> 로 옮깁니다. 서버에 저장되어 <b>다른 기기에서도 같은 순서</b>
          입니다 — 종목 상세와 개별종목분석이 같은 순서를 씁니다.
          {tabOrder.customized && (
            <button className="filter-btn dt-reset" onClick={tabOrder.reset}>
              원래대로
            </button>
          )}
        </div>
      )}

      <div key={`${code}-${tab}-${reloadKey}`}>
        {/* 종합 — 「오늘 이 종목이 어땠나」를 위에서 아래로 훑는다 */}
        {tab === "chart" && (
          <>
            <SignalPanel code={code} onSelectStock={onSelectStock} />
            <QuoteSummary code={code} />
            <IntradayFlow code={code} basePrice={basePrice} />
            <ChartPanel code={code} name={name} />
            <h3 className="section-heading">투자자 수급</h3>
            <InvestorTrendTable rows={investorRows} onNeedDays={setInvestorDays} />
            <h3 className="section-heading">프로그램 수급</h3>
            <ProgramFlowBars code={code} />
            <SupplyMiniCharts code={code} />
          </>
        )}
        {tab === "chartOnly" && <ChartPanel code={code} name={name} viewId="detail.chartOnly" height={520} />}
        {tab === "orderbook" && <OrderBookPanel code={code} />}
        {tab === "broker" && <BrokerFlowPanel code={code} />}
        {tab === "program" && <ProgramFlowPanel code={code} />}
        {tab === "investor" && <InvestorTrendTable rows={investorRows} onNeedDays={setInvestorDays} />}
        {tab === "credit" && <CreditPanel code={code} />}
        {tab === "strength" && <StrengthPanel code={code} />}
        {tab === "tradeSize" && <TradeSizePanel code={code} />}
        {tab === "daily" && <DailyDetailPanel code={code} />}
        {tab === "opinion" && <OpinionPanel code={code} />}
        {tab === "supply" && <SupplyDetailPanel code={code} />}
        {tab === "notes" && <StockNotes code={code} name={name} currentPrice={curPrice} />}
        {tab === "sector" && <SectorMoodPanel code={code} onSelectStock={onSelectStock} />}
        {tab === "etfHolders" && <EtfHoldersPanel code={code} name={name} onSelectStock={onSelectStock} />}
        {tab === "feed" && <NewsDisclosurePanel code={code} name={name} />}
        {tab === "finance" && <CompanyPanel code={code} name={name} info={info} returns={returns} />}
        {tab === "etf" && <EtfPanel code={code} onSelectStock={onSelectStock} />}
        {tab === "raw" && <RawJson data={{ info, investorChart, daily }} />}
      </div>
    </div>
  );
}
