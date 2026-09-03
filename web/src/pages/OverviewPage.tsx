import { useEffect, useMemo, useState } from "react";
import { RotationStrip, ThermoPanel, useMarketLens } from "../components/MarketLensPanel";
import {
  api,
  fmtNum,
  normalizeStockCode,
  type IndexCard,
  type MarketFlow,
  type MarketStatus,
  type GlobalQuote,
  type StockRow,
  type ThemeRow,
  type ViRow,
  type UsMajorResult,
  type RateRow,
  type TopTraderRow,
} from "../api";
import { ConstituentSheet, type ConstituentTarget } from "../components/overview/ConstituentSheet";
import { FlowBars } from "../components/overview/FlowBars";
import { FlowIntradayChart } from "../components/overview/FlowIntradayChart";
import { IndexDetailSheet } from "../components/overview/IndexDetailSheet";
import { FuturesDetailSheet, type FuturesDetailTarget } from "../components/overview/FuturesDetailSheet";
import { YahooChartSheet, type ChartTarget } from "../components/overview/YahooChartSheet";
import { MarketSignalPanel } from "../components/MarketSignalPanel";
import { UsBoardPanel } from "../components/overview/UsBoardPanel";
import { OverviewCard } from "../components/overview/OverviewCard";
import { RankList, SegmentToggle } from "../components/overview/RankList";
import { RefreshBar } from "../components/RefreshBar";
import {
  DomesticIndexGrid,
  UpDownTable,
  useFutFlow,
} from "../components/overview/DomesticIndexGrid";
import { TurnoverPanel } from "../components/overview/TurnoverPanel";
import { useSection } from "../useSection";
import { useCardOrder } from "../useCardOrder";
import { useSwipeTabs } from "../useSwipeTabs";
import { OVERVIEW_CARDS, type OverviewSub } from "../overviewCards";
import { WatchStar } from "../useWatchedCodes";
import { SuperMark } from "../useSuperMarks";

type SubTab = "summary" | "flow" | "rank" | "us";

const SUBTABS: { key: SubTab; label: string }[] = [
  { key: "summary", label: "요약" },
  /*
   * 「수급」 탭은 숨겼다 (2026-08-26 사용자 요청) — 지수 카드의 수급·장중 수급
   * 변화(지수/선물 시트)로 요약 쪽에 내용이 다 들어가서 따로 갈 일이 없어졌다.
   * 카드 구성(OVERVIEW_CARDS.flow)은 남겨 둔다 — 다시 켜는 건 여기 한 줄이다.
   *
   * 「순위」 탭도 같은 이유로 숨겼다 (2026-08-27 사용자 요청) — 등락·거래대금·시가총액·
   * 누적등락 순위는 시세분석이, ETF 는 ETF 메뉴가 더 깊게 보여 준다. 여기서 또 볼 일이
   * 없어졌다. 카드 구성(OVERVIEW_CARDS.rank)과 아래 렌더는 그대로 남겨 둔다 —
   * 되살리려면 이 줄의 주석만 풀면 된다:
   *   { key: "rank", label: "순위" },
   */
  // 미국 전광판 — 미국장이 열려 있는 동안 보는 자리
  { key: "us", label: "미국" },
];

function signCls(v: number): string {
  return v > 0 ? "up" : v < 0 ? "down" : "flat";
}

/**
 * 금리 카드가 쓰는 **미국 실시간 넷** (2026-09-02).
 *
 * 한투 금리 종합판은 미국·일본을 **전일 종가**로 준다(`rateBoard` 머리 주석).
 * 실시간이 필요한 미국 만기는 `usMajor` 가 이미 야후에서 받고 있어 그걸 쓴다 —
 * 조회가 늘지 않는다. 만기가 짧은 쪽부터라 장단기 역전이 왼→오로 읽힌다.
 */
const US_YIELD_KEYS = ["irx", "fvx", "tnx", "tyx"] as const;
/** 야후에 심볼이 없어 한투에서만 오는 것 — 기준금리·일본 10년 (404 실측) */
const HANTOO_ONLY_RATES = ["Y0204", "Y0207"];

/**
 * **오늘 값이 아니면 언제 값인지 적는다.**
 *
 * 날짜를 안 적으면 「+0.020%p」가 지금 움직임으로 읽힌다 — 벤티지가 걸린 자리가
 * 정확히 그것이었다. 오늘이면 배지를 안 단다(늘 붙어 있으면 아무도 안 본다).
 */
