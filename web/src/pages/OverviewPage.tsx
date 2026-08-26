import { useEffect, useMemo, useState } from "react";
import { BreadthHelp, BreadthPanel } from "../components/BreadthPanel";
import {
  api,
  fmtNum,
  normalizeStockCode,
  type IndexCard,
  type MarketFlow,
  type MarketStatus,
  type GlobalQuote,
  type SectorRow,
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
import { Sparkline } from "../components/overview/Sparkline";
import { TurnoverPanel } from "../components/overview/TurnoverPanel";
import { useSection } from "../useSection";
import { useCardOrder } from "../useCardOrder";
import { OVERVIEW_CARDS, type OverviewSub } from "../overviewCards";
import { WatchStar } from "../useWatchedCodes";

type SubTab = "summary" | "flow" | "rank" | "us";

const SUBTABS: { key: SubTab; label: string }[] = [
  { key: "summary", label: "요약" },
  /*
   * 「수급」 탭은 숨겼다 (2026-08-26 사용자 요청) — 지수 카드의 수급·장중 수급
   * 변화(지수/선물 시트)로 요약 쪽에 내용이 다 들어가서 따로 갈 일이 없어졌다.
   * 카드 구성(OVERVIEW_CARDS.flow)은 남겨 둔다 — 다시 켜는 건 여기 한 줄이다.
   */
  { key: "rank", label: "순위" },
  // 미국 전광판 — 미국장이 열려 있는 동안 보는 자리
  { key: "us", label: "미국" },
];

function signCls(v: number): string {
  return v > 0 ? "up" : v < 0 ? "down" : "flat";
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
  /*
   * 선물 투자자별 수급 (네이버, 계약 단위) — 선물 타일의 「받을 데가 없다」 자리.
   * 서버가 10분 캐시라 5분마다 물으면 충분하다. 마지막 날(장중이면 오늘 누적)만 쓴다.
   */
  const [futFlow, setFutFlow] = useState<{
    date: string;
    individual: number;
    foreign: number;
    institution: number;
  } | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .futuresFlow(1)
        .then((r) => alive && r.days.length > 0 && setFutFlow(r.days[r.days.length - 1]))
        .catch(() => undefined);
    void load();
    const t = setInterval(load, 5 * 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  const movers = useSection<{ rising: StockRow[]; falling: StockRow[] }>("movers", 20_000);
  const sectors = useSection<{ kospi: SectorRow[]; kosdaq: SectorRow[] }>("sectors", 60_000);
  const themes = useSection<{ top: ThemeRow[]; bottom: ThemeRow[] }>("themes", 60_000);
  const highLow = useSection<{ high: StockRow[]; low: StockRow[] }>("highLow", 120_000);
  const vi = useSection<ViRow[]>("vi", 20_000);
  const global = useSection<GlobalQuote[]>("global", 15_000);
  const usMajor = useSection<UsMajorResult>("usMajor", 15_000);
  const rates = useSection<RateRow[]>("rates", 30_000);
  const topTraders = useSection<TopTraderRow[]>("topTraders", 120_000);

  const [flowMarket, setFlowMarket] = useState<"kospi" | "kosdaq">("kospi");
  const [moverDir, setMoverDir] = useState<"rising" | "falling">("rising");
  const [sectorMarket, setSectorMarket] = useState<"kospi" | "kosdaq">("kospi");
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
    sectors.refresh();
    themes.refresh();
    highLow.refresh();
    vi.refresh();
    global.refresh();
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
          {r.name}
        </span>
        <span className={`ov-px num ${signCls(r.changeRate)}`}>{fmtNum(r.price)}</span>
        <span className={`ov-pct num ${signCls(r.changeRate)}`}>{fmtPct(r.changeRate)}</span>
      </button>
    );
  }

  return (
    <div className="ov">
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
            <MarketSignalPanel />
          </div>
        )}

        {show("summary") && (
          <OverviewCard title="국내 지수" order={cards.orderOf("indices")} updatedAt={indices.updatedAt} loading={indices.loading} error={indices.error}>
            <div className="ov-idx-grid">
              {idx.map((c) => {
                /*
                 * **선물에는 수급을 붙이지 않는다.**
                 *
                 * 여기 수급은 `ka10051` 주식시장 투자자 순매수다. 선물은 완전히 다른
                 * 시장이라 그 값을 갖다 붙이면 **틀린 값을 보여주는 것**이 된다 —
                 * 키움 화면의 선물 수급(외국인 2,240 / 기관 6,152)과 숫자가 전혀 다르다.
                 * 없는 것보다 틀린 게 나쁘다.
                 *
                 * 코스피200 은 코스피 구성종목의 부분집합이라 참고로 붙여 둔다.
                 *
                 * 한투 339개 API 에 선물 투자자별 매매동향이 없다(투자자 매매동향 7개가
                 * 전부 국내주식이고, 「시장별」도 KSP/KSQ 만 받는다). 키움에도 없다.
                 * → 2026-08-25 **네이버**(investorDealTrendDay, sosok=03)에서 찾아
                 *   아래 futFlow 로 붙였다. 단위는 계약이다.
                 */
                const f =
                  c.code === "F"
                    ? null
                    : c.code === "101"
                      ? flow.data?.kosdaq
                      : flow.data?.kospi;
                /*
                  코스피·코스닥은 눌러서 상세로 간다. 선물도 (2026-08-26) 같은 구조로 —
                  차트 + 베이시스·미결제 + 장중 수급 + 일별 수급 시트가 열린다.
                  코스피200 은 아직 상세가 없어 그대로 둔다.
                */
                const openable = c.code === "001" || c.code === "101" || (c.code === "F" && !!c.futures);
                const open =
                  c.code === "F"
                    ? () =>
                        c.futures &&
                        setFutDetail({
                          code: c.futures.code,
                          name: c.futures.name,
                          price: c.price,
                          changeRate: c.changeRate,
                          basis: c.futures.basis,
                          openInterest: c.futures.openInterest,
                        })
                    : () => setIndexDetail(c.code);
                return (
                  <div
                    className={`ov-idx${openable ? " clickable" : ""}`}
                    key={c.code}
                    onClick={openable ? open : undefined}
                    title={openable ? "눌러서 추이·수급 보기" : undefined}
                  >
                    <div className="ov-idx-name">{c.name}</div>
                    <div className={`ov-idx-val num ${signCls(c.changeRate)}`}>{fmtNum(c.price)}</div>
                    <div className={`ov-idx-chg num ${signCls(c.changeRate)}`}>
                      {fmtSigned(c.change)} {fmtPct(c.changeRate)}
                    </div>
                    <Sparkline values={c.sparkline} up={c.changeRate >= 0} />
                    {/*
                      베이시스·미결제는 시트로 이사했다 (2026-08-26 — 「차트 하단에
                      나오게 해줘」). 타일엔 월물 이름만 남긴다 — 칸이 수급으로 빼곡하다.
                    */}
                    {c.futures && (
                      <div className="ov-fut">
                        {/* 클릭 유도는 카드 전체 title 이 이미 한다 — 글자는 월물만 */}
                        <span className="pt-n" title="눌러서 차트·베이시스·수급 시트">
                          {c.futures.name}
                        </span>
                      </div>
                    )}
                    {/*
                      선물 수급 (2026-08-25) — 「받을 데가 없다」던 자리. 네이버
                      투자자별 매매동향(sosok=03)을 실측으로 찾아 서버가 준다.
                      단위가 **계약**이라 지수 수급(억원)과 다름을 밑줄에 밝힌다.
                    */}
                    {c.code === "F" &&
                      futFlow &&
                      (() => {
                        /*
                         * 계약 → ≈억원 환산 (2026-08-26). 키움 앱은 선물 수급을 억원으로
                         * 보여줘서 「값이 다르다」 소리가 나왔다 — 같은 데이터, 단위 차이.
                         * K200 선물 승수 25만원/pt: 억원 = 계약 × 지수 × 250,000 / 1e8
                         * = 계약 × 지수 / 400. 평균 체결가가 아니라 현재가라 ≈ 다.
                         *
                         * **금액이 위(크게), 계약이 아래(작게)** — 지수 수급(억원)과
                         * 같은 눈으로 견주는 게 우선이라는 사용자 지정.
                         */
                        // 「억」 글자는 뺀다 — 이 카드의 수급은 다 억원이라 접미가 소음이다
                        const eok = (n: number) =>
                          `${n > 0 ? "+" : ""}${fmtNum(Math.round((n * c.price) / 400))}`;
                        // ≈ 는 뺐다 — 추정치인 건 알고 있으니 지우라는 지정. 툴팁이 말한다
                        const row = (lbl: string, n: number) => (
                          <div>
                            <span className="lbl">{lbl}</span>
                            <span className={`ff-two ${signCls(n)}`}>
                              {c.price > 0 ? eok(n) : `${n > 0 ? "+" : ""}${fmtNum(n)}`}
                              <em className="ff-eok">
                                {n > 0 ? "+" : ""}
                                {fmtNum(n)}계약
                              </em>
                            </span>
                          </div>
                        );
                        return (
                          <div className="ov-idx-flow num">
                            {row("외국인", futFlow.foreign)}
                            {row("기관", futFlow.institution)}
                            {row("개인", futFlow.individual)}
                          </div>
                        );
                      })()}
                    {c.code === "F" && (
                      /*
                       * 밑줄 설명이 길어 두 줄로 접히던 것 (2026-08-26) — 표시는 날짜와
                       * 출처만 짧게, 단위 설명은 툴팁으로. 두 줄이 되느니 글자를 줄인다.
                       */
                      <div
                        className="ov-idx-note ov-idx-note-1"
                        title="큰 값은 ≈억원 환산(계약 × 지수 × 25만원), 아래 작은 값이 원본 계약 수 · 네이버 투자자별 매매동향(±10분 지연)"
                      >
                        {futFlow
                          ? `${futFlow.date.slice(5).replace("-", "/")} 순매수 · 네이버 ±10분`
                          : "선물 수급 불러오는 중…"}
                      </div>
                    )}
                    {f && (
                      <div className="ov-idx-flow num">
                        <div>
                          <span className="lbl">외국인</span>
                          <span className={signCls(f.foreign)}>
                            {f.foreign > 0 ? "+" : ""}
                            {fmtNum(f.foreign)}
                          </span>
                        </div>
                        <div>
                          <span className="lbl">기관</span>
                          <span className={signCls(f.institution)}>
                            {f.institution > 0 ? "+" : ""}
                            {fmtNum(f.institution)}
                          </span>
                        </div>
                        <div>
                          <span className="lbl">개인</span>
                          <span className={signCls(f.individual)}>
                            {f.individual > 0 ? "+" : ""}
                            {fmtNum(f.individual)}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
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
            <div className="ov-card-b">
              <table className="ov-table num">
                <thead>
                  <tr>
                    <th>구분</th>
                    <th className="up">상한</th>
                    <th className="up">상승</th>
                    <th>보합</th>
                    <th className="down">하락</th>
                    <th className="down">하한</th>
                  </tr>
                </thead>
                <tbody>
                  {[kospiCard, kosdaqCard].map(
                    (c) =>
                      c && (
                        <tr key={c.code}>
                          <td>{c.name}</td>
                          <td className="up">{c.upperLimit}</td>
                          <td className="up">{fmtNum(c.rising)}</td>
                          <td className="flat">{c.flat}</td>
                          <td className="down">{fmtNum(c.falling)}</td>
                          <td className="down">{c.lowerLimit}</td>
                        </tr>
                      ),
                  )}
                </tbody>
              </table>
            </div>
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
          금리 — 야후는 미국 것만 준다(일본·한국은 심볼 자체가 없다). 한투가 국내
          국고채부터 일본 10년까지 한 번에 준다. 요즘 시장을 흔드는 건 일본 금리라
          미장 바로 뒤에 둔다 — 엔 캐리가 풀리면 전 세계 위험자산에서 돈이 빠진다.
        */}
        {show("summary") && (
          <OverviewCard
            order={cards.orderOf("rates")}
            title="금리"
            updatedAt={rates.updatedAt}
            loading={rates.loading}
            error={rates.error}
          >
            <div className="ov-card-b">
              <div className="rt-grid">
                {/* 해외가 먼저다 (2026-08-25, PDF #6) — 요즘 시장을 흔드는 게 미국 금리라서 */}
                {(["해외", "국내"] as const).map((g) => (
                  <div key={g}>
                    <div className="rt-h">{g}</div>
                    {(rates.data ?? [])
                      .filter((r) => r.group === g)
                      .map((r) => {
                        /*
                          추이 차트는 **야후에 실제로 있는 것만** 연결한다 (실측:
                          ^TNX 4.704 / ^TYX 5.231 — 한투 값과 단위까지 일치).
                          국고채·CD·일본 10년·기준금리는 야후에 심볼이 없다(전부
                          404 실측) — 없는 것을 눌리게 만들지 않는다.
                        */
                        const yahoo =
                          r.code === "Y0202"
                            ? "^TNX"
                            : r.code === "Y0201"
                              ? "^TYX"
                              : null;
                        /* 미국 10년·30년 강조 (PDF #6) — 이 카드에서 실제로 보는 두 줄 */
                        const hot = r.code === "Y0202" || r.code === "Y0201";
                        const body = (
                          <>
                            <span className={hot ? "rt-hot" : undefined}>{r.name}</span>
                            <b className={`num${hot ? " rt-hot" : ""}`}>{r.rate?.toFixed(3)}%</b>
                            {/* 금리는 변화폭(%p)으로 읽는다 — 등락률로 보면 감이 안 온다 */}
                            <em className={`num ${signCls(r.change ?? 0)}`}>
                              {(r.change ?? 0) > 0 ? "+" : ""}
                              {(r.change ?? 0).toFixed(3)}%p
                            </em>
                          </>
                        );
                        return yahoo ? (
                          <button
                            type="button"
                            className="rt-row rt-click"
                            key={r.code}
                            onClick={() =>
                              setChart({ symbol: yahoo, label: r.name, digits: 3 })
                            }
                            title="눌러서 추이 차트"
                          >
                            {body}
                          </button>
                        ) : (
                          <div className="rt-row" key={r.code}>
                            {body}
                          </div>
                        );
                      })}
                  </div>
                ))}
              </div>
              <div className="table-note">
                <b>%p</b> 는 등락률이 아니라 <b>변화폭</b>입니다 — 4.71% 가 4.72% 로 가는 건
                등락률로는 0.2% 지만 시장이 반응하는 건 0.01%p 라는 폭 자체입니다.
                <b>일본 10년</b>은 엔 캐리와 붙어 있어, 오르면 전 세계 위험자산에서 돈이
                빠집니다. 한국투자증권 제공.
              </div>
            </div>
          </OverviewCard>
        )}

        {show("summary") && (
          <OverviewCard title="시장 폭 추이" order={cards.orderOf("breadth")}>
            <div className="ov-card-b">
              <BreadthPanel />
            </div>
          </OverviewCard>
        )}

        {/*
          여기가 ⑤ 증시주변자금 동향 자리다 — 고객예탁금·미수금·신용잔고·선물예수금.
          키움에도 한투에도 없어서 공공데이터포털 키가 생겨야 붙는다. 그때 여기 끼운다.
        */}

        {show("summary") && (
          <OverviewCard title="업종" order={cards.orderOf("sectors")} updatedAt={sectors.updatedAt} loading={sectors.loading} error={sectors.error}>
            <SegmentToggle
              options={[
                { key: "kospi" as const, label: "코스피" },
                { key: "kosdaq" as const, label: "코스닥" },
              ]}
              value={sectorMarket}
              onChange={setSectorMarket}
            />
            <RankList
              items={sectors.data?.[sectorMarket] ?? []}
              renderItem={(s: SectorRow, i) => (
                <button
                  className="ov-li"
                  key={`${s.code}-${i}`}
                  onClick={() =>
                    setConstituent({ kind: "sector", code: s.code, name: s.name, market: sectorMarket })
                  }
                >
                  <span className="ov-nm">{s.name}</span>
                  <span className={`ov-pct num ${signCls(s.changeRate)}`}>{fmtPct(s.changeRate)}</span>
                </button>
              )}
            />
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

      {/*
        지표 설명은 **맨 아래**다. 원래 시장 폭 그래프 바로 밑에 있었는데 설명이 길어서
        본문을 밀어냈다 — 세 지표를 보러 왔다가 다음 카드까지 한참 스크롤해야 했다.
        처음 몇 번만 읽으면 되는 것이라 뒤로 뺀다.
      */}
      {show("summary") && (
        <details className="ov-help">
          <summary>시장 폭 지표는 어떻게 읽나</summary>
          <BreadthHelp />
        </details>
      )}

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
