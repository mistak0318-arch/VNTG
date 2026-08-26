import { Fragment, useEffect, useState, type ReactNode } from "react";
import { useCardOrder } from "../useCardOrder";
import {
  FeaturedSection,
  IndexTrendSection,
  KrThemeMapSection,
  ChannelDigestSection,
  PinnedChannelSection,
  MoneyFlowSection,
  MyStocksSection,
  NightFuturesSection,
  CrossSignalSection,
  SuperSignalSection,
  TradeTrendSection,
  UsThemeMapSection,
} from "../components/report/ReportSections";
import { notifyJobStarted } from "../components/RunningJobsBar";
import {
  api,
  type CalendarEvent,
  fmtNum,
  normalizeStockCode,
  signClass,
  type GlobalQuote,
  type IndexCard,
  type MarketFlow,
  type SectorRow,
  type StockRow,
  type ThemeRow,
} from "../api";
import { AiSummaryCard } from "../components/AiSummaryCard";
import { ReportTts } from "../components/ReportTts";
import { ConstituentSheet, type ConstituentTarget } from "../components/overview/ConstituentSheet";
import { FlowBars } from "../components/overview/FlowBars";
import { type MarketDriverReport, type PublishJob, type ScoredNews } from "../api";
import { NewsClippingCompact } from "../components/report/ReportSections";
import { RefreshBar } from "../components/RefreshBar";
import { ReviewPanel } from "../components/ReviewPanel";
import { useSection } from "../useSection";
import { WatchStar } from "../useWatchedCodes";

/**
 * 데일리 리포트 — 하루치 시황을 한 장으로 훑는 화면.
 *
 * 시황 대시보드가 "지금 이 순간"을 보는 화면이라면, 여기는 신문처럼 위에서 아래로
 * 읽어 내려가는 구조다. 나중에 이 조립 로직을 그대로 메일/텔레그램 본문으로 재사용한다.
 * 데이터는 전부 기존 시황 섹션 캐시를 쓰므로 추가 API 호출이 없다.
 */

/**
 * 판 식별자.
 * 발행 일정을 설정에서 정하게 되면서 사용자가 만든 판("pre-open")이나
 * 즉시발행("now-1432")도 값이 될 수 있어 문자열로 열었다.
 */
type Edition = string;

/**
 * 리포트는 정해진 시각에 발행되는 스냅샷이다.
 * 나중에 미니PC 스케줄러가 이 시각에 리포트를 만들어 메일·텔레그램으로 보낸다.
 * 지금은 웹에서 실시간으로 조립하지만, 화면에는 "어느 판인지"를 기준으로 표시한다.
 */
const EDITIONS: { key: Edition; label: string; desc: string; hour: number }[] = [
  { key: "morning", label: "조간", desc: "밤사이 해외 흐름과 오늘 볼 것", hour: 7 },
  { key: "midday", label: "장중", desc: "오전장 지수·테마·특징주", hour: 12 },
  { key: "closing", label: "석간", desc: "마감 시황과 수급 정리", hour: 18 },
];

/**
 * 주말판. 장이 안 열리므로 지수·수급 대신 뉴스만 담는다.
 * 평일에는 탭에 나오지 않고, 토·일에만 목록을 이걸로 바꾼다.
 */
const WEEKEND_EDITION: { key: Edition; label: string; desc: string; hour: number } = {
  key: "weekend",
  label: "주말",
  desc: "주말 뉴스와 관심종목 소식",
  hour: 9,
};

function isWeekendDay(d: Date): boolean {
  const day = d.getDay();
  return day === 0 || day === 6;
}

/** 지금 시각에 해당하는 판 — 07시 전이면 아직 조간 전이므로 전날 석간을 본다 */
function currentEdition(now: Date): Edition {
  if (isWeekendDay(now)) return "weekend";
  const h = now.getHours();
  if (h < 7) return "closing";
  if (h < 12) return "morning";
  if (h < 18) return "midday";
  return "closing";
}

/**
 * 이 판의 발행 시각. 오늘 그 시각이 아직 안 지났으면 전날 발행분을 가리킨다.
 * (07시 전에 석간을 보면 어제 18시가 맞다)
 */
