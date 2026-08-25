import { Fragment, useEffect, useState } from "react";
import {
  FeaturedSection,
  IndexTrendSection,
  KrThemeMapSection,
  ChannelDigestSection,
  PinnedChannelSection,
  MarketNewsSection,
  MoneyFlowSection,
  MyStocksSection,
  NightFuturesSection,
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
import { ConstituentSheet, type ConstituentTarget } from "../components/overview/ConstituentSheet";
import { FlowBars } from "../components/overview/FlowBars";
import { type MarketDriverReport, type PublishJob, type ScoredNews } from "../api";
import { SectorNews } from "../components/SectorNews";
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

/** 종목 여러 개를 한 줄씩 나열 */
function StockLines({
  rows,
  onSelectStock,
  limit = 10,
}: {
  rows: StockRow[];
  onSelectStock: (code: string, name: string) => void;
  limit?: number;
}) {
  if (rows.length === 0) return <div className="empty">데이터가 없습니다.</div>;
  return (
    <div className="report-lines">
      {rows.slice(0, limit).map((s, i) => {
        const code = normalizeStockCode(s.code);
        return (
          <button className="report-line" key={`${code}-${i}`} onClick={() => onSelectStock(code, s.name)}>
            <span className="rl-name">
              <WatchStar code={code} />
              {s.name}
            </span>
            <span className="rl-price">{fmtNum(s.price)}</span>
            <span className={`rl-rate ${signClass(s.changeRate)}`}>{pct(s.changeRate)}</span>
          </button>
        );
      })}
    </div>
  );
}

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
  const movers = useSection<{ rising: StockRow[]; falling: StockRow[] }>("movers", 60_000);
  const sectors = useSection<{ kospi: SectorRow[]; kosdaq: SectorRow[] }>("sectors", 180_000);
  const themes = useSection<{ top: ThemeRow[]; bottom: ThemeRow[] }>("themes", 180_000);
  const highLow = useSection<{ high: StockRow[]; low: StockRow[] }>("highLow", 300_000);
  const global = useSection<GlobalQuote[]>("global", 60_000);

  function reloadAll() {
    for (const s of [indices, flow, movers, sectors, themes, highLow, global]) s.refresh();
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

      <AiSummaryCard edition={edition} />

      {/*
        일정이 맨 위다.

        오늘 무엇이 열리는지를 모르고 지수부터 보면 순서가 거꾸로다 — FOMC 가 있는 날과
        없는 날은 같은 −1% 도 뜻이 다르다. **오늘 것을 먼저**, 다가오는 것은 그 아래 몇 줄.
      */}
      <Section no={0} title="오늘 일정">
        <TodayCalendarSection />
      </Section>

      <Section no={1} title="복기 — 지난 예측과 실제 결과">
        <ReviewPanel />
      </Section>

      {/*
        조간에 가장 먼저 봐야 할 값이다. 미국 현물은 05:30 에 닫혀 이미 굳었지만
        야간선물은 그 결과를 한국 지수로 환산해 준다 — 오늘 개장가의 예고편이다.
      */}
      {/*
        리포트를 여는 이유가 대개 이 글이다. 이미 한 편으로 정리된 시황이라
        선별에 넣으면 점수 싸움에 밀리고, AI 로 다시 요약하면 그 정리가 사라진다.
      */}
      <Section no={2} title="고정 채널 시황 (원문)">
        <PinnedChannelSection edition={edition} />
      </Section>

      <Section no={3} title="코스피 야간선물 · 환율">
        <NightFuturesSection />
      </Section>

      {/* 2. 국내외 주요 지수 */}
      <Section no={4} title="국내외 주요 지수">
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th className="sticky-col">지수/종목</th>
                <th>현재가</th>
                <th>전일대비</th>
                <th>등락률</th>
              </tr>
            </thead>
            <tbody>
              {idx.map((c) => (
                <tr key={c.name}>
                  <td className="sticky-col">{c.name}</td>
                  <td>{fmtNum(c.price)}</td>
                  <td className={signClass(c.change)}>{fmtNum(c.change)}</td>
                  <td className={signClass(c.changeRate)}>{pct(c.changeRate)}</td>
                </tr>
              ))}
              {/*
                섹터별로 묶는다. 시황 대시보드와 같은 방식이다 — 두 화면이 같은 값을
                다르게 늘어놓으면 하나를 보고 다른 하나를 찾을 때 헷갈린다.
              */}
              {[...new Set(g.map((q) => q.group))].map((grp) => {
                // 시황과 **같은 색**을 쓴다. 서버가 정해 준 것을 그대로 받는다 —
                // 두 화면이 같은 값을 다른 색으로 칠하면 하나 보고 다른 하나를 못 찾는다
                const color = g.find((q) => q.group === grp)?.color ?? "#8b98a5";
                return (
                <Fragment key={grp}>
                  <tr className="rp-g-sec" style={{ ["--g" as string]: color }}>
                    <td className="sticky-col" colSpan={4}>
                      {grp}
                    </td>
                  </tr>
                  {g
                    .filter((q) => q.group === grp)
                    .map((q) => (
                      <tr key={q.key} style={{ ["--g" as string]: color }} className="rp-g-row">
                        <td className="sticky-col">
                          <span
                            className={`ov-g-sig${q.signal ? ` ${q.signal.level}` : ""}`}
                            title={q.signal?.why}
                          />
                          {q.label}
                          <span className="rl-sub"> {q.symbol}</span>
                        </td>
                        <td>{q.price === null ? "-" : fmtNum(q.price)}</td>
                        <td className={signClass(q.change)}>
                          {q.change === null ? "-" : fmtNum(q.change)}
                        </td>
                        <td className={signClass(q.changeRate)}>
                          {q.changeRate === null ? "-" : pct(q.changeRate)}
                        </td>
                      </tr>
                    ))}
                </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      {/* 2. 투자자 수급 — 시황 대시보드와 같은 막대 그래프를 시장별로 */}
      {/*
        숫자만으로는 "오늘 -1.5%" 가 어디쯤에서 난 하락인지 모른다.
        고점에서 흘러내리는 중인지 바닥에서 튀는 중인지가 판단을 가른다.
      */}
      <Section no={5} title="코스피 · 코스닥 추이 (60거래일)">
        <IndexTrendSection />
      </Section>

      <Section no={6} title="투자자별 매매 동향">
        {/*
          **표 하나로 줄였다.**

          예전엔 막대 그래프 둘이 나란히 자리를 크게 먹고, 정작 궁금한 합계는 맨 밑에 있었다.
          숫자를 보러 온 자리인데 숫자가 제일 뒤였다.

          이제 한 표다 — 줄이 주체(외국인·기관·개인), 칸이 시장(코스피·코스닥·합계).
          **합계를 오른쪽 끝에 두고 굵게** 둔다. 시장별로 나뉘어 있으니 어디서 나온 돈인지도 보인다.
          막대는 접어 뒀다. 모양으로 훑고 싶을 때만 편다.
        */}
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
      </Section>

      {/* 3. 특징 테마 — 왜 올랐는지 관련 기사까지 */}
      <Section no={7} title="시장 자금 흐름 (업종별 5일 누적)">
        <MoneyFlowSection onSelectStock={onSelectStock} />
      </Section>

      {/*
        밤사이 미국에서 무엇이 돌았나가 오늘 국내 무엇이 도는지를 상당 부분 정한다.
        반도체가 밤에 빠졌으면 아침에 국내 반도체도 빠진 채로 시작한다.
      */}
      <Section no={8} title="미국 테마 MAP">
        <UsThemeMapSection onSelectStock={onSelectStock} />
      </Section>

      <Section no={9} title="국내 테마 MAP">
        <KrThemeMapSection onSelectStock={onSelectStock} />
      </Section>

      <Section no={10} title="특징 테마 (상승 이유 포함)">
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
      </Section>

      {/* 4. 강한 업종 — 이유 포함 */}
      <Section no={11} title="강한 업종 (상승 이유 포함)">
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
      </Section>

      {/* 5. 특징 종목 */}
      <Section no={12} title="특징 종목 (급등/급락)">
        <div className="report-two-col">
          <div>
            <h4 className="report-subheading positive">상승률 상위</h4>
            <StockLines rows={movers.data?.rising ?? []} onSelectStock={onSelectStock} />
          </div>
          <div>
            <h4 className="report-subheading negative">하락률 상위</h4>
            <StockLines rows={movers.data?.falling ?? []} onSelectStock={onSelectStock} />
          </div>
        </div>
      </Section>

      {/* 6. 신고가/신저가 */}
      <Section no={13} title="52주(250일) 신고가 · 신저가">
        <div className="report-two-col">
          <div>
            <h4 className="report-subheading positive">신고가</h4>
            <StockLines rows={highLow.data?.high ?? []} onSelectStock={onSelectStock} limit={8} />
          </div>
          <div>
            <h4 className="report-subheading negative">신저가</h4>
            <StockLines rows={highLow.data?.low ?? []} onSelectStock={onSelectStock} limit={8} />
          </div>
        </div>
      </Section>

      {/* 7. 뉴스 클리핑 — 분야별 (뉴스·공시 탭과 같은 컴포넌트) */}
      {/*
        오늘 볼 만한 종목. 세 갈래는 성격이 다르다 — 신호등은 조건을 갖춘 것,
        신고가는 이미 올라간 것, 급등은 오늘 움직인 것. 섞으면 뭘 보는지 모르게 된다.
      */}
      {/*
        리포트가 시장 전체를 아무리 잘 정리해도 내가 든 종목이 어떤지가 없으면
        결국 다른 화면을 열게 된다. 여기서 끝나야 한다.
      */}
      <Section no={14} title="내 관심종목">
        <MyStocksSection onSelectStock={onSelectStock} />
      </Section>

      <Section no={15} title="특징주">
        <FeaturedSection onSelectStock={onSelectStock} />
      </Section>

      <Section no={16} title="주요 뉴스 클리핑 (종목·테마)">
        <SectorNews perSector={20} onFetched={setNewsAt} />
      </Section>

      {/*
        AI 정리에 이미 녹아 있지만 원문도 같이 둔다 — 요약이 무엇을 보고 그렇게 말했는지
        확인할 데가 있어야 요약을 믿거나 의심할 수 있다.
      */}
      <Section no={17} title="텔레그램 채널 요약">
        <ChannelDigestSection />
      </Section>

      {/*
        위 클리핑은 종목·테마에 붙은 뉴스고 이건 시장 전체 뉴스다 — 겹쳐 보여도
        둘 다 있는 게 낫다는 판단이다.
      */}
      <Section no={18} title="국내외 주요 뉴스">
        <MarketNewsSection edition={edition} />
      </Section>

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
