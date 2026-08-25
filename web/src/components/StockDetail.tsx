import { useEffect, useRef, useState } from "react";
import { api, pick, pickList, type RawRecord } from "../api";
import { ChartPanel } from "./ChartPanel";
import { EtfPanel } from "./EtfPanel";
import { WatchAddSheet, type WatchAddTarget } from "./WatchAddSheet";
import { IntradayFlow } from "./IntradayPanels";
import { CompanyPanel } from "./CompanyPanel";
import { type PeriodReturns } from "./CompanySnapshot";
import { InvestorTrendTable } from "./InvestorTrendTable";
import { NewsDisclosurePanel } from "./NewsDisclosurePanel";
import { IntradayLevelsBar } from "./IntradayLevelsBar";
import { PriceHeader } from "./PriceHeader";
import { StockSummaryPanel } from "./StockSummaryPanel";
import { TabScroller } from "./TabScroller";
import { OpinionPanel } from "./OpinionPanel";
import { useLive } from "../useLive";
import { SectorMoodPanel } from "./SectorMoodPanel";
import { SignalPanel } from "./SignalLight";
import { StockNotes } from "./StockNotes";
import { SupplyDetailPanel } from "./SupplyDetailPanel";
import { RawJson } from "./RawJson";
import { useWatchedCodes } from "../useWatchedCodes";
import { OrderBookPanel } from "./OrderBookPanel";
import { BrokerFlowPanel } from "./BrokerFlowPanel";
import { ProgramFlowPanel } from "./ProgramFlowPanel";
import { useCardOrder } from "../useCardOrder";

const DAILY_LIST_KEYS = ["stk_dt_pole_chart_qry"];
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
  return {
    m1: ret(RETURN_WINDOWS.m1),
    m3: ret(RETURN_WINDOWS.m3),
    m6: ret(RETURN_WINDOWS.m6),
    y1: ret(RETURN_WINDOWS.y1),
  };
}

// ka10001(주식기본정보), ka10081/82/83(일/주/월봉차트), ka10060(투자자기관별차트) 공식 문서 기준 확인된 필드명
const CUR_PRICE_KEYS = ["cur_prc"];
const INVESTOR_LIST_KEYS = ["stk_invsr_orgn_chart"];

/** 종목 상세 상단 가로 탭. 기능이 늘어나면 여기에 항목을 추가한다. */
type DetailTab = "chartOnly" | "finance" | "opinion" | "notes" | "sector" | "chart" | "investor" | "supply" | "feed" | "raw" | "orderbook" | "broker" | "program" | "etf";

/**
 * 탭 순서는 "실제 매매에 바로 쓰는 것"이 앞이다.
 * 차트 → 수급 → 공매도/대차 → 업종·테마 순으로 보고, 기업분석·재무는 뒤에서 확인.
 */
/**
 * 여기 적힌 순서가 **기본**이다. 저장된 순서가 없으면 이대로 나온다.
 * 탭을 새로 만들면 이 배열에도 넣어야 화면에 뜬다.
 */
const DETAIL_TABS: { key: DetailTab; label: string }[] = [
  { key: "chart", label: "종합" },
  /*
    「차트만」 — 종합 탭은 신호등과 장중 수급이 위에 얹혀 차트가 아래로 밀린다.
    차트를 **크게 오래 보고 싶을 때**가 따로 있어서 그 탭을 둔다. 판독 줄은 그대로 나온다.
  */
  { key: "chartOnly", label: "차트만" },
  { key: "orderbook", label: "호가" },
  { key: "broker", label: "거래원" },
  { key: "program", label: "프로그램" },
  { key: "investor", label: "투자자 수급" },
  { key: "opinion", label: "목표주가" },
  { key: "supply", label: "외국인·공매도·대차" },
  { key: "notes", label: "메모" },
  { key: "sector", label: "업종·테마" },
  { key: "feed", label: "뉴스·공시" },
  /*
   * 기업분석 + 재무 → **기업·재무 한 탭** (2026-08-25).
   * 같은 질문(이 회사 벌고 있나)에 탭 두 개를 들락거리게 했었다.
   * 위에서 아래로 「한 줄 진단 → 핵심 칩 → 추정·분기·연간 → 접힌 전체 지표」.
   * 키는 예전 「재무」의 finance 를 그대로 쓴다 — 저장된 탭 순서가 안 깨진다.
   * 없어진 summary(기업분석) 키가 저장분에 남아 있어도 그냥 무시된다.
   */
  { key: "finance", label: "기업·재무" },
  { key: "raw", label: "원본 데이터" },
];

