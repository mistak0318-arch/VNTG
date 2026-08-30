import { Fragment, useCallback, useEffect, useState } from "react";
import { TopicPulseBlock } from "../components/TopicPulse";
import {
  api,
  fmtNum,
  type BriefingEvent,
  type BriefingTile,
  type GlobalQuote,
  type IndexCard,
  type MarketFlow,
  type ThemeRow,
  type UsMajorResult,
} from "../api";
import { ConstituentSheet, type ConstituentTarget } from "../components/overview/ConstituentSheet";
import {
  FlowBars,
  MyThemeStrip,
  TurnoverStrip,
  UpDownStrip,
  WatchHeatGrid,
} from "../components/BriefingBlocks";
import { RefreshBar } from "../components/RefreshBar";
import { IndexDetailSheet } from "../components/overview/IndexDetailSheet";
import {
  FuturesDetailSheet,
  type FuturesDetailTarget,
} from "../components/overview/FuturesDetailSheet";
import { RotationStrip, ThermoChips, useMarketLens } from "../components/MarketLensPanel";
import { useSection } from "../useSection";

/**
 * 마켓 브리핑 — **열자마자 3초 안에 「오늘 시장이 어떤가」.**
 *
 * ## 시황 대시보드와 무엇이 다른가
 *
 * 대시보드는 카드 13장을 **파고드는** 자리고, 여기는 **훑고 끝내는** 자리다.
 * 같은 질문을 두 화면이 다르게 답하면 안 되므로 **데이터는 전부 같은 곳**에서 온다 —
 * 지수·수급·테마는 대시보드와 같은 섹션 API(`useSection`, 서버 캐시 공유)를 그대로 쓰고,
 * 타임라인·히트맵·AI 한 줄만 브리핑 전용 라우트(캐시·파일만 읽음)를 쓴다.
 *
 * **이 페이지가 새로 만드는 외부 호출은 0건이다.** 폴링 주기도 대시보드와 같거나
 * 느리다 — 같은 서버 캐시를 보므로 키움·야후 호출은 한 건도 늘지 않는다.
 *
 * ## 구성 (중요도 순)
 *
 *   [1] 온도계   지수·등락 비율 컬러바·환율·미선물·VIX — 위험 선호/회피 한 줄
 *   [2] 타임라인 VI·공시·채널 매칭·시그널·손절·체결강도 — 시간 역순
 *   [3] 수급     코스피/코스닥 × 개인/외인/기관 (⚠️ 기관 세부는 이 캐시에 없어 제외 —
 *                없는 값을 위해 조회를 만들지 않는다. 세부는 종목 화면 몫이다)
 *   [4] 히트맵   관심종목 × 등락률 (타일 크기: 시총 — 스냅샷에 거래대금이 없다)
 *   [5] 테마     상승 5 · 하락 3
 *   [6] AI 한 줄 마지막 발행 리포트 재사용 (새 AI 호출 없음 — 비용 0)
 */

/* ── 작은 조각들 ─────────────────────────────────────────── */

function cls(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n === 0) return "";
  return n > 0 ? "positive" : "negative";
}

