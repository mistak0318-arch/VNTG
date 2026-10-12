import { useEffect, useState } from "react";
import type React from "react";
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
import { ReportsPanel } from "./ReportsPanel";
import { RawJson } from "./RawJson";
import { StockBoardPanel } from "./StockBoardPanel";
import { SectorMoodPanel } from "./SectorMoodPanel";
import { SignalPanel } from "./SignalLight";
import { StockNotes } from "./StockNotes";
import { SupplyDetailPanel, SupplyMiniCharts, VolumeFlowChart } from "./SupplyDetailPanel";
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
  /** 네이버 종목토론실 (2026-09-09) — 우리 값이 아니라 남의 말이라 맨 끝이다 */
  | "board"
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
  { key: "opinion", label: "목표주가·리포트" },
  { key: "supply", label: "외국인·공매도·대차" },
  { key: "notes", label: "메모" },
  { key: "sector", label: "테마" },
  /* 이 종목을 편입한 ETF 들 — 업종·테마 옆이다. 셋 다 「어느 묶음에 속하나」를 답한다 */
  { key: "etfHolders", label: "담은 ETF" },
  { key: "feed", label: "뉴스·공시" },
  { key: "finance", label: "기업·재무" },
  /*
    종목토론 — **맨 끝** (2026-09-09, 벤티지 "종목상세 마지막 탭에 네이버 종목토론실").
    앞의 탭은 전부 우리가 받아 온 값이고 이건 검증 안 된 남의 말이라, 순서가 곧
    「어느 것을 먼저 믿나」다. 원본 데이터보다도 뒤에 둔다.
  */
  { key: "board", label: "종목토론" },
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
  summaryTop,
  tab: tabFromParent,
  onTabChange,
  splitTabs = false,
}: {
  code: string;
  name: string;
  /** 현재가 폴링 결과 — 폴링 주기는 화면마다 달라서 **바깥에서** 받는다 */
  info: RawRecord | null;
  onSelectStock?: (code: string, name: string) => void;
  /**
   * 「종합」 탭 **맨 위**에 끼워 넣을 것 (2026-10-12 — 종목상세 「넓게 보기」).
   *
   * 넓게 보기에서는 가격·당일흐름·기준선·한 장 요약이 탭 **위**에 쌓이지 않고 종합 탭
   * 안으로 들어온다. 그래야 「머리줄 → 탭 줄 → 고른 하나」가 되어, 탭을 보려고 한참
   * 스크롤하지 않아도 된다 — 증권플러스가 넓어 보이는 까닭이 그 구조다.
   * 안 주면 아무 일도 안 일어난다. 예전 모양은 그대로다.
   */
  summaryTop?: React.ReactNode;
  /**
   * 바깥에서 탭을 들고 있을 때 (2026-10-12 — 아래 빠른 줄).
   *
   * 평소에는 이 부품이 제 탭을 들고 있다. 넓게 보기에서는 **아래 고정 줄**이 같은 탭을
   * 가리키므로, 둘이 따로 들고 있으면 한쪽을 눌러도 다른 쪽이 모른다 — 하나만 들어야 한다.
   * 안 넘기면 예전 그대로다.
   */
  tab?: string;
  onTabChange?: (k: string) => void;
  /** 탭 줄을 위·아래 두 줄로 나눠 그릴까 — 「넓게 보기」에서만 (2026-10-13) */
  splitTabs?: boolean;
  /** 새로고침 버튼을 누르면 올린다 — 패널들이 통째로 다시 마운트된다 */
  reloadKey?: number;
}) {
  const [ownTab, setOwnTab] = useState<StockTab>("chart");
  const tab = (tabFromParent as StockTab | undefined) ?? ownTab;
  const setTab = (k: StockTab) => {
    if (onTabChange) onTabChange(k);
    else setOwnTab(k);
  };
  const [editTabs, setEditTabs] = useState(false);
  /*
   * **차트만 — 화면 높이를 따라간다** (2026-10-13 — 벤티지: "차트만 메뉴 들어가니까
   * 위에가 폭이 너무 없어서 좀 답답해 보인다").
   *
   * 520px 로 못 박혀 있었다. 폰에서 고른 값이라 태블릿·PC 에서는 머리줄·탭 줄·차트
   * 손잡이를 빼고도 한참 남는데 차트는 그대로였다 — **차트만 보려고 들어온 탭에서
   * 차트가 화면의 절반**이었던 셈이다.
   *
   * 위쪽 붙박이(머리줄 2줄 + 탭 줄 + 기간 단추 + 이동평균·매물대 머리)가 380px 쯤이라
   * 그만큼 빼고 남는 높이를 쓴다. 420 아래로는 안 줄인다(봉이 뭉개진다). 900 위로는
   * 안 늘린다 — 세로로만 길어진 차트는 오히려 읽기 나쁘고, 매물대 칸이 화면 밖으로
   * 밀려난다.
   */
  const [chartOnlyH, setChartOnlyH] = useState(() =>
    typeof window === "undefined" ? 520 : Math.max(420, Math.min(900, window.innerHeight - 380)),
  );
  useEffect(() => {
    const calc = () => setChartOnlyH(Math.max(420, Math.min(900, window.innerHeight - 380)));
    window.addEventListener("resize", calc);
    return () => window.removeEventListener("resize", calc);
  }, []);
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
  /*
   * **스와이프는 지금 서 있는 줄 안에서만 움직인다** (2026-10-13 — 벤티지: "상단에
   * 메뉴가 있을 때는 좌우로 스크롤하면 상단 메뉴에서 움직여야 되고, 하단에 포커스가
   * 되어 있을 때는 하단에서 움직여야 돼. 근데 지금은 상단 오른쪽 끝에서 하단으로
   * 움직이고 막 그런 경우가 있거든").
   *
   * 탭 줄을 위·아래로 갈라 놓고도 스와이프는 **열여덟 개를 한 줄로 이어 붙인 목록**을
   * 그대로 쓰고 있었다. 그래서 위 줄의 마지막 탭에서 한 번 더 밀면 아래 줄의 첫 탭으로
   * 건너뛰었다 — 눈에는 두 줄인데 손에는 한 줄이었던 셈이고, 그러면 **어느 줄에 서
   * 있는지 감각이 끊긴다.** 밀어서 간 곳이 밑줄을 달고 있는데 조금 전까지 보던 줄이
   * 아니면, 다음에 어디로 밀어야 할지 알 수가 없다.
   *
   * 지금 탭이 든 **쪽의 목록만** 준다. 그 줄의 끝에서는 벽이다(`useSwipeTabs` 가 감지
   * 않는다). 반대쪽으로 가려면 그 줄을 눈으로 보고 누르면 된다 — 두 줄로 나눈 까닭이
   * 애초에 「밀지 않아도 보이게」였다.
   *
   * ⚠️ 쪽 나누기는 `visibleTabs` 차례(DOM)로 하고, 그 안의 **움직이는 차례는 눈에 보이는
   * 차례**(`orderOf`)다. 둘을 섞으면 벤티지가 순서를 고친 뒤 엉뚱한 탭으로 넘어간다.
   */
  const orderedKeys = visualOrder(visibleTabs.map((t) => t.key), tabOrder.orderOf);
  const topKeys = new Set(
    visibleTabs.slice(0, Math.ceil(visibleTabs.length / 2)).map((t) => t.key as string),
  );
  const swipe = useSwipeTabs({
    order: splitTabs
      ? orderedKeys.filter((k) => topKeys.has(k) === topKeys.has(tab))
      : orderedKeys,
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

  /*
   * **탭 단추 한 개를 만드는 법** — 한 군데로 모은다 (2026-10-13).
   * 넓게 보기에서 탭 줄을 위·아래로 나눠 그리는데, 단추 markup 을 두 벌 적으면
   * 끌어 옮기기·순서 고치기가 한쪽만 고쳐지는 날이 온다.
   */
  const tabBtn = (t: { key: StockTab; label: string }) => (
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
  );


  return (
    /* Fragment 였다 — 스와이프 핸들러를 얹으려면 실제 요소가 필요하다 */
    <div {...swipe} className={`stock-tabs ${swipe.className ?? ""}`}>
      {/*
        **탭 줄을 위·아래로 나눈다** (2026-10-13 — 벤티지: "메뉴 위치도 반반 나눠서
        위아래로 한다는 거 아니었어? 지금은 아래만 있잖아").

        증권플러스도 위 탭 줄과 아래 바가 둘 다 있다. 열넷을 한 줄에 밀어 넣으면 뒤쪽
        절반은 밀어야 나오는데, 밀어야 나오는 것은 **없는 것과 비슷하다.**
        앞 절반은 위에, 뒤 절반은 아래에 둔다. 아래 것은 엄지에 닿고 위 것은 눈에 먼저
        든다 — 어느 쪽도 밀지 않아도 보인다.
        나누지 않을 때(예전 모양)는 위 줄에 전부 담아 그대로다.
      */}
      {splitTabs && (
        <TabScroller className="detail-tabs dt-top" activeKey={tab}>
          {visibleTabs.slice(0, Math.ceil(visibleTabs.length / 2)).map(tabBtn)}
        </TabScroller>
      )}
      <TabScroller className="detail-tabs" activeKey={tab}>
        {(splitTabs ? visibleTabs.slice(Math.ceil(visibleTabs.length / 2)) : visibleTabs).map(tabBtn)}
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
          <b>길게 눌러 끌거나</b> 이름 옆 <b>◀ ▶</b> 로 옮깁니다. 서버에 저장되어 <b>다른 기기에서도 같은 순서</b>
          입니다 — 종목 상세와 개별종목분석이 같은 순서를 씁니다.
          {tabOrder.customized && (
            <button className="filter-btn dt-reset" onClick={tabOrder.reset}>
              원래대로
            </button>
          )}
        </div>
      )}

      {/*
        **이 칸이 넓게 보기에서 홀로 구른다** (2026-10-13 — 벤티지: "상하단 메뉴바를
        고정시켜 놔야 되지 않을까? 차트 들어가니까 차트의 그 크기대로 하단바가 올라와
        버리니까 보기가 안 좋네").

        여태 구르는 것은 시트 전체였고 탭 줄 둘은 `position: sticky` 로 **버티는 시늉**만
        했다. 그래서 본문이 짧은 탭(차트만)에서는 버틸 일이 없어 아래 줄이 본문 끝에
        따라 올라왔다. 이름표를 달아 CSS 가 이 칸만 구르게 할 수 있도록 한다 —
        그러면 위아래 줄은 흉내가 아니라 **진짜로** 제자리에 박힌다.
      */}
      <div className="st-panel" key={`${code}-${tab}-${reloadKey}`}>
        {/* 종합 — 「오늘 이 종목이 어땠나」를 위에서 아래로 훑는다 */}
        {tab === "chart" && (
          <>
            {summaryTop}
            <SignalPanel code={code} onSelectStock={onSelectStock} collapsible />
            <QuoteSummary code={code} />
            {/*
              당일 흐름 그래프는 **위로 올라갔다** (2026-09-09 — 벤티지 "종합에 당일흐름
              부분은 이미 윗부분에 있으니 종합에서는 빼는게 나을듯").

              시트·개별종목분석·종목발굴 셋 다 이제 탭 위에 그린다. 여기 두면 한 화면에
              같은 그림이 두 번 나온다.
            */}
            <ChartPanel code={code} name={name} />
            <h3 className="section-heading">투자자 수급</h3>
            <InvestorTrendTable rows={investorRows} onNeedDays={setInvestorDays} />
            <h3 className="section-heading">프로그램 수급</h3>
            <ProgramFlowBars code={code} />
            {/* 거래량 흐름 — 프로그램 수급 다음, 외국인 지분율 앞 (2026-09-09 벤티지 요청) */}
            <VolumeFlowChart code={code} />
            <SupplyMiniCharts code={code} />
          </>
        )}
        {tab === "chartOnly" && <ChartPanel code={code} name={name} viewId="detail.chartOnly" height={chartOnlyH} />}
        {tab === "orderbook" && <OrderBookPanel code={code} />}
        {tab === "broker" && <BrokerFlowPanel code={code} />}
        {tab === "program" && <ProgramFlowPanel code={code} />}
        {tab === "investor" && <InvestorTrendTable rows={investorRows} onNeedDays={setInvestorDays} />}
        {tab === "credit" && <CreditPanel code={code} />}
        {tab === "strength" && <StrengthPanel code={code} />}
        {tab === "tradeSize" && <TradeSizePanel code={code} />}
        {tab === "daily" && <DailyDetailPanel code={code} />}
        {tab === "opinion" && (
          <>
            <OpinionPanel code={code} />
            {/* 숫자(한투) 아래에 글(네이버 리포트) — 왜 그 목표주가인지 (2026-09-25) */}
            <ReportsPanel code={code} />
          </>
        )}
        {tab === "supply" && <SupplyDetailPanel code={code} />}
        {tab === "notes" && <StockNotes code={code} name={name} currentPrice={curPrice} />}
        {tab === "sector" && <SectorMoodPanel code={code} onSelectStock={onSelectStock} />}
        {tab === "etfHolders" && <EtfHoldersPanel code={code} name={name} onSelectStock={onSelectStock} />}
        {tab === "feed" && <NewsDisclosurePanel code={code} name={name} />}
        {tab === "finance" && <CompanyPanel code={code} name={name} info={info} returns={returns} />}
        {tab === "etf" && <EtfPanel code={code} onSelectStock={onSelectStock} />}
        {tab === "board" && <StockBoardPanel code={code} />}
        {tab === "raw" && <RawJson data={{ info, investorChart, daily }} />}
      </div>
    </div>
  );
}