export function StockDetail({
  code,
  name,
  onClose,
  onOpenAnalysis,
  onSelectStock,
}: {
  code: string;
  name: string;
  onClose: () => void;
  /** 호가·거래원 등을 보는 개별종목분석 페이지로 이동 */
  onOpenAnalysis?: (code: string, name: string) => void;
  /** 업종·테마 구성종목에서 다른 종목으로 갈아타기 */
  onSelectStock?: (code: string, name: string) => void;
}) {
  const [investorChart, setInvestorChart] = useState<RawRecord | null>(null);
  const [dailyForReturns, setDailyForReturns] = useState<RawRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  /*
   * 현재가는 장중에 5초마다 조용히 갱신된다.
   * 이 모달은 관심종목·순위 화면에서 바로 열리는 자리라 개별종목분석만큼 자주 쓰이는데,
   * 열어둔 채로 값이 멈춰 있으면 지난 시세를 보고 판단하게 된다.
   */
  /*
   * **1초 갱신.**
   *
   * 키움 제한은 「전체 초당 몇 건」이 아니라 **TR 하나당 초당 5건**이다.
   * 종목 창은 한 번에 하나만 열리고, 이 패널이 부르는 TR 도 하나다 —
   * 1초에 한 번이면 한도의 20% 다. 5초로 잡아 둘 이유가 없었다.
   *
   * 분봉 차트는 그대로 30초다. 3분봉은 3분에 한 번 바뀌는데 1초로 당겨 봐야
   * **같은 값을 서른 번 더 받을 뿐**이다.
   */
  const live = useLive(() => api.stockInfo(code), [code], 1000);
  const info = (live.data ?? null) as RawRecord | null;
  const [watchBusy, setWatchBusy] = useState(false);
  const [addTarget, setAddTarget] = useState<WatchAddTarget | null>(null);
  /*
   * 종목이 바뀌면 **맨 위로 올린다.**
   *
   * 종목발굴에서 화살표로 넘기면 모달은 그대로 두고 내용만 갈린다. 그때 스크롤이
   * 내려가 있던 자리에 남아서, 새 종목이 **중간부터** 보였다.
   */
  const sheetRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    sheetRef.current?.scrollTo({ top: 0 });
  }, [code]);
  const [detailTab, setDetailTab] = useState<DetailTab>("chart");
  const [editTabs, setEditTabs] = useState(false);
  /*
   * ETF 인가 — 맞을 때만 「ETF 구성」 탭이 종합 바로 옆에 나타난다 (2026-08-25).
   * 일반 종목에서 빈 탭을 보여주느니 탭 자체가 없는 게 맞다. 판정은 6시간 캐시라 싸다.
   */
  const [isEtf, setIsEtf] = useState(false);
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
  // ETF 탭을 보다가 일반 종목으로 넘어가면 종합으로 돌아간다 (탭이 사라지므로)
  useEffect(() => {
    if (!isEtf && detailTab === "etf") setDetailTab("chart");
  }, [isEtf, detailTab]);
  /* 카드 배치와 **같은 훅**이다 — 서버에 저장되어 기기가 달라도 같은 순서 */
  const tabOrder = useCardOrder(
    "stockDetail.tabs",
    DETAIL_TABS.map((t) => t.key),
  );
  const watchedCodes = useWatchedCodes();
  const watched = watchedCodes.isWatched(code);

  // 종목기본정보 + 투자자매매동향 + (기간수익률 계산용) 일봉: 종목이 바뀔 때만 다시 조회
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    // 수급·일봉은 일별 데이터라 자주 부를 이유가 없다 (현재가만 폴링한다)
    Promise.all([api.investorChart(code), api.dailyChart(code)])
      .then(([investorRes, dailyRes]) => {
        if (cancelled) return;
        setInvestorChart(investorRes as RawRecord);
        setDailyForReturns(dailyRes as RawRecord);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  /**
   * 별을 누르면 **그룹 고르는 창**을 연다.
   *
   * 예전엔 이미 담긴 종목이면 곧바로 지웠다. 한 종목이 여러 그룹에 담기게 된 뒤로는
   * 그게 틀렸다 — **다른 그룹에 하나 더 담으려고 눌렀는데 있던 것까지 사라졌다.**
   * 이제 담겼든 아니든 창을 연다. 창이 지금 속한 그룹을 켠 채로 열리므로
   * 더할지 뺄지를 거기서 정한다(전부 끄고 저장하면 빠진다).
   *
   * 그룹이 하나도 없을 때만 묻지 않고 바로 담는다 — 빈 창은 방해다.
   */
  async function toggleWatch() {
    if (watchBusy) return;
    setWatchBusy(true);
    try {
      // 등록 시점의 현재가를 편입가로 기록
      const price = Math.abs(Number(pick(info ?? undefined, CUR_PRICE_KEYS))) || 0;
      const { groups } = await api.watchGroups().catch(() => ({ groups: [] as string[] }));
      if (groups.length === 0 && !watched) {
        await api.watchlistAdd({ code, name, addedPrice: price });
        watchedCodes.markAdded(code);
      } else {
        setAddTarget({ code, name, addedPrice: price });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "관심종목 처리 실패");
    } finally {
      setWatchBusy(false);
    }
  }

  const investorRows = pickList(investorChart ?? undefined, INVESTOR_LIST_KEYS); // 최신순 원본 그대로 (테이블 표시용)

  const dailyCloses = pickList(dailyForReturns ?? undefined, DAILY_LIST_KEYS)
    .map((c) => Number(c.cur_prc))
    .filter((n) => Number.isFinite(n)); // 최신순(0번째=오늘) 그대로 사용
  const returns = dailyCloses.length > 0 ? computeReturns(dailyCloses) : null;

  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet" ref={sheetRef} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-header">
          <h2>
            {/* 코스피/코스닥 — 같은 +5% 라도 판이 다르다. 서버가 전종목 캐시에서 붙여 준다 */}
            {info && String(info._market ?? "") && (
              <span className={`mkt-badge ${String(info._market).includes("코스닥") ? "kq" : "ks"}`}>
                {String(info._market).includes("코스닥") ? "코스닥" : "코스피"}
              </span>
            )}
            {name} ({code})
          </h2>
          {/*
            헤더에 현재가 상시 (아이디어노트 4 — 「스크롤 밑에 내리니깐 실시간 시세
            확인이 안 되네」). 값은 **새로 받는 게 아니다** — 아래 `useLive`(1초)가 이미
            들고 있는 `info` 를 sticky 헤더에도 그릴 뿐이다. 스크롤이 어디에 있든
            지금 값이 눈 앞에 있다.
          */}
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
          <button
            className={`watch-btn${watched ? " on" : ""}`}
            onClick={toggleWatch}
            disabled={watchBusy}
            title={watched ? "그룹 고치기 (담긴 그룹 확인·추가·제거)" : "관심종목에 추가"}
          >
            {watched ? "★" : "☆"}
          </button>
          <button
            className="watch-btn"
            onClick={() => live.refresh()}
            title={
              live.updatedAt
                ? `${new Date(live.updatedAt).toLocaleTimeString("ko-KR", { hour12: false })} 기준 · 장중에는 5초마다 자동 갱신됩니다`
                : "지금 시세를 다시 받아옵니다"
            }
          >
            ↻
          </button>
          <button className="close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        {loading && <div className="empty">불러오는 중...</div>}
        {error && <div className="error-banner">{error}</div>}

        {!loading && !error && (
          <>
            <PriceHeader info={info} code={code} />
            <IntradayLevelsBar code={code} />
            {/* 개별종목분석과 **같은 표** — 같은 값을 두 번 그리면 언젠가 갈린다 */}
            <StockSummaryPanel code={code} />

            {onOpenAnalysis && (
              <button className="analysis-link" onClick={() => onOpenAnalysis(code, name)}>
                호가 · 거래원 · 체결강도 보기 (개별종목분석) →
              </button>
            )}

            {/*
              탭 순서를 바꾼다.
              탭이 열 개를 넘으면서 자주 보는 게 뒤로 밀렸다. 카드 배치와 **같은 훅**을 쓴다 —
              서버에 저장되어 기기가 달라도 같은 순서다.
              JSX 를 재배열하지 않고 CSS `order` 만 준다.
            */}
            <TabScroller className="detail-tabs" activeKey={detailTab}>
              {DETAIL_TABS.map((t) => (
                <button
                  key={t.key}
                  className={`detail-tab${detailTab === t.key ? " active" : ""}${tabOrder.drag.cls(t.key)}`}
                  style={{ order: tabOrder.orderOf(t.key) }}
                  onClick={() => setDetailTab(t.key)}
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
                ETF 구성 — ETF 일 때만 나타나는 탭. order 를 종합과 같게 주면
                flex 정렬의 동점 규칙(DOM 순서)으로 **종합 바로 옆**에 선다.
                저장되는 탭 순서에는 안 끼운다 — 종목 따라 있다 없다 하는 탭이
                순서 배열에 섞이면 저장분이 지저분해진다.
              */}
              {isEtf && (
                <button
                  className={`detail-tab${detailTab === "etf" ? " active" : ""}`}
                  style={{ order: tabOrder.orderOf("chart") }}
                  onClick={() => setDetailTab("etf")}
                >
                  ETF 구성
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
                탭 이름 옆 <b>◀ ▶</b> 로 옮깁니다. 서버에 저장되어 <b>다른 기기에서도 같은
                순서</b>입니다.
                {tabOrder.customized && (
                  <button className="filter-btn dt-reset" onClick={tabOrder.reset}>
                    원래대로
                  </button>
                )}
              </div>
            )}

            {detailTab === "orderbook" && <OrderBookPanel code={code} />}
            {detailTab === "broker" && <BrokerFlowPanel code={code} />}
            {detailTab === "program" && <ProgramFlowPanel code={code} />}

            {detailTab === "finance" && <CompanyPanel code={code} info={info} returns={returns} />}

            {detailTab === "opinion" && <OpinionPanel code={code} />}

            {detailTab === "notes" && (
              <StockNotes
                code={code}
                name={name}
                currentPrice={Math.abs(Number(pick(info ?? undefined, CUR_PRICE_KEYS))) || undefined}
              />
            )}

            {detailTab === "sector" && <SectorMoodPanel code={code} onSelectStock={onSelectStock} />}


            {detailTab === "chartOnly" && (
              <ChartPanel code={code} name={name} viewId="detail.chartOnly" height={520} />
            )}
            {detailTab === "chart" && (
              <>
                <SignalPanel code={code} onSelectStock={onSelectStock} />
                <IntradayFlow code={code} basePrice={Math.abs(Number(info?.base_pric)) || 0} />
                <ChartPanel code={code} name={name} />
              </>
            )}

            {/* ETF 구성 — 종합에 끼워 넣지 않고 제 탭을 갖는다 (사용자 요청) */}
            {detailTab === "etf" && <EtfPanel code={code} onSelectStock={onSelectStock} />}

            {detailTab === "investor" && <InvestorTrendTable rows={investorRows} />}

            {detailTab === "supply" && <SupplyDetailPanel code={code} />}

            {detailTab === "feed" && <NewsDisclosurePanel code={code} name={name} />}

            {detailTab === "raw" && <RawJson data={{ info, investorChart, dailyForReturns }} />}
          </>
        )}
      </div>

      {/* 그룹을 고르고 담는다. 담기 전엔 별이 안 켜진다 */}
      {addTarget && (
        <WatchAddSheet target={addTarget} onClose={() => setAddTarget(null)} />
      )}
    </div>
  );
}