function pastBadge(asOf: string | null): string | null {
  if (!asOf || asOf.length < 10) return null;
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  if (asOf >= today) return null;
  return `${asOf.slice(5).replace("-", "/")} 종가`;
}

function fmtPct(v: number): string {
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function fmtSigned(v: number): string {
  return `${v > 0 ? "▲ " : v < 0 ? "▼ " : ""}${fmtNum(Math.abs(v))}`;
}

export function OverviewPage({ onSelectStock }: { onSelectStock: (code: string, name: string) => void }) {
  const [sub, setSub] = useState<SubTab>("summary");
  const [status, setStatus] = useState<MarketStatus | null>(null);
  const [now, setNow] = useState(new Date());

  /*
   * 갱신 주기.
   *
   * **여기 적힌 숫자는 외부 API 호출 주기가 아니다.** 화면은 우리 서버의 캐시만 두들기고,
   * 키움·야후·한투를 실제로 부르는 주기는 서버의 `SECTION_TTL_MS` 가 정한다.
   * 그래서 이 값을 줄이는 건 **거의 공짜**다 — 서버가 새로 받아 둔 값을 더 빨리 집어 올 뿐이다.
   *
   * 서버 TTL 의 **절반쯤**으로 둔다. 그래야 서버가 값을 갈아끼운 직후에 화면이 집어 온다.
   * 두 배 이상 느리게 두면 새 값이 있는데도 한참 옛 값을 보고 있게 된다.
   */
  const indices = useSection<IndexCard[]>("indices", 5_000);
  const flow = useSection<MarketFlow>("flow", 20_000);
  /* 선물 투자자별 수급 — 지수 타일 공용 훅(DomesticIndexGrid)으로 이사했다 */
  const futFlow = useFutFlow();
  const movers = useSection<{ rising: StockRow[]; falling: StockRow[] }>("movers", 20_000);
  const themes = useSection<{ top: ThemeRow[]; bottom: ThemeRow[] }>("themes", 60_000);
  const highLow = useSection<{ high: StockRow[]; low: StockRow[] }>("highLow", 120_000);
  const vi = useSection<ViRow[]>("vi", 20_000);
  const global = useSection<GlobalQuote[]>("global", 15_000);
  const usMajor = useSection<UsMajorResult>("usMajor", 15_000);
  const rates = useSection<RateRow[]>("rates", 30_000);
  const topTraders = useSection<TopTraderRow[]>("topTraders", 120_000);
  /* 시장 렌즈 — 체온계·테마 흐름 두 카드가 나눠 본다 (한 번만 받는다) */
  const { lens, reload: reloadLens } = useMarketLens();

  const [flowMarket, setFlowMarket] = useState<"kospi" | "kosdaq">("kospi");
  const [moverDir, setMoverDir] = useState<"rising" | "falling">("rising");
  const [themeDir, setThemeDir] = useState<"top" | "bottom">("top");
  const [hlDir, setHlDir] = useState<"high" | "low">("high");
  const [constituent, setConstituent] = useState<ConstituentTarget | null>(null);
  /** 눌러서 연 지수 상세 (001 코스피 / 101 코스닥) */
  const [indexDetail, setIndexDetail] = useState<string | null>(null);
  /** 선물 타일 → 코스피/코스닥과 같은 골격의 선물 상세 시트 */
  const [futDetail, setFutDetail] = useState<FuturesDetailTarget | null>(null);
  /* 글로벌·미장·미국 금리 줄을 누르면 — 추이 차트. 숫자 한 줄로는 「어디쯤인가」를 모른다 */
  const [chart, setChart] = useState<ChartTarget | null>(null);

  /** 모든 섹션을 한 번에 다시 불러온다 */
  function refreshAll() {
    indices.refresh();
    flow.refresh();
    movers.refresh();
    themes.refresh();
    highLow.refresh();
    vi.refresh();
    global.refresh();
    reloadLens();
  }

  useEffect(() => {
    api.marketStatus().then(setStatus).catch(() => {});
    const timer = setInterval(() => {
      setNow(new Date());
      api.marketStatus().then(setStatus).catch(() => {});
    }, 30_000);
    return () => clearInterval(timer);
  }, []);

  // 데스크톱(700px~)에서는 서브탭 없이 전 섹션을 보여준다
  /*
   * 카드 배치.
   *
   * 목록은 `overviewCards.ts` 하나뿐이다 — 설정 화면도 같은 것을 본다.
   * 순서를 바꾸는 손잡이는 **설정 > 화면 > 시황 카드 순서**에 있다.
   * 배치는 한 번 정하면 끝나는 값이라, 매일 보는 화면의 맨 윗줄을 차지할 이유가 없다.
   */
  const keysHere =
    sub === "us" ? [] : (OVERVIEW_CARDS[sub as OverviewSub] ?? []).map((c) => c.key);
  const cards = useCardOrder(`overview.${sub}`, keysHere);

  const [wide, setWide] = useState(() => window.matchMedia("(min-width:700px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(min-width:700px)");
    const handler = (e: MediaQueryListEvent) => setWide(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  /*
   * 어떤 카드를 보일지.
   * 넓은 화면에서는 국내 카드가 한꺼번에 뜬다. 다만 **미국 전광판을 보고 있을 때는
   * 국내 카드를 전부 내린다** — 섞어 두면 「미국장 도는 동안 보는 자리」라는 뜻이 사라진다.
   */
  /*
   * 어떤 카드를 보일지.
   *
   * **넓은 화면에서도 탭을 따른다.** 예전엔 `wide` 면 요약·수급·순위를 한꺼번에 띄웠는데,
   * PC 에서 카드 열넷이 한 화면에 쏟아져 무엇을 보러 왔는지 잃는다 —
   * 폰에서는 셋으로 나뉘어 있던 것이 PC 에서만 뒤죽박죽이었다.
   * 폰과 PC 가 같은 구조여야 오갈 때 헤매지 않는다.
   */
  const show = (sec: SubTab) => sub === sec;

  /* 폰 — 본문 좌우 스와이프로 국내↔미국 (2026-08-28) */
  const swipe = useSwipeTabs({
    order: SUBTABS.map((t) => t.key),
    current: sub,
    onChange: (k) => setSub(k as SubTab),
  });

  const idx = indices.data ?? [];
  const kospiCard = idx.find((i) => i.code === "001");
  const kosdaqCard = idx.find((i) => i.code === "101");

  function stockRow(r: StockRow, i: number) {
    const code = normalizeStockCode(r.code);
    return (
      <button key={`${r.code}-${i}`} className="ov-li" onClick={() => onSelectStock(code, r.name)}>
        <span className="ov-rank num">{i + 1}</span>
        <span className="ov-nm">
          <WatchStar code={code} />
<SuperMark code={code} />
          {r.name}
        </span>
        <span className={`ov-px num ${signCls(r.changeRate)}`}>{fmtNum(r.price)}</span>
        <span className={`ov-pct num ${signCls(r.changeRate)}`}>{fmtPct(r.changeRate)}</span>
      </button>
    );
  }

  return (
    /* ⚠️ 스프레드가 className 을 덮으므로 합쳐서 넘긴다 — "ov" 를 잃으면 화면이 통째로 깨진다 */
    <div {...swipe} className={`ov ${swipe.className}`}>
      <RefreshBar onRefresh={refreshAll} loading={indices.loading}>
        <span className="ov-statusbar" style={{ padding: 0 }}>
          <span className={`ov-dot ${status?.state ?? ""}`} />
          <span>
            {status?.label ?? "-"} · {now.toLocaleTimeString("ko-KR", { hour12: false })}
          </span>
        </span>
      </RefreshBar>

      {/*
        탭 바.
        좁은 화면에서는 넷을 다 보여 카드를 나눠 본다.
        **넓은 화면에서는 국내/미국 둘뿐이다** — 거기서는 국내 카드가 어차피 한꺼번에
        뜨므로 요약·수급·순위를 나누는 게 뜻이 없고, 미국 전광판만 갈아 끼우면 된다.
        예전엔 넓은 화면에서 탭 바를 통째로 숨겼는데, 그러면 미국으로 갈 방법이 없다.
      */}
      <div className="ov-subtabs">
        {SUBTABS.map((t) => (
          <button
            key={t.key}
            className={`ov-subtab${sub === t.key ? " on" : ""}`}
            onClick={() => setSub(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="ov-grid">
        {/* ---------------- 요약 ---------------- */}
        {/*
          미국 전광판. 다른 탭과 달리 **넓은 화면에서도 따로 둔다**(`show` 를 안 쓴다) —
          국내 카드 사이에 섞으면 「미국장 도는 동안 보는 자리」라는 뜻이 사라진다.
        */}
        {sub === "us" && <UsBoardPanel />}

        {/*
          국내 시장 신호등도 맨 위다. 미국 전광판과 같은 자리에 같은 모양으로 둔다 —
          두 판을 오가며 볼 때 눈이 같은 곳을 찾게 해야 한다.
          좁은 화면에서는 요약 탭에만 띄운다(수급·순위 탭에서는 자리만 먹는다).
        */}
        {sub === "summary" && (
          <div className="ov-span-all">
            {/* 시황 대시보드에서는 접을 수 있고 기본이 접음 (2026-09-03 — "화면차지가 너무 큰데") */}
            <MarketSignalPanel collapsible />
          </div>
        )}

        {show("summary") && (
          <OverviewCard title="국내 지수" order={cards.orderOf("indices")} updatedAt={indices.updatedAt} loading={indices.loading} error={indices.error}>
            {/* 본문은 보드 지수판과 공용 (DomesticIndexGrid) — 두 번 그리면 갈라진다 */}
            <DomesticIndexGrid
              idx={idx}
              flow={flow.data}
              futFlow={futFlow}
              onOpenIndex={setIndexDetail}
              onOpenFutures={setFutDetail}
            />
          </OverviewCard>
        )}

        {show("summary") && (
          <OverviewCard
            order={cards.orderOf("updown")}
            title="종목등락현황"
            updatedAt={indices.updatedAt}
            loading={indices.loading}
            error={indices.error}
          >
            {/* 표 본체도 보드 지수판과 공용 */}
            <UpDownTable cards={[kospiCard, kosdaqCard]} />
          </OverviewCard>
        )}

        {/* 거래대금 현황 — 폭(위 표) 다음 물음이 유동성이다. 줄을 누르면 추이가 펼쳐진다 */}
        {show("summary") && (
          <OverviewCard order={cards.orderOf("turnover")} title="거래대금 현황">
            <TurnoverPanel />
          </OverviewCard>
        )}

        {/*
          글로벌 — **종목등락현황 바로 밑**이다.

          국내 지수 → 종목등락현황으로 "우리 시장이 지금 어떤가"를 본 직후,
          "그 힘이 어디서 왔나"를 이어서 본다. 예전엔 업종 뒤에 있어서 국내를 다 훑고
          한참 내려가야 나왔는데, 그러면 국내와 견주는 일이 안 된다.
        */}
        {show("summary") && (
          <OverviewCard title="글로벌" order={cards.orderOf("global")} updatedAt={global.updatedAt} loading={global.loading} error={global.error}>
            <div className="ov-card-b">
              {/*
                섹터별로 묶는다. 스무 줄을 그냥 나열하면 **어디까지가 원자재이고
                어디부터가 아시아 지수인지** 알 수 없다 — 서버는 이미 group 을 주는데
                화면이 그걸 버리고 있었다.
              */}
              {[...new Set((global.data ?? []).map((g) => g.group))].map((grp) => {
                // 색은 서버가 정한다 — 리포트도 같은 색을 쓴다
                const color = (global.data ?? []).find((g) => g.group === grp)?.color ?? "#8b98a5";
                return (
                <div className="ov-g-sec" key={grp} style={{ ["--g" as string]: color }}>
                  <div className="ov-g-sec-h">{grp}</div>
                  {(global.data ?? [])
                    .filter((g) => g.group === grp)
                    /*
                      줄 전체가 눌린다 — 환율·선물·원자재 전부 야후 심볼이라 같은 차트
                      시트로 추이가 열린다. 숫자 한 줄은 「지금 얼마」만 말하고
                      「어디쯤인가」는 못 말한다.
                    */
                    .map((g) => (
                <button
                  type="button"
                  className="ov-g-row ov-g-click"
                  key={g.key}
                  onClick={() =>
                    setChart({
                      /* 야간선물 줄은 야후가 아니라 한투 CM — 심볼이 월물코드다 */
                      kind: g.key === "krNightFut" ? "futures" : undefined,
                      symbol: g.symbol,
                      label: g.label,
                      digits: g.isRate ? 3 : 2,
                      hintRate: g.changeRate,
                      hintPrice: g.price,
                    })
                  }
                  title="눌러서 차트 보기"
                >
                  {/* 미장 주요지수와 같은 신호등. 판단할 게 없으면 자리만 비워 둔다 */}
                  <span
                    className={`ov-g-sig${g.signal ? ` ${g.signal.level}` : ""}`}
                    title={g.signal?.why}
                  />
                  <span className="ov-g-nm">
                    {g.label}
                    <span className="ov-g-tk">{g.symbol}</span>
                  </span>
                  {g.error ? (
                    <span className="ov-g-pct" style={{ color: "var(--flat)" }}>
                      조회 실패
                    </span>
                  ) : (
                    <>
                      <span className="ov-g-px num">
                        {g.price === null ? "-" : fmtNum(Number(g.price.toFixed(g.isRate ? 3 : 2)))}
                      </span>
                      <span className={`ov-g-pct num ${signCls(g.changeRate ?? 0)}`}>
                        {g.change === null
                          ? "-"
                          : `${g.change > 0 ? "+" : ""}${g.change.toFixed(g.isRate ? 3 : 2)} (${fmtPct(
                              g.changeRate ?? 0,
                            )})`}
                      </span>
                    </>
                  )}
                </button>
                    ))}
                </div>
                );
              })}
            </div>
          </OverviewCard>
        )}

        {/*
          미장 주요지수 — 국내 지수 → 종목등락현황 **다음** 자리다.
          아침에 "밤사이 무슨 일이 있었나"를 한 표로 읽는 곳이라, 국내를 본 직후에 와야 한다.
        */}
        {/*
          미장 주요지수 카드는 숨겼다 (2026-08-25, PDF #6 — 사용자 요청).
          전일 마감값 표라 글로벌의 선물과 겹쳤다. 남길 것은 옮겼다 —
          야간선물은 글로벌 맨 위로, VIX 는 지수선물 묶음 아래로, WTI·브렌트는
          원자재로. 장단기 역전 경고는 맥박(risks)이 서버 쪽에서 계속 본다.
          미국 현물 전광판은 「미국」 서브탭에 그대로 있다.
        */}

        {/*
          금리 — **미국은 야후 실시간, 나머지는 한투** (2026-09-02 고침).

          벤티지: "국채금리 부분 화면에 갱신이 늦는거 같네. 클릭하면 나오는 값이랑 다르다."
          한투 금리 종합판은 **미국·일본 금리를 전일 종가로** 준다(응답의 `stck_bsop_date`
          가 어제 날짜다). 그래서 미국장이 열려 있는 동안 카드는 「+0.020%p」로 멈춰 있는데
          눌러서 뜬 야후 차트는 「-0.25%」였다 — 값도 방향도 달랐다.

          미국 넷(3개월·5년·10년·30년)은 `usMajor` 가 이미 30초마다 야후에서 받고 있다.
          그걸 쓰므로 **조회가 늘지 않는다.** 야후에 심볼이 없는 기준금리·일본 10년만
          한투에서 오고, 그 줄에는 **기준일 배지**를 단다.

          국내(국고채·CD·콜)는 한투 값이 당일이라 그대로다 — 그래도 날짜가 오늘이 아니면
          배지가 붙는다. 규칙은 하나다: **오늘 값이 아니면 언제 값인지 적는다.**
        */}
        {show("summary") && (
          <OverviewCard
            order={cards.orderOf("rates")}
            title="금리"
            updatedAt={usMajor.data?.fetchedAt ?? rates.updatedAt}
            loading={rates.loading}
            error={rates.error}
          >
            <div className="ov-card-b">
              <div className="rt-grid">
                {/* 해외가 먼저다 (2026-08-25, PDF #6) — 요즘 시장을 흔드는 게 미국 금리라서 */}
                <div>
                  <div className="rt-h">해외</div>
                  {/* 미국 — 야후 실시간. 만기가 짧은 쪽부터라 장단기 역전이 왼→오로 읽힌다 */}
                  {US_YIELD_KEYS.map((k) => {
                    const r = (usMajor.data?.rows ?? []).find((x) => x.key === k);
                    if (!r || r.price === null) return null;
                    return (
                      <button
                        type="button"
                        className="rt-row rt-click"
                        key={k}
                        onClick={() =>
                          setChart({
                            symbol: r.symbol,
                            label: r.label,
                            digits: 3,
                            hintPrice: r.price ?? undefined,
                            hintRate: r.changeRate,
                          })
                        }
                        title="눌러서 추이 차트"
                      >
                        <span className="rt-hot">{r.label}</span>
                        <b className="num rt-hot">{r.price.toFixed(3)}%</b>
                        {/* 금리는 변화폭(%p)으로 읽는다 — 등락률로 보면 감이 안 온다 */}
                        <em className={`num ${signCls(r.change ?? 0)}`}>
                          {(r.change ?? 0) > 0 ? "+" : ""}
                          {(r.change ?? 0).toFixed(3)}%p
                        </em>
                      </button>
                    );
                  })}
                  {/* 야후에 없는 것 — 한투, 지난 종가 */}
                  {(rates.data ?? [])
                    .filter((r) => HANTOO_ONLY_RATES.includes(r.code))
                    .map((r) => (
                      <div className="rt-row" key={r.code}>
                        <span>
                          {r.name}
                          {pastBadge(r.asOf) && <u className="rt-as">{pastBadge(r.asOf)}</u>}
                        </span>
                        <b className="num">{r.rate?.toFixed(3)}%</b>
                        <em className={`num ${signCls(r.change ?? 0)}`}>
                          {(r.change ?? 0) > 0 ? "+" : ""}
                          {(r.change ?? 0).toFixed(3)}%p
                        </em>
                      </div>
                    ))}
                </div>
                <div>
                  <div className="rt-h">국내</div>
                  {(rates.data ?? [])
                    .filter((r) => r.group === "국내")
                    .map((r) => (
                      <div className="rt-row" key={r.code}>
                        <span>
                          {r.name}
                          {pastBadge(r.asOf) && <u className="rt-as">{pastBadge(r.asOf)}</u>}
                        </span>
                        <b className="num">{r.rate?.toFixed(3)}%</b>
                        <em className={`num ${signCls(r.change ?? 0)}`}>
                          {(r.change ?? 0) > 0 ? "+" : ""}
                          {(r.change ?? 0).toFixed(3)}%p
                        </em>
                      </div>
                    ))}
                </div>
              </div>
              <div className="table-note">
                <b>%p</b> 는 등락률이 아니라 <b>변화폭</b>입니다 — 4.71% 가 4.72% 로 가는 건
                등락률로는 0.2% 지만 시장이 반응하는 건 0.01%p 라는 폭 자체입니다.
                <b>일본 10년</b>은 엔 캐리와 붙어 있어, 오르면 전 세계 위험자산에서 돈이
                빠집니다. 미국 넷은 야후에서 와 미국장이 열려 있는 동안 움직이지만
                <b> 약 15분 지연</b>입니다. 날짜 배지가 붙은 줄은 그날 <b>종가</b>로
                멈춰 있습니다 — 한국투자증권 금리판은 미국·일본을 전일 마감으로 줍니다.
              </div>
            </div>
          </OverviewCard>
        )}

        {/*
          시장 체온계 (2026-08-28) — 「시장 폭 추이」를 갈아끼웠다.
          하루씩 쌓던 폭 그래프는 서버를 새로 켜면 비었는데, 체온계는 일봉 캐시로
          40일치를 소급해 낸다. 같은 물음(장이 넓게 사는가)에 더 긴 답이다.
          key 는 "breadth" 그대로 — 저장된 배치가 자리를 기억한다.
        */}
        {show("summary") && (
          <OverviewCard title="시장 체온계" order={cards.orderOf("breadth")}>
            <div className="ov-card-b">
              <ThermoPanel lens={lens} />
            </div>
          </OverviewCard>
        )}

        {/*
          여기가 ⑤ 증시주변자금 동향 자리다 — 고객예탁금·미수금·신용잔고·선물예수금.
          키움에도 한투에도 없어서 공공데이터포털 키가 생겨야 붙는다. 그때 여기 끼운다.
        */}

        {/*
          테마 흐름 (2026-08-28) — 「업종」을 갈아끼웠다. 거래소 업종 분류는 이 앱의
          눈금과 안 맞아 신호등 가중치에서도 뺐다 — 대시보드에만 남을 이유가 없다.
          대신 로테이션(주도/부상/휴식)이 「오늘 어느 판이 도는가」에 바로 답한다.
          key 는 "sectors" 그대로 — 저장된 배치가 자리를 기억한다.
        */}
        {show("summary") && (
          <OverviewCard title="테마 흐름" order={cards.orderOf("sectors")}>
            <RotationStrip lens={lens} onSelectStock={onSelectStock} />
            {lens?.rotation.ready && (
              <div className="table-note">
                거래대금 300억↑ 테마 {lens.rotation.universe}개를 오늘 × 한 달 누적으로
                나눕니다 — 판 전체는 <b>시장 흐름 분석 &gt; 테마 로테이션</b>.
              </div>
            )}
          </OverviewCard>
        )}



        {/* ---------------- 수급 ---------------- */}
        {show("flow") && (
          <OverviewCard
            title="투자자별 수급"
            subtitle={`${flowMarket === "kospi" ? "코스피" : "코스닥"} · 억원`}
            loading={flow.loading}
            error={flow.error}
            span2
          >
            <SegmentToggle
              options={[
                { key: "kospi" as const, label: "코스피" },
                { key: "kosdaq" as const, label: "코스닥" },
              ]}
              value={flowMarket}
              onChange={setFlowMarket}
            />
            {flow.data && <FlowBars flow={flow.data[flowMarket]} />}
            {/*
              누적 막대 밑에 장중 변화. 막대만 보면 오전에 팔다 오후에 산 날과
              하루 종일 판 날이 똑같이 생긴다 — 방향이 바뀐 지점이 보여야 한다.
            */}
            <FlowIntradayChart market={flowMarket} />
          </OverviewCard>
        )}

        {/* ---------------- 순위 ---------------- */}
        {/*
          순위 탭의 맨 위. 상위 계좌들이 무엇을 사는지가 다른 순위표보다 먼저 온다 —
          거래대금·등락률 순위는 "무엇이 움직였나"이고 이건 "누가 움직였나"다.
        */}
        {show("rank") && (
          <OverviewCard
            order={cards.orderOf("topTraders")}
            title="수익률 상위 고객 매매동향"
          updatedAt={topTraders.updatedAt}
          loading={topTraders.loading}
          error={topTraders.error}
        >
          <div className="ov-card-b">
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="sticky-col">종목</th>
                    <th>현재가</th>
                    <th>등락률</th>
                    <th title="상위 계좌들의 순매수 금액">순매수</th>
                    <th title="이 종목을 들고 있는 상위 계좌 수 — 한 계좌의 몰빵인지 여럿이 보는지">
                      계좌
                    </th>
                    <th>평균단가</th>
                    <th title="그 계좌들의 이 종목 수익률">수익률</th>
                  </tr>
                </thead>
                <tbody>
                  {(topTraders.data ?? []).slice(0, 20).map((r) => (
                    <tr
                      key={r.code}
                      className="clickable-row"
                      onClick={() => onSelectStock(normalizeStockCode(r.code), r.name)}
                    >
                      <td className="sticky-col">{r.name}</td>
                      <td className="num">{fmtNum(r.price)}</td>
                      <td className={`num ${signCls(r.changeRate)}`}>{fmtPct(r.changeRate)}</td>
                      <td className={`num ${signCls(r.netAmount)}`}>
                        {Math.round(r.netAmount).toLocaleString("ko-KR")}억
                      </td>
                      <td className="num">{r.accounts}</td>
                      <td className="num pt-n">{fmtNum(r.avgBuyPrice)}</td>
                      <td className={`num ${signCls(r.profitRate)}`}>
                        {r.profitRate > 0 ? "+" : ""}
                        {r.profitRate.toFixed(0)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="table-note">
              키움 <b>수익률 상위 고객</b> 계좌들의 매매입니다(상위 20종목). 금액은 억원.
              <b>계좌 수</b>를 같이 보세요 — 한 계좌가 크게 담은 것과 여럿이 함께 담은 것은
              뜻이 다릅니다. <b>참고 자료</b>이지 매매 근거가 아닙니다.
            </div>
          </div>
        </OverviewCard>
      )}

        {show("rank") && (
          <OverviewCard title="등락률 순위" order={cards.orderOf("movers")} updatedAt={movers.updatedAt} loading={movers.loading} error={movers.error}>
            <SegmentToggle
              options={[
                { key: "rising" as const, label: "상승" },
                { key: "falling" as const, label: "하락" },
              ]}
              value={moverDir}
              onChange={setMoverDir}
            />
            <RankList items={movers.data?.[moverDir] ?? []} renderItem={stockRow} />
          </OverviewCard>
        )}

        {show("rank") && (
          <OverviewCard title="테마" order={cards.orderOf("themes")} updatedAt={themes.updatedAt} loading={themes.loading} error={themes.error}>
            <SegmentToggle
              options={[
                { key: "top" as const, label: "상위" },
                { key: "bottom" as const, label: "하위" },
              ]}
              value={themeDir}
              onChange={setThemeDir}
            />
            <RankList
              items={themes.data?.[themeDir] ?? []}
              renderItem={(t: ThemeRow, i) => (
                <button
                  className="ov-li"
                  key={`${t.code}-${i}`}
                  onClick={() => setConstituent({ kind: "theme", code: t.code, name: t.name })}
                >
                  <span className="ov-nm">
                    {t.name}
                    <span className="ov-sub-nm">
                      {t.stockCount}종목 · {t.mainStock}
                    </span>
                  </span>
                  <span className={`ov-pct num ${signCls(t.changeRate)}`}>{fmtPct(t.changeRate)}</span>
                </button>
              )}
            />
          </OverviewCard>
        )}

        {/*
          250일 신고가·VI 는 **순위**다. 시황이 아니다 —
          시황은 시장이 어디로 가는지를 보는 자리이고, 이 둘은 종목을 고르는 자리다.
          요약 탭에 섞여 있으니 지수·수급·금리를 훑는 흐름이 끊겼다. 순위 맨 아래로 옮긴다.
        */}
        {show("rank") && (
          <OverviewCard
            order={cards.orderOf("highLow")}
            title="250일 신고가 / 신저가"
            updatedAt={highLow.updatedAt}
            loading={highLow.loading}
            error={highLow.error}
          >
            <SegmentToggle
              options={[
                { key: "high" as const, label: "신고가" },
                { key: "low" as const, label: "신저가" },
              ]}
              value={hlDir}
              onChange={setHlDir}
            />
            <RankList items={highLow.data?.[hlDir] ?? []} renderItem={stockRow} />
          </OverviewCard>
        )}

        {show("rank") && (
          <OverviewCard title="변동성 완화 (VI)" order={cards.orderOf("vi")} updatedAt={vi.updatedAt} loading={vi.loading} error={vi.error}>
            <RankList
              items={vi.data ?? []}
              emptyText="발동 종목 없음"
              renderItem={(v: ViRow, i) => (
                <button
                  key={`${v.code}-${i}`}
                  className="ov-li"
                  onClick={() => onSelectStock(normalizeStockCode(v.code), v.name)}
                >
                  <span className="ov-nm">
                    <WatchStar code={normalizeStockCode(v.code)} />
<SuperMark code={normalizeStockCode(v.code)} />
                    {v.name}
                    <span className="ov-sub-nm">{v.motionCount}회 발동</span>
                  </span>
                  <span className="ov-px num">{fmtNum(v.motionPrice)}</span>
                  <span className={`ov-pct num ${signCls(v.openChangeRate)}`}>{fmtPct(v.openChangeRate)}</span>
                </button>
              )}
            />
          </OverviewCard>
        )}



      </div>

      {/*
        수익률 상위 고객 매매동향 — **맨 아래**다.

        키움에서 실제로 잘 벌고 있는 계좌들이 무엇을 사는지 보여 준다. 외국인·기관은
        규모가 커서 방향이 굼뜨고 개인 수급은 방향이 없는데, 이건 그 사이다 —
        개인이되 **결과로 걸러진** 개인이다.

        맨 아래인 이유는 **참고 자료**이기 때문이다. 이걸 보고 따라 사는 건 이 프로젝트가
        하려는 일이 아니라, 앞의 지표들을 다 보고 난 뒤 곁눈질하는 자리에 둔다.
      */}

      {/* 시장 폭 도움말은 카드와 함께 뺐다 (2026-08-28) — 체온계가 제 설명을 달고 있다 */}

      {indexDetail && (
        <IndexDetailSheet code={indexDetail} onClose={() => setIndexDetail(null)} />
      )}

      {futDetail && <FuturesDetailSheet target={futDetail} onClose={() => setFutDetail(null)} />}

      {/* 글로벌·미장·미국 금리 줄에서 연 추이 차트 */}
      {chart && <YahooChartSheet target={chart} onClose={() => setChart(null)} />}

      {constituent && (
        <ConstituentSheet
          target={constituent}
          onClose={() => setConstituent(null)}
          onSelectStock={(code, name) => {
            setConstituent(null);
            onSelectStock(code, name);
          }}
        />
      )}
    </div>
  );
}