function pct(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  return `${n > 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

/** 배지 색 — 종류가 곧 색이다. 지라시(채널)는 회색: 출처 신뢰도가 다르다는 표시 */
const BADGE_CLASS: Record<string, string> = {
  vi: "bf-badge-vi",
  dart: "bf-badge-dart",
  telegram: "bf-badge-gray",
  stop: "bf-badge-stop",
  strength: "bf-badge-strength",
  signal: "bf-badge-signal",
};

/* ── [1] 시장 온도계 ────────────────────────────────────── */

function Thermometer({
  indices,
  global,
  usMajor,
  onIndex,
}: {
  indices: IndexCard[] | null;
  global: GlobalQuote[] | null;
  usMajor: UsMajorResult | null;
  /** 지수를 누르면 — 시황 대시보드와 같은 상세 시트를 연다 (2026-08-29) */
  onIndex: (code: string) => void;
}) {
  const kospi = indices?.find((i) => i.code === "001");
  const kosdaq = indices?.find((i) => i.code === "101");
  /* 상승/하락은 두 시장을 합쳐 본다 — 폭은 시장을 가르지 않는 게 낫다(breadthStore 와 같은 판단) */
  const rising = (kospi?.rising ?? 0) + (kosdaq?.rising ?? 0);
  const falling = (kospi?.falling ?? 0) + (kosdaq?.falling ?? 0);
  const total = rising + falling;
  const upShare = total > 0 ? (rising / total) * 100 : 50;

  const pick = (key: string) => global?.find((g) => g.key === key) ?? null;
  const usdkrw = pick("usdkrw");
  const es = pick("esF");
  const nq = pick("nqF");
  const vix = usMajor?.rows.find((r) => r.key === "vix") ?? null;
  /* 금리·유가 (2026-08-26 요청) — 위험 선호의 나머지 반쪽 */
  const tnx = usMajor?.rows.find((r) => r.key === "tnx") ?? null;
  const tyx = usMajor?.rows.find((r) => r.key === "tyx") ?? null;
  const wti = usMajor?.rows.find((r) => r.key === "wti") ?? null;

  return (
    <div className="bf-thermo">
      {/*
        코스피·코스닥은 다른 값들과 같은 작은 표기(bf-mini)로 — 큰 박스가
        두 줄을 만들어 아래를 밀어냈다(2026-08-26). 온도계는 한 줄이 목표다.
      */}
      {/* 눌러서 상세 — 시황 대시보드의 지수 타일과 같은 시트다 (2026-08-29) */}
      {[
        { label: "코스피", card: kospi, code: "001" },
        { label: "코스닥", card: kosdaq, code: "101" },
      ].map(({ label, card, code }) => (
        <button
          type="button"
          className="bf-mini bf-mini-idx bf-mini-click"
          key={label}
          onClick={() => onIndex(code)}
          title={`${label} 지수 상세`}
        >
          <em>{label}</em>
          <b className={cls(card?.changeRate)}>
            {card ? card.price.toFixed(2) : "-"}
            <i className="bf-mini-sub">{pct(card?.changeRate)}</i>
          </b>
        </button>
      ))}

      {/*
        상승/하락 컬러바 — 이 줄의 심장이다. 지수는 대형주 몇 개로도 움직이지만
        **몇 종목이 오르고 있는가**는 못 속인다. 바의 빨강 몫이 곧 시장의 체온이다.
      */}
      {total > 0 && (
        <span className="bf-breadth" title={`상승 ${rising} · 하락 ${falling} (코스피+코스닥)`}>
          <span className="bf-breadth-bar">
            <i style={{ width: `${upShare}%` }} />
          </span>
          <em>
            ▲{rising} ▼{falling}
          </em>
        </span>
      )}

      {/* 위험 선호/회피 세 값 — 환율(외인 수급의 전제)·미 선물(다음 장의 예고)·VIX(공포) */}
      {/* 달러/원은 값 자체가 판단 기준(1,400 같은)이라 가격+등락률을 같이 (2026-08-26) */}
      {usdkrw?.price != null && (
        <span className="bf-mini" title={usdkrw.label}>
          <em>달러/원</em>
          <b className={cls(usdkrw.changeRate)}>
            {usdkrw.price.toFixed(1)}
            <i className="bf-mini-sub">{pct(usdkrw.changeRate)}</i>
          </b>
        </span>
      )}
      {[
        { label: "ES", q: es },
        { label: "NQ", q: nq },
      ].map(
        ({ label, q }) =>
          q?.price != null && (
            <span className="bf-mini" key={label} title={q.label}>
              <em>{label}</em>
              <b className={cls(q.changeRate)}>{pct(q.changeRate)}</b>
            </span>
          ),
      )}
      {/* VIX 도 방향까지 — 오르는 중인지가 값만큼 중요하다 (2026-08-26) */}
      {vix?.price != null && (
        <span
          className="bf-mini"
          title="VIX — 20이 불안의 문턱, 30이 공포입니다 (미장 주요지수와 같은 값)"
        >
          <em>VIX</em>
          <b className={vix.price >= 30 ? "negative" : vix.price >= 20 ? "bf-warn" : ""}>
            {vix.price.toFixed(1)}
            {vix.changeRate !== null && (
              <i className={`bf-mini-sub ${cls(vix.changeRate)}`}>
                {vix.changeRate > 0 ? "▲" : vix.changeRate < 0 ? "▼" : ""}
                {Math.abs(vix.changeRate).toFixed(1)}%
              </i>
            )}
          </b>
        </span>
      )}
      {/* 미국 금리·유가 (2026-08-26 요청) — 금리는 %p 방향이 본체라 값+방향 화살표로 */}
      {[
        { label: "美10년", r: tnx },
        { label: "美30년", r: tyx },
      ].map(
        ({ label, r }) =>
          r?.price != null && (
            <span className="bf-mini" key={label} title={`${r.label} 국채금리 — 오르면 할인율 부담`}>
              <em>{label}</em>
              <b>
                {r.price.toFixed(2)}%
                {r.changeRate !== null && r.changeRate !== 0 && (
                  <i className={`bf-mini-sub ${cls(r.changeRate)}`}>
                    {r.changeRate > 0 ? "▲" : "▼"}
                  </i>
                )}
              </b>
            </span>
          ),
      )}
      {wti?.price != null && (
        <span className="bf-mini" title="WTI 유가(근월물) — 정유·화학·항공에 바로 닿습니다">
          <em>WTI</em>
          <b className={cls(wti.changeRate)}>
            {wti.price.toFixed(1)}
            <i className="bf-mini-sub">{pct(wti.changeRate)}</i>
          </b>
        </span>
      )}
      {/* 약어 풀이 (2026-08-26 요청) — ES/NQ 가 뭔지 화면이 직접 말한다 */}
      <span className="bf-thermo-note">
        ES = S&amp;P500 선물 · NQ = 나스닥100 선물 (지금 도는 미국 지수선물 — 다음 미장의 예고편)
        · VIX = 변동성(공포)지수 · 美금리 화살표 = 전일 대비 방향
      </span>
    </div>
  );
}

/* ── [3] 수급 미니 바 — BriefingBlocks 로 이사 (보드 블록과 공용, 2026-08-27) ── */

/* ── 본체 ───────────────────────────────────────────────── */

export function BriefingPage({
  onSelectStock,
}: {
  onSelectStock: (code: string, name: string) => void;
}) {
  /*
   * 지수·글로벌·미장·수급·테마는 **대시보드와 같은 섹션**을 같은(또는 더 느린) 주기로.
   * 서버 캐시가 같으므로 이 페이지가 열려 있어도 키움·야후 호출은 늘지 않는다.
   */
  const indices = useSection<IndexCard[]>("indices", 15_000);
  const global = useSection<GlobalQuote[]>("global", 20_000);
  const usMajor = useSection<UsMajorResult>("usMajor", 20_000);
  const flow = useSection<MarketFlow>("flow", 30_000);
  const themes = useSection<{ top: ThemeRow[]; bottom: ThemeRow[] }>("themes", 60_000);

  const [events, setEvents] = useState<BriefingEvent[] | null>(null);
  const [heat, setHeat] = useState<{ traded: boolean; tiles: BriefingTile[] } | null>(null);
  /* K200 선물 오늘 수급(계약) — 현물 수급 카드에 한 줄 같이 (2026-08-26) */
  const [futFlow, setFutFlow] = useState<{ individual: number; foreign: number; institution: number } | null>(null);
  const [brief, setBrief] = useState<{ date: string; label: string; text: string } | null>(null);
  /* 테마를 누르면 구성종목 시트 — 보기만 하는 숫자는 죽은 숫자다 */
  const [constituent, setConstituent] = useState<ConstituentTarget | null>(null);
  /* 로그 이벤트(급증·시그널 등)가 어느 날 것인가 — 자정 넘으면 마지막 장일로 폴백된다 */
  const [eventDay, setEventDay] = useState<string | null>(null);

  const loadOwn = useCallback(() => {
    void api
      .briefingTimeline()
      .then((r) => {
        setEvents(r.items);
        setEventDay(r.eventDay ?? null);
      })
      .catch(() => undefined);
    void api.briefingHeat().then(setHeat).catch(() => undefined);
    void api
      .futuresFlow(1)
      .then((r) => setFutFlow(r.days[r.days.length - 1] ?? null))
      .catch(() => undefined);
    /* AI 한 줄은 실패하면 그냥 안 보인다 — 에러를 화면에 내지 않는다(지시서 요건) */
    void api.briefingBrief().then((r) => setBrief(r.brief)).catch(() => undefined);
  }, []);

  useEffect(() => {
    loadOwn();
    /* 타임라인은 30초 — 이벤트는 놓치면 아까운 값이지만 초 단위로 볼 값은 아니다 */
    const t = setInterval(() => {
      if (document.visibilityState === "visible") loadOwn();
    }, 30_000);
    return () => clearInterval(t);
  }, [loadOwn]);

  const refreshAll = () => {
    indices.refresh();
    global.refresh();
    usMajor.refresh();
    flow.refresh();
    themes.refresh();
    reloadLens();
    loadOwn();
  };

  /* (타일 크기는 균등 격자로 바뀌어 시총 비례 계산이 필요 없어졌다 — 2026-08-26) */

  /* 체온 칩 + 로테이션이 같은 렌즈를 나눠 본다 — 한 번만 받는다 */
  const { lens, reload: reloadLens } = useMarketLens();
  /* 지수 상세 — 시황 대시보드와 **같은 시트**를 쓴다. 두 화면이 다른 걸 보여 주면 안 된다 */
  const [indexDetail, setIndexDetail] = useState<string | null>(null);
  /* 선물 상세 — 대시보드와 같은 시트(차트·베이시스·미결제·수급) */
  const [futDetail, setFutDetail] = useState<FuturesDetailTarget | null>(null);

  return (
    <div className="bf">
      {/*
        고정은 **새로고침 한 줄만** (2026-08-26 — 「고정 카드 때문에 밑이 안 보인다」).
        온도계는 일반 흐름으로 내려 스크롤과 함께 올라간다.
      */}
      <div className="bf-top bf-top-slim">
        <RefreshBar onRefresh={refreshAll} updatedAt={indices.updatedAt} />
      </div>
      <Thermometer
        indices={indices.data}
        global={global.data}
        usMajor={usMajor.data}
        onIndex={setIndexDetail}
      />
      {/* 체온 한 줄 (2026-08-28 상황실 개편) — 지수 다음 물음 「종목들은 어떤가」 */}
      <ThermoChips lens={lens} />

      {/*
        AI 한 줄 — **지수 박스 바로 아래**(2026-08-26 사용자 요청). 오른쪽 기둥에
        묻혀 있으면 스크롤해야 보였다. 실패·부재 시 통째로 숨긴다 — 빈 칸은 소음이다.
      */}
      {brief && (
        <div className="bf-brief bf-brief-top">
          {brief.text}
          <i className="bf-brief-src">
            {brief.date} {brief.label} 리포트에서 — 새 AI 호출 없음
          </i>
        </div>
      )}

      {/*
        지금 무슨 얘기가 도는가 — **격자 위, 지수 아래** (2026-08-30).
        마켓 브리핑은 「지금」의 종합 상황실이라 창을 3시간으로 짧게 잡는다.
        장전 브리핑룸(밤사이 12시간)과 같은 문장 만드는 자리를 쓰되 창만 다르다.
      */}
      <TopicPulseBlock window="now" onSelectStock={onSelectStock} />

      <div className="bf-grid">
        {/* 좌: [3] 수급 + [5] 테마 */}
        <section className="bf-col bf-left">
          <h3 className="section-heading">오늘 수급</h3>
          {/* 선물은 계약을 억원으로 환산 — 위 코스피·코스닥과 같은 결 (지수값은 지수 카드에서) */}
          <FlowBars
            flow={flow.data}
            futures={futFlow}
            futPrice={indices.data?.find((i) => i.code === "F")?.price ?? null}
            onOpenIndex={setIndexDetail}
            onOpenFutures={() => {
              /* 지수 카드에 실려 오는 월물 정보로 연다 — 없으면 열 게 없다 */
              const c = indices.data?.find((i) => i.code === "F");
              if (!c?.futures) return;
              setFutDetail({
                code: c.futures.code,
                name: c.futures.name,
                price: c.price,
                changeRate: c.changeRate,
                basis: c.futures.basis,
                openInterest: c.futures.openInterest,
              });
            }}
          />

          {/*
            폭과 유동성 (2026-08-27 — "그래야 시장을 읽지").
            수급(누가 사나) 다음 물음이 「몇 종목이 오르나(폭)」와 「돈이 도나(대금)」다.
            처음엔 시황의 표를 그대로 꽂았는데 글자 크기·간격이 브리핑과 안 맞았다 —
            **데이터만 같고 레이아웃은 브리핑 것**(수급 격자와 같은 문법)으로 다시 그린다.
          */}
          <h3 className="section-heading">종목등락현황</h3>
          <UpDownStrip
            cards={[
              indices.data?.find((i) => i.code === "001"),
              indices.data?.find((i) => i.code === "101"),
            ]}
          />

          <h3 className="section-heading">거래대금 현황</h3>
          <TurnoverStrip />

          {/*
            테마 (2026-08-27) — 키움 테마 → **내 테마 · 미국 테마**.
            증권사 분류는 잘게 쪼개져 무엇이 도는지 안 읽혔다. 데일리 리포트가 이미
            내 분류로 답을 내고 있으니 브리핑도 같은 재료를 쓴다(타일 대신 텍스트 줄).
          */}
          <h3 className="section-heading">테마</h3>
          {/*
            로테이션 압축판 (2026-08-28) — 훑는 화면답게 석 줄이다.
            주도가 이어지는지, 새 주자가 들어왔는지, 주도가 쉬는지. 판 전체는
            시장 흐름 분석 > 테마 로테이션에 있다.
          */}
          <RotationStrip lens={lens} onSelectStock={onSelectStock} />
          <MyThemeStrip
            onPickTheme={(t) =>
              setConstituent({
                /* 둘 다 「내가 묶은 것」이라 custom 이고, 이름표로 갈린다 (리포트와 같은 방식) */
                kind: "custom",
                code: t.id,
                name: t.name,
                label: t.kind === "usGroup" ? "해외 관심종목 그룹" : "내 테마 구성종목",
                /* 스트립이 등락률·가격까지 넘긴다 — 0 으로 채우면 시트가 전부 보합으로 뜬다 */
                stocks: t.stocks.map((s) => ({
                  code: s.code,
                  name: s.name,
                  price: s.price,
                  change: 0,
                  changeRate: s.changeRate,
                  marketCap: s.marketCap,
                })),
              })
            }
          />
        </section>

        {/* 우: [4] 히트맵 + 라이브 티커 */}
        <section className="bf-col bf-right">
          <h3 className="section-heading">관심종목</h3>
          {/* 본문은 보드 블록과 공용 (BriefingBlocks) */}
          <WatchHeatGrid heat={heat} onSelectStock={onSelectStock} />

          {/*
            라이브 티커 (2026-08-28 상황실 개편) — 「오늘의 이벤트」와 「VI 발동현황」
            두 전폭 목록을 **하나의 고정 높이 칸**으로 합쳤다.
            둘이 화면 절반을 먹었는데 실제로는 훑지도 않았다 — 상황실의 이벤트는
            벽 하나를 차지하는 게 아니라 구석의 티커다. 기본은 「중요」(내 종목 전부 +
            VI 아닌 이벤트)만: VI 는 하루 수백 건이라 켜 두면 나머지가 파묻힌다.
          */}
          <LiveTicker events={events} eventDay={eventDay} onSelectStock={onSelectStock} />
        </section>
      </div>

      {indexDetail && (
        <IndexDetailSheet code={indexDetail} onClose={() => setIndexDetail(null)} />
      )}

      {futDetail && <FuturesDetailSheet target={futDetail} onClose={() => setFutDetail(null)} />}

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

/* ── 라이브 티커 — 이벤트 + VI 를 한 칸에 (2026-08-28 상황실 개편) ── */

function LiveTicker({
  events,
  eventDay,
  onSelectStock,
}: {
  events: BriefingEvent[] | null;
  eventDay: string | null;
  onSelectStock: (code: string, name: string) => void;
}) {
  /*
   * 「중요」가 기본이다 — 내 종목에서 일어난 건 종류 불문 전부, 나머지는 VI 를 뺀
   * 드문 이벤트(공시·시그널·손절·체결강도·채널)만. VI 는 하루 수백 건이라
   * 켜 두면 값있는 것이 파묻힌다. 다 보고 싶은 날만 「전체」를 누른다.
   */
  const [mode, setMode] = useState<"key" | "watch" | "all">("key");

  const rows =
    events === null
      ? null
      : events.filter((e) =>
          mode === "all" ? true : mode === "watch" ? e.watch : e.watch || e.kind !== "vi",
        );
  const watchCount = events?.filter((e) => e.watch).length ?? 0;
  const viCount = events?.filter((e) => e.kind === "vi").length ?? 0;

  return (
    <section className="bf-ticker">
      <div className="bf-ticker-h">
        <h3 className="section-heading">
          라이브
          {eventDay &&
            eventDay !== new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10) && (
              <i className="pt-n"> ({eventDay.slice(5).replace("-", "/")} 장)</i>
            )}
        </h3>
        <span className="bf-ticker-modes">
          {(
            [
              { key: "key", label: "중요" },
              { key: "watch", label: `⭐ 내 종목${watchCount > 0 ? ` ${watchCount}` : ""}` },
              { key: "all", label: `전체${viCount > 0 ? ` (VI ${viCount})` : ""}` },
            ] as const
          ).map((m) => (
            <button
              key={m.key}
              className={`filter-btn${mode === m.key ? " active" : ""}`}
              onClick={() => setMode(m.key)}
            >
              {m.label}
            </button>
          ))}
        </span>
      </div>

      {rows === null ? (
        <div className="empty">불러오는 중…</div>
      ) : rows.length === 0 ? (
        <div className="empty">
          {mode === "watch"
            ? "내 종목에는 아직 이벤트가 없습니다."
            : "아직 잡힌 이벤트가 없습니다 — 공시·VI·알림이 생기면 여기 쌓입니다."}
        </div>
      ) : (
        <div className="bf-ticker-box">
          {rows.map((e, i) => (
            <button
              key={`${e.t}-${e.code ?? e.name}-${i}`}
              className={`bf-tk${e.watch ? " watch" : ""}`}
              onClick={() => {
                if (e.code) onSelectStock(e.code, e.name);
                else if (e.link) window.open(e.link, "_blank", "noopener");
              }}
              title={`${e.name} — ${e.summary}${e.code ? " (눌러서 종목 상세)" : ""}`}
            >
              <span className="bf-tk-t">{/^\d{2}:\d{2}$/.test(e.t) ? e.t : "—"}</span>
              <span className={`bf-badge ${BADGE_CLASS[e.kind] ?? "bf-badge-gray"}`}>{e.badge}</span>
              <b className="bf-tk-name">{e.name}</b>
              <span className="bf-tk-sum">{e.summary}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