function publishedAt(edition: Edition, now: Date): { at: Date; pending: boolean } {
  const hour = [...EDITIONS, WEEKEND_EDITION].find((e) => e.key === edition)?.hour ?? 7;
  const at = new Date(now);
  at.setHours(hour, 0, 0, 0);
  if (at.getTime() > now.getTime()) {
    // 아직 발행 시각이 안 됐으면 전날 것
    at.setDate(at.getDate() - 1);
    return { at, pending: true };
  }
  return { at, pending: false };
}

function pct(v: number): string {
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

/** 리포트 섹션 공통 껍데기 */
function Section({ no, title, children }: { no: number; title: string; children: React.ReactNode }) {
  return (
    <section className="report-section">
      <h3 className="report-heading">
        <span className="report-no">{no}</span>
        {title}
      </h3>
      {children}
    </section>
  );
}

/** 강한 테마·업종 한 줄 + 그렇게 움직인 이유(관련 기사) */
function DriverItem({
  name,
  rate,
  sub,
  reasons,
  onOpen,
}: {
  name: string;
  rate: number;
  sub: string;
  reasons: ScoredNews[];
  /** 구성종목 보기 */
  onOpen?: () => void;
}) {
  return (
    <div className={`driver-item${onOpen ? " clickable" : ""}`}>
      <div className="driver-head" onClick={onOpen} role={onOpen ? "button" : undefined}>
        <span className="driver-name">{name}</span>
        <span className={`driver-rate ${signClass(rate)}`}>{pct(rate)}</span>
        <span className="driver-sub">{sub}</span>
        {onOpen && <span className="driver-open">구성종목 ›</span>}
      </div>
      {reasons.length > 0 ? (
        <div className="driver-reasons">
          {reasons.map((r) => (
            <a
              key={r.link}
              className="driver-reason"
              href={r.link}
              target="_blank"
              rel="noreferrer noopener"
            >
              <span className="rp">{r.press}</span>
              {r.title}
            </a>
          ))}
        </div>
      ) : (
        <div className="driver-none">관련 기사를 찾지 못했습니다</div>
      )}
    </div>
  );
}

/* StockLines(급등락·신고저 나열)는 섹션과 함께 뺐다 (2026-08-26) — 특징주 섹션이 대체 */

/**
 * 리포트 섹션 목록 — **이 순서가 기본이고, 사용자가 설정에서 재배열한다** (2026-08-26).
 * 설정 > 화면 > 「서브탭·섹션 순서」가 이 목록을 그대로 보여 주므로,
 * 섹션을 더하거나 빼면 여기 한 줄이 곧 설정 화면이다.
 */
export const REPORT_SECTION_DEFS: { key: string; label: string }[] = [
  { key: "calendar", label: "오늘 일정" },
  { key: "review", label: "복기 — 지난 예측과 실제 결과" },
  { key: "pinned", label: "고정 채널 시황" },
  { key: "nightFutures", label: "코스피 야간선물 · 환율" },
  { key: "indices", label: "국내외 주요 지수" },
  { key: "indexTrend", label: "코스피 · 코스닥 추이 (60거래일)" },
  { key: "investors", label: "투자자별 매매 동향" },
  { key: "moneyFlow", label: "시장 자금 흐름 (업종별 5일 누적)" },
  { key: "usThemeMap", label: "미국 테마 MAP" },
  { key: "krThemeMap", label: "국내 테마 MAP" },
  { key: "themes", label: "특징 테마 (상승 이유 포함)" },
  { key: "sectors", label: "강한 업종 (상승 이유 포함)" },
  { key: "myStocks", label: "내 관심종목" },
  { key: "superSignal", label: "슈퍼신호등" },
  /* 시장 흐름 분석(맥박)의 교차 신호 — 슈퍼신호등 바로 아래 (2026-08-27 사용자 지정) */
  { key: "crossSignal", label: "교차 신호 (주도주 ∩ 슈퍼신호등)" },
  { key: "featured", label: "특징주" },
  { key: "news", label: "주요 뉴스 클리핑 (종목·테마)" },
  { key: "channel", label: "텔레그램 채널 요약" },
  { key: "trade", label: "수출입 동향 — 크게 움직인 품목" },
];

export function DailyReportPage({
  onSelectStock,
}: {
  onSelectStock: (code: string, name: string) => void;
}) {
  const [edition, setEdition] = useState<Edition>(() => currentEdition(new Date()));
  const [newsAt, setNewsAt] = useState<string>("");
  const [drivers, setDrivers] = useState<MarketDriverReport | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishNote, setPublishNote] = useState<string | null>(null);
  const [job, setJob] = useState<PublishJob | null>(null);
  const [target, setTarget] = useState<ConstituentTarget | null>(null);

  useEffect(() => {
    api
      .marketDrivers(5)
      .then(setDrivers)
      .catch(() => setDrivers(null));
  }, []);

  // 시황 대시보드와 같은 섹션 캐시를 공유한다 (추가 호출 없음)
  const indices = useSection<IndexCard[]>("indices", 60_000);
  const flow = useSection<MarketFlow>("flow", 60_000);
  const sectors = useSection<{ kospi: SectorRow[]; kosdaq: SectorRow[] }>("sectors", 180_000);
  const themes = useSection<{ top: ThemeRow[]; bottom: ThemeRow[] }>("themes", 180_000);
  const global = useSection<GlobalQuote[]>("global", 60_000);
  /* 섹션 순서 — 카드 배치와 같은 훅(서버 저장). 목록은 REPORT_SECTION_DEFS */
  const secOrder = useCardOrder(
    "report.sections",
    REPORT_SECTION_DEFS.map((s) => s.key),
  );

  function reloadAll() {
    for (const s of [indices, flow, sectors, themes, global]) s.refresh();
  }

  /**
   * 지금 발행.
   *
   * 정기 판(조간/장중/석간)과 파일이 겹치면 안 되므로 서버가 `now-HHMM` 이라는 별도 id로
   * 저장한다. 오후에 눌렀다고 아침 조간이 오후 내용으로 덮이면 안 되기 때문이다.
   */
  async function publishNow() {
    setPublishing(true);
    setPublishNote(null);
    setJob(null);
    try {
      const { jobId } = await api.reportPublishNow(false);
      // 위쪽 작업 띠가 20초를 기다리지 않고 바로 뜨게 한다
      notifyJobStarted();
      follow(jobId);
    } catch (err) {
      setPublishNote(err instanceof Error ? err.message : "발행 실패");
      setPublishing(false);
    }
  }

  /**
   * 발행 작업을 따라간다.
   *
   * `publish()` 안에만 있던 걸 밖으로 뺐다 — **페이지를 옮겼다 돌아왔을 때도** 같은
   * 방식으로 다시 붙어야 하기 때문이다. 예전엔 화면이 사라지면서 jobId 도 같이 사라져,
   * 돌아오면 아무 일도 없었던 것처럼 보였다.
   */
  function follow(jobId: string) {
    try {
      /*
       * 서버는 곧바로 jobId 만 주고 뒤에서 돈다. 2초마다 물어보면서
       * 지금 어느 단계인지 보여준다 — 1~3분을 아무 표시 없이 기다리게 하지 않는다.
       */
      /*
       * 연속 실패를 센다. 서버가 재시작하면 작업이 메모리에서 사라져 404 가 오는데,
       * 그걸 그냥 삼키면 화면이 **영원히 "진행 중"** 으로 남는다 —
       * 진행 표시를 붙여 놓고 정작 같은 증상을 만드는 셈이다.
       * 한 번쯤은 네트워크가 흔들릴 수 있으니 세 번 연속일 때만 포기한다.
       */
      let misses = 0;
      const timer = setInterval(async () => {
        try {
          const j = await api.reportPublishStatus(jobId);
          misses = 0;
          setJob(j);
          if (j.status !== "running") {
            clearInterval(timer);
            setPublishing(false);
            if (j.status === "done" && j.report) {
              setEdition(j.report.edition as Edition);
              setPublishNote(`${j.report.label} 발행 완료 — 아래 AI 정리가 방금 만든 것입니다.`);
              reloadAll();
            } else {
              setPublishNote(j.error ?? "발행 실패");
            }
          }
        } catch {
          misses += 1;
          if (misses >= 3) {
            clearInterval(timer);
            setPublishing(false);
            setJob(null);
            setPublishNote(
              "진행 상황을 잃었습니다 (서버가 재시작되었을 수 있습니다). 발행 자체는 끝났을 수 있으니 새로고침 후 확인하세요.",
            );
          }
        }
      }, 2000);
    } catch (err) {
      setPublishNote(err instanceof Error ? err.message : "발행 실패");
      setPublishing(false);
    }
  }

  /*
   * 돌아왔을 때 진행 중인 발행이 있으면 다시 붙는다.
   *
   * 서버는 계속 돌고 있었는데 화면만 jobId 를 잃어서, 돌아오면 아무 일도 없었던 것처럼
   * 보였다. `kind` 로 **내 작업만** 고른다 — 채널 요약 작업에 붙으면 엉뚱한 걸 보게 된다.
   */
  useEffect(() => {
    let alive = true;
    api
      .activeJobs()
      .then((r) => {
        if (!alive) return;
        const mine = r.jobs.find((j) => j.job.kind === "report");
        if (!mine) return;
        setPublishing(true);
        setJob(mine.job);
        follow(mine.id);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 리포트 전체의 "언제 기준" — 각 섹션 갱신시각 중 가장 오래된 것 */
  const stampMs = [indices.updatedAt, flow.updatedAt, themes.updatedAt, global.updatedAt]
    .filter((t): t is number => typeof t === "number");
  const oldest = stampMs.length > 0 ? Math.min(...stampMs) : null;
  const fmtStamp = (ms: number) =>
    new Date(ms).toLocaleString("ko-KR", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });

  const now = new Date();
  const pub = publishedAt(edition, now);
  const editionList = isWeekendDay(now) ? [WEEKEND_EDITION] : EDITIONS;
  const editionMeta =
    [...EDITIONS, WEEKEND_EDITION].find((e) => e.key === edition) ?? EDITIONS[0];
  const pubLabel = pub.at.toLocaleString("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const g = global.data ?? [];
  const idx = indices.data ?? [];
  const f = flow.data;
  const sec = sectors.data;
  const th = themes.data;

  /*
   * 섹션 순서 (2026-08-26) — 설정 > 화면 > 「서브탭·섹션 순서」에서 바꾼다(서버 저장).
   * 번호는 화면 순서를 따라 다시 매기므로, 순서를 바꿔도 0부터 이어진다.
   */
  const orderedSections = [...REPORT_SECTION_DEFS].sort(
    (a, b) => secOrder.orderOf(a.key) - secOrder.orderOf(b.key),
  );
  const sectionBodies = buildSectionBodies();

  return (
    <div className="report">
      <RefreshBar onRefresh={reloadAll} updatedAt={indices.updatedAt}>
        <div className="filter-row" style={{ margin: 0 }}>
          {editionList.map((e) => (
            <button
              key={e.key}
              className={`filter-btn ${edition === e.key ? "active" : ""}`}
              onClick={() => setEdition(e.key)}
            >
              {e.label}
            </button>
          ))}
          <span className="news-scope-sep" />
          <button
            className="primary-btn"
            disabled={publishing}
            onClick={() => void publishNow()}
            title="지금 이 순간의 시장으로 리포트를 새로 만듭니다 (AI 호출 1회)"
          >
            {publishing ? "발행 중…" : "지금 발행"}
          </button>
        </div>
      </RefreshBar>

      {publishNote && <div className="alert-note">{publishNote}</div>}

      {/*
        발행 진행 상황. 단계를 처음부터 전부 깔아 두고 상태만 바꾼다 —
        하나씩 나타나면 몇 개가 남았는지 알 수 없다.
      */}
      {job && (
        <div className="pub-progress">
          <div className="pub-progress-head">
            <b>{job.label}</b>
            <span className="pub-progress-count">
              {job.steps.filter((s) => s.state === "done" || s.state === "skipped").length}/
              {job.steps.length}
            </span>
            {job.status === "running" && <span className="pub-spinner" aria-hidden="true" />}
          </div>
          <ol className="pub-steps">
            {job.steps.map((s) => (
              <li key={s.key} className={`pub-step ${s.state}`}>
                <span className="pub-step-mark" aria-hidden="true">
                  {s.state === "done"
                    ? "✓"
                    : s.state === "running"
                      ? "●"
                      : s.state === "failed"
                        ? "✕"
                        : s.state === "skipped"
                          ? "–"
                          : "○"}
                </span>
                <span className="pub-step-label">{s.label}</span>
                {s.note && <span className="pub-step-note">{s.note}</span>}
                {s.ms !== undefined && s.ms > 900 && (
                  <span className="pub-step-ms">{(s.ms / 1000).toFixed(1)}s</span>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}

      <header className="report-header">
        <h2>VNTG 데일리 리포트</h2>
        <div className="report-sub">
          {editionMeta.label} — {editionMeta.desc}
        </div>
        <div className="report-stamp">
          📰 발행 <b>{pubLabel}</b>
          {pub.pending && <span className="report-pending">오늘 {editionMeta.hour}시 발행 예정</span>}
        </div>
        <div className="report-substamp">
          이 화면은 지금 시점 데이터로 미리 조립한 것입니다 · 시세 수집{" "}
          {oldest ? fmtStamp(oldest) : "…"}
          {newsAt && <> · 뉴스 수집 {fmtStamp(new Date(newsAt).getTime())}</>}
        </div>
      </header>

      {/*
        한눈 스트립 (2026-08-25) — 글을 읽기 전에 **방향·수급·환율이 3초 안에** 잡혀야 한다.
        아래 표들에 다 있는 값이지만, 신문의 1면 제목처럼 핵심 다섯 개만 위로 끌어올린다.
        전부 이미 받아 둔 섹션 값이라 조회가 늘지 않는다.
      */}
      {(() => {
        /* 지수 카드 이름은 KOSPI/KOSDAQ 영문 표기다 — 한글로 찾으면 빈다 */
        const kospi = idx.find((c) => /^KOSPI$|^코스피$/i.test(c.name));
        const kosdaq = idx.find((c) => /^KOSDAQ$|^코스닥$/i.test(c.name));
        const usd = g.find((q) => q.key === "usdkrw");
        const chips: { k: string; v: string; sign: number }[] = [];
        if (kospi) chips.push({ k: "코스피", v: `${fmtNum(kospi.price)} (${pct(kospi.changeRate)})`, sign: kospi.changeRate });
        if (kosdaq) chips.push({ k: "코스닥", v: `${fmtNum(kosdaq.price)} (${pct(kosdaq.changeRate)})`, sign: kosdaq.changeRate });
        if (usd?.price != null)
          chips.push({ k: "달러/원", v: `${fmtNum(usd.price)} (${usd.changeRate === null ? "-" : pct(usd.changeRate)})`, sign: usd.changeRate ?? 0 });
        if (f) {
          const frg = f.kospi.foreign + f.kosdaq.foreign;
          const inst = f.kospi.institution + f.kosdaq.institution;
          chips.push({ k: "외국인", v: `${frg > 0 ? "+" : ""}${fmtNum(Math.round(frg))}억`, sign: frg });
          chips.push({ k: "기관", v: `${inst > 0 ? "+" : ""}${fmtNum(Math.round(inst))}억`, sign: inst });
        }
        return chips.length > 0 ? (
          <div className="rp-glance">
            {chips.map((c) => (
              <span className="rp-glance-chip" key={c.k}>
                <em>{c.k}</em>
                <b className={signClass(c.sign)}>{c.v}</b>
              </span>
            ))}
          </div>
        ) : null;
      })()}

      {/* 읽어주기 — 출근길에 AI 정리를 귀로. 브라우저 내장 음성이라 키·비용이 없다 */}
      <ReportTts edition={edition} />
      <AiSummaryCard edition={edition} />

      {/*
        섹션 순서는 설정이 정한다 (2026-08-26 — 「일일이 얘기하고 바꾸려니 불편하다」).
        아래 sectionBodies 의 JSX 를 REPORT_SECTION_DEFS 순서 + 사용자 저장 순서로
        늘어놓고, 번호는 화면 순서를 따라 다시 매긴다. 저장은 카드 배치와 같은
        훅(useCardOrder, 서버) — 설정 > 화면 > 서브탭·섹션 순서에서 바꾼다.
      */}
      {orderedSections.map((s, i) => (
        <Section key={s.key} no={i} title={s.label}>
          {sectionBodies[s.key]}
        </Section>
      ))}

      {target && (
        <ConstituentSheet
          target={target}
          onClose={() => setTarget(null)}
          onSelectStock={(c, n) => {
            setTarget(null);
            onSelectStock(c, n);
          }}
        />
      )}

      <div className="table-note report-footer">
        데이터: 키움 REST API · DART · 네이버 검색 API · Yahoo Finance ·
        시황 대시보드와 동일한 캐시를 사용하므로 추가 조회가 발생하지 않습니다
      </div>
    </div>
  );

  /*
   * 섹션 본문 사전 — 위 orderedSections 가 이 사전에서 꺼내 그린다.
   * 함수 끝에 두는 이유: 본문이 길어서, 순서 로직이 먼저 보여야 읽힌다.
   */
  function buildSectionBodies(): Record<string, ReactNode> {
    return {
      /*
        일정이 맨 위(기본 순서)다. 오늘 무엇이 열리는지를 모르고 지수부터 보면
        순서가 거꾸로다 — FOMC 가 있는 날과 없는 날은 같은 −1% 도 뜻이 다르다.
      */
      calendar: <TodayCalendarSection />,
      review: <ReviewPanel />,
      /* 리포트를 여는 이유가 대개 이 글이다 — 이미 한 편으로 정리된 시황 */
      pinned: <PinnedChannelSection edition={edition} />,
      nightFutures: <NightFuturesSection />,
      /*
        국내외 주요 지수 — 박스 그리드 (2026-08-26, 「공간은 적게, 눈에는 확」).
        그룹 색·신호등 점은 시황과 같은 것을 쓴다.
      */
      indices: (
        <div className="rp-idx-grid">
          {idx.map((c) => (
            <div className="rp-idx-box rp-idx-kr" key={c.name}>
              <span className="rp-idx-name">{c.name}</span>
              {/* 대비는 작게 가격 옆 — 눈이 찾는 건 등락률이라 그것만 크게 */}
              <b className="rp-idx-price">
                {fmtNum(c.price)} <i className={`rp-idx-chg ${signClass(c.change)}`}>{fmtNum(c.change)}</i>
              </b>
              <span className={`rp-idx-rate ${signClass(c.changeRate)}`}>{pct(c.changeRate)}</span>
            </div>
          ))}
          {[...new Set(g.map((q) => q.group))].map((grp) => {
            // 시황과 **같은 색** — 두 화면이 같은 값을 다른 색으로 칠하면 못 찾는다
            const color = g.find((q) => q.group === grp)?.color ?? "#8b98a5";
            return (
              <Fragment key={grp}>
                <div className="rp-idx-ghead" style={{ ["--g" as string]: color }}>
                  {grp}
                </div>
                {g
                  .filter((q) => q.group === grp)
                  .map((q) => (
                    <div
                      className="rp-idx-box"
                      key={q.key}
                      style={{ ["--g" as string]: color }}
                      title={q.signal?.why}
                    >
                      <span className="rp-idx-name">
                        <span className={`ov-g-sig${q.signal ? ` ${q.signal.level}` : ""}`} />
                        {q.label}
                      </span>
                      <b className="rp-idx-price">{q.price === null ? "-" : fmtNum(q.price)}</b>
                      <span className={`rp-idx-rate ${signClass(q.changeRate)}`}>
                        {q.changeRate === null ? "-" : pct(q.changeRate)}
                      </span>
                    </div>
                  ))}
              </Fragment>
            );
          })}
        </div>
      ),
      /* 고점에서 흘러내리는 중인지 바닥에서 튀는 중인지가 판단을 가른다 */
      indexTrend: <IndexTrendSection />,
      /*
        투자자별 — **표 하나로 줄였다.** 줄이 주체, 칸이 시장(코스피·코스닥·합계).
        막대는 접어 뒀다. 모양으로 훑고 싶을 때만 편다.
      */
      investors: (
        <>
        {f ? (
          <>
            <div className="data-table-wrap">
              <table className="data-table num rp-flowtbl">
                <thead>
                  <tr>
                    <th className="sticky-col">주체</th>
                    <th>코스피</th>
                    <th>코스닥</th>
                    <th className="rp-flowtbl-sum">합계</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { label: "외국인", ks: f.kospi.foreign, kq: f.kosdaq.foreign },
                    { label: "기관", ks: f.kospi.institution, kq: f.kosdaq.institution },
                    { label: "개인", ks: f.kospi.individual, kq: f.kosdaq.individual },
                  ].map((it) => {
                    const sum = it.ks + it.kq;
                    const cell = (v: number) => (
                      <span className={signClass(v)}>
                        {v > 0 ? "+" : ""}
                        {fmtNum(v)}
                      </span>
                    );
                    return (
                      <tr key={it.label}>
                        <td className="sticky-col">{it.label}</td>
                        <td>{cell(it.ks)}</td>
                        <td>{cell(it.kq)}</td>
                        <td className="rp-flowtbl-sum">
                          <b>{cell(sum)}</b>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <details className="rp-flowtbl-bars">
              <summary>막대로 보기</summary>
              <div className="report-two-col">
                <div className="ov">
                  <h4 className="report-subheading">코스피</h4>
                  <FlowBars flow={f.kospi} />
                </div>
                <div className="ov">
                  <h4 className="report-subheading">코스닥</h4>
                  <FlowBars flow={f.kosdaq} />
                </div>
              </div>
            </details>
          </>
        ) : (
          <div className="empty">수급 데이터 불러오는 중...</div>
        )}
        <div className="table-note">
          단위 <b>억원</b> · 양수가 순매수입니다. 셋을 더하면 대체로 0 근처인데,
          <b> 한쪽이 사면 다른 쪽이 판 것</b>이기 때문입니다 — 그래서 누가 누구에게
          넘겼는지를 보는 표입니다.
        </div>
        </>
      ),
      moneyFlow: <MoneyFlowSection onSelectStock={onSelectStock} />,
      /* 밤사이 미국에서 무엇이 돌았나가 오늘 국내 무엇이 도는지를 상당 부분 정한다 */
      usThemeMap: <UsThemeMapSection onSelectStock={onSelectStock} />,
      krThemeMap: <KrThemeMapSection onSelectStock={onSelectStock} />,
      themes: (
        <>
        <div className="report-lines">
          {(drivers?.themes.up ?? []).map((t) => (
            <DriverItem
              key={t.code}
              name={t.name}
              rate={t.changeRate}
              sub={`${t.stockCount}종목 · ${t.mainStock}`}
              reasons={t.reasons}
              onOpen={() => setTarget({ kind: "theme", code: t.code, name: t.name })}
            />
          ))}
          {!drivers && <div className="empty">테마 분석 불러오는 중...</div>}
        </div>

        <h4 className="report-subheading negative" style={{ marginTop: 14 }}>
          하락 테마
        </h4>
        <div className="report-lines">
          {(drivers?.themes.down ?? []).map((t) => (
            <DriverItem
              key={t.code}
              name={t.name}
              rate={t.changeRate}
              sub={`${t.stockCount}종목 · ${t.mainStock}`}
              reasons={t.reasons}
              onOpen={() => setTarget({ kind: "theme", code: t.code, name: t.name })}
            />
          ))}
        </div>
        </>
      ),
      sectors: (
        <div className="report-lines">
          {(drivers?.sectors ?? []).map((sec) => (
            <DriverItem
              key={`${sec.market}-${sec.code}`}
              name={sec.name}
              rate={sec.changeRate}
              sub={sec.market}
              reasons={sec.reasons}
              onOpen={
                sec.code
                  ? () =>
                      setTarget({
                        kind: "sector",
                        code: sec.code,
                        name: sec.name,
                        market: sec.market === "코스피" ? "kospi" : "kosdaq",
                      })
                  : undefined
              }
            />
          ))}
          {!drivers && <div className="empty">업종 분석 불러오는 중...</div>}
        </div>
      ),
      /* 내가 든 종목이 어떤지가 없으면 결국 다른 화면을 열게 된다 — 여기서 끝나야 한다 */
      myStocks: <MyStocksSection onSelectStock={onSelectStock} />,
      /* 시스템이 기계적으로 골라 따라가는 목록 — 리포트 본문에도 (2026-08-26) */
      superSignal: <SuperSignalSection onSelectStock={onSelectStock} />,
      crossSignal: <CrossSignalSection onSelectStock={onSelectStock} />,
      featured: <FeaturedSection onSelectStock={onSelectStock} />,
      /* 콤팩트판 — 분야 이름 + 제목만. 본문·검색은 뉴스·공시 메뉴 몫 */
      news: <NewsClippingCompact onFetched={setNewsAt} />,
      channel: <ChannelDigestSection />,
      /* 실물 마감 — 관세청 월별. 크게 움직인 품목만 그래프로 */
      trade: <TradeTrendSection />,
    };
  }
}

/**
 * 오늘 일정 — 리포트 맨 위.
 *
 * 오늘 무엇이 열리는지를 모르고 지수부터 보면 순서가 거꾸로다.
 * **FOMC 가 있는 날과 없는 날은 같은 −1% 도 뜻이 다르다.**
 *
 * 오늘 것을 크게 두고, 다가오는 것은 그 아래에 며칠 남았는지와 함께 몇 줄만 둔다 —
 * 2주치를 다 늘어놓으면 정작 오늘 것이 묻힌다.
 */
function TodayCalendarSection() {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .calendarUpcoming(14)
      .then((r) => setEvents(r.events))
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="empty">일정 불러오는 중…</div>;

  const today = new Date().toISOString().slice(0, 10);
  const mine = events.filter((e) => e.date === today);
  const soon = events.filter((e) => e.date > today).slice(0, 6);

  const dday = (date: string) => {
    const d = Math.round(
      (new Date(date + "T00:00:00").getTime() - new Date(today + "T00:00:00").getTime()) / 86400_000,
    );
    return d === 0 ? "오늘" : `D-${d}`;
  };

  if (mine.length === 0 && soon.length === 0) {
    return (
      <div className="page-note">
        등록된 일정이 없습니다. <b>캘린더</b> 메뉴에서 넣거나 경제 일정을 가져오세요.
      </div>
    );
  }

  return (
    <div className="rp-cal">
      {mine.length === 0 ? (
        <div className="page-note">오늘 잡힌 일정은 없습니다.</div>
      ) : (
        <div className="rp-cal-today">
          {mine.map((e) => (
            <div className={`rp-cal-item kind-${e.kind}`} key={e.id}>
              <span className="rp-cal-kind">{KIND_LABEL[e.kind] ?? e.kind}</span>
              {e.time && <span className="rp-cal-time">{e.time}</span>}
              <span className="rp-cal-title">{e.title}</span>
              {e.memo && <span className="rp-cal-memo">{e.memo}</span>}
            </div>
          ))}
        </div>
      )}

      {soon.length > 0 && (
        <div className="rp-cal-soon">
          <span className="rp-cal-soon-h">다가오는 일정</span>
          {soon.map((e) => (
            <span className="rp-cal-chip" key={e.id}>
              <b>{dday(e.date)}</b> {e.title}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

const KIND_LABEL: Record<string, string> = {
  market: "증시",
  earnings: "실적",
  holiday: "휴장",
  personal: "개인",
};
