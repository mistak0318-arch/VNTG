import { Fragment, useCallback, useEffect, useState } from "react";
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
import { FlowBars, ThemeStrip, WatchHeatGrid } from "../components/BriefingBlocks";
import { UpDownTable } from "../components/overview/DomesticIndexGrid";
import { TurnoverPanel } from "../components/overview/TurnoverPanel";
import { RefreshBar } from "../components/RefreshBar";
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
}: {
  indices: IndexCard[] | null;
  global: GlobalQuote[] | null;
  usMajor: UsMajorResult | null;
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
      {[
        { label: "코스피", card: kospi },
        { label: "코스닥", card: kosdaq },
      ].map(({ label, card }) => (
        <span className="bf-mini bf-mini-idx" key={label}>
          <em>{label}</em>
          <b className={cls(card?.changeRate)}>
            {card ? card.price.toFixed(2) : "-"}
            <i className="bf-mini-sub">{pct(card?.changeRate)}</i>
          </b>
        </span>
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

  const loadOwn = useCallback(() => {
    void api.briefingTimeline().then((r) => setEvents(r.items)).catch(() => undefined);
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
    loadOwn();
  };

  /* (타일 크기는 균등 격자로 바뀌어 시총 비례 계산이 필요 없어졌다 — 2026-08-26) */

  /*
   * VI 는 하루 수백 건이라 타임라인을 도배한다 — 공시·시그널·손절이 밀려나
   * 정작 드문(=값있는) 이벤트가 안 보였다. VI 만 떼어 **맨 아래 자기 칸**으로 보낸다.
   */
  const mainEvents = events === null ? null : events.filter((e) => e.kind !== "vi");
  const viEvents = events?.filter((e) => e.kind === "vi") ?? [];

  const watchCount = mainEvents?.filter((e) => e.watch).length ?? 0;

  return (
    <div className="bf">
      {/*
        고정은 **새로고침 한 줄만** (2026-08-26 — 「고정 카드 때문에 밑이 안 보인다」).
        온도계는 일반 흐름으로 내려 스크롤과 함께 올라간다.
      */}
      <div className="bf-top bf-top-slim">
        <RefreshBar onRefresh={refreshAll} updatedAt={indices.updatedAt} />
      </div>
      <Thermometer indices={indices.data} global={global.data} usMajor={usMajor.data} />

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

      <div className="bf-grid">
        {/* 좌: [3] 수급 + [5] 테마 */}
        <section className="bf-col bf-left">
          <h3 className="section-heading">오늘 수급</h3>
          <FlowBars flow={flow.data} futures={futFlow} />

          {/*
            폭과 유동성 (2026-08-27 — "그래야 시장을 읽지").
            수급(누가 사나) 다음 물음이 「몇 종목이 오르나(폭)」와 「돈이 도나(대금)」다 —
            시황 대시보드와 같은 공용 본문(UpDownTable·TurnoverPanel)을 그대로 꽂는다.
          */}
          <h3 className="section-heading">종목등락현황</h3>
          <UpDownTable
            cards={[
              indices.data?.find((i) => i.code === "001"),
              indices.data?.find((i) => i.code === "101"),
            ]}
          />

          <h3 className="section-heading">거래대금 현황</h3>
          <TurnoverPanel />

          <h3 className="section-heading">테마</h3>
          {/* 본문은 보드 블록과 공용 (BriefingBlocks) */}
          <ThemeStrip
            themes={themes.data ?? null}
            onPickTheme={(t) => setConstituent({ kind: "theme", code: t.code, name: t.name })}
          />
        </section>

        {/* 우: [4] 히트맵 + [6] AI */}
        <section className="bf-col bf-right">
          <h3 className="section-heading">관심종목</h3>
          {/* 본문은 보드 블록과 공용 (BriefingBlocks) */}
          <WatchHeatGrid heat={heat} onSelectStock={onSelectStock} />
        </section>
      </div>

      {/*
        [2] 오늘의 이벤트 — **VI 발동 바로 위**(2026-08-26 사용자 요청).
        가운데 기둥이었을 땐 수급·관심종목이 옆으로 밀렸다. 이벤트는 시간순으로
        길게 쌓이는 목록이라 전체 폭 + 자체 스크롤이 맞다.
      */}
      <section className="bf-events">
        <h3 className="section-heading">
          오늘의 이벤트
          {watchCount > 0 && <i className="bf-watch-count">내 종목 {watchCount}건</i>}
        </h3>
        {mainEvents === null ? (
          <div className="empty">불러오는 중…</div>
        ) : mainEvents.length === 0 ? (
          <div className="empty">
            아직 잡힌 이벤트가 없습니다 — 공시·알림이 발생하면 여기 시간순으로 쌓입니다.
          </div>
        ) : (
          <div className="bf-timeline">
            {mainEvents.map((e, i) => (
              <button
                key={`${e.t}-${e.code ?? e.name}-${i}`}
                className={`bf-event${e.watch ? " watch" : ""}`}
                onClick={() => {
                  if (e.code) onSelectStock(e.code, e.name);
                  else if (e.link) window.open(e.link, "_blank", "noopener");
                }}
                title={e.code ? "눌러서 종목 상세" : e.link ? "눌러서 원문" : undefined}
              >
                <span className="bf-event-t pt-n">{/^\d{2}:\d{2}$/.test(e.t) ? e.t : ""}</span>
                <span className={`bf-badge ${BADGE_CLASS[e.kind] ?? "bf-badge-gray"}`}>
                  {e.badge}
                </span>
                <span className="bf-event-body">
                  <b>{e.name}</b>
                  <span className="bf-event-sum">{e.summary}</span>
                  {e.source && <i className="bf-event-src">{e.source}</i>}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

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

      {/*
        VI 발동현황 — **맨 아래**다(사용자 요청). 건수가 많고 대부분은 스치는 값이라
        위에 두면 화면을 다 먹는다. 내 종목(빨간 테두리)만 훑으면 된다.
        없으면 칸 자체를 안 그린다.
      */}
      {viEvents.length > 0 && (
        <section className="bf-vi">
          <h3 className="section-heading">
            VI 발동현황 <i className="pt-n">{viEvents.length}건</i>
          </h3>
          <div className="bf-timeline">
            {viEvents.map((e, i) => (
              <button
                key={`${e.t}-${e.code ?? e.name}-${i}`}
                className={`bf-event${e.watch ? " watch" : ""}`}
                onClick={() => {
                  if (e.code) onSelectStock(e.code, e.name);
                }}
                title="눌러서 종목 상세"
              >
                <span className="bf-event-t pt-n">{/^\d{2}:\d{2}$/.test(e.t) ? e.t : ""}</span>
                <span className={`bf-badge ${BADGE_CLASS[e.kind] ?? "bf-badge-gray"}`}>
                  {e.badge}
                </span>
                <span className="bf-event-body">
                  <b>{e.name}</b>
                  <span className="bf-event-sum">{e.summary}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
