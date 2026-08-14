import { useEffect, useState } from "react";
import { api, pick, pickList, type RawRecord } from "../api";
import { ChartPanel } from "./ChartPanel";
import { IntradayFlow } from "./IntradayPanels";
import { CompanySnapshot, type PeriodReturns } from "./CompanySnapshot";
import { FinancePanel } from "./FinancePanel";
import { InvestorTrendTable } from "./InvestorTrendTable";
import { NewsDisclosurePanel } from "./NewsDisclosurePanel";
import { PriceHeader } from "./PriceHeader";
import { SectorMoodPanel } from "./SectorMoodPanel";
import { SignalPanel } from "./SignalLight";
import { StockNotes } from "./StockNotes";
import { SupplyDetailPanel } from "./SupplyDetailPanel";
import { RawJson } from "./RawJson";
import { useWatchedCodes } from "../useWatchedCodes";

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
type DetailTab = "summary" | "notes" | "sector" | "finance" | "chart" | "investor" | "supply" | "feed" | "raw";

/**
 * 탭 순서는 "실제 매매에 바로 쓰는 것"이 앞이다.
 * 차트 → 수급 → 공매도/대차 → 업종·테마 순으로 보고, 기업분석·재무는 뒤에서 확인.
 */
const DETAIL_TABS: { key: DetailTab; label: string }[] = [
  { key: "chart", label: "종합" },
  { key: "investor", label: "투자자 수급" },
  { key: "supply", label: "외국인·공매도·대차" },
  { key: "notes", label: "메모" },
  { key: "sector", label: "업종·테마" },
  { key: "feed", label: "뉴스·공시" },
  { key: "finance", label: "재무" },
  { key: "summary", label: "기업분석" },
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
  const [info, setInfo] = useState<RawRecord | null>(null);
  const [investorChart, setInvestorChart] = useState<RawRecord | null>(null);
  const [dailyForReturns, setDailyForReturns] = useState<RawRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [watchBusy, setWatchBusy] = useState(false);
  const [detailTab, setDetailTab] = useState<DetailTab>("chart");
  const watchedCodes = useWatchedCodes();
  const watched = watchedCodes.isWatched(code);

  // 종목기본정보 + 투자자매매동향 + (기간수익률 계산용) 일봉: 종목이 바뀔 때만 다시 조회
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([api.stockInfo(code), api.investorChart(code), api.dailyChart(code)])
      .then(([infoRes, investorRes, dailyRes]) => {
        if (cancelled) return;
        setInfo(infoRes as RawRecord);
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

  async function toggleWatch() {
    if (watchBusy) return;
    setWatchBusy(true);
    try {
      if (watched) {
        await api.watchlistRemove(code);
        watchedCodes.markRemoved(code);
      } else {
        // 등록 시점의 현재가를 편입가로 기록
        const price = Math.abs(Number(pick(info ?? undefined, CUR_PRICE_KEYS))) || 0;
        await api.watchlistAdd({ code, name, addedPrice: price });
        watchedCodes.markAdded(code);
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
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-header">
          <h2>
            {name} ({code})
          </h2>
          <button
            className={`watch-btn${watched ? " on" : ""}`}
            onClick={toggleWatch}
            disabled={watchBusy}
            title={watched ? "관심종목에서 제거" : "관심종목에 추가"}
          >
            {watched ? "★" : "☆"}
          </button>
          <button className="close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        {loading && <div className="empty">불러오는 중...</div>}
        {error && <div className="error-banner">{error}</div>}

        {!loading && !error && (
          <>
            <PriceHeader info={info} />

            {onOpenAnalysis && (
              <button className="analysis-link" onClick={() => onOpenAnalysis(code, name)}>
                호가 · 거래원 · 체결강도 보기 (개별종목분석) →
              </button>
            )}

            <nav className="detail-tabs">
              {DETAIL_TABS.map((t) => (
                <button
                  key={t.key}
                  className={`detail-tab${detailTab === t.key ? " active" : ""}`}
                  onClick={() => setDetailTab(t.key)}
                >
                  {t.label}
                </button>
              ))}
            </nav>

            {detailTab === "summary" && <CompanySnapshot info={info} returns={returns} />}

            {detailTab === "notes" && (
              <StockNotes
                code={code}
                name={name}
                currentPrice={Math.abs(Number(pick(info ?? undefined, CUR_PRICE_KEYS))) || undefined}
              />
            )}

            {detailTab === "sector" && <SectorMoodPanel code={code} onSelectStock={onSelectStock} />}

            {detailTab === "finance" && <FinancePanel code={code} />}

            {detailTab === "chart" && (
              <>
                <SignalPanel code={code} onSelectStock={onSelectStock} />
                <IntradayFlow code={code} basePrice={Math.abs(Number(info?.base_pric)) || 0} />
                <ChartPanel code={code} name={name} />
              </>
            )}

            {detailTab === "investor" && <InvestorTrendTable rows={investorRows} />}

            {detailTab === "supply" && <SupplyDetailPanel code={code} />}

            {detailTab === "feed" && <NewsDisclosurePanel code={code} name={name} />}

            {detailTab === "raw" && <RawJson data={{ info, investorChart, dailyForReturns }} />}
          </>
        )}
      </div>
    </div>
  );
}
