import { useEffect, useState } from "react";
import {
  api,
  type SuperEntry,
  type SuperGradeRow,
  type SuperStats,
} from "../api";
import { Spark } from "../components/MiniLine";
import { SuperDetailSheet } from "../components/SuperDetailSheet";
import { RefreshBar } from "../components/RefreshBar";
import { SortableTh, useSortableTable } from "../useSortableTable";
import { useCardOrder } from "../useCardOrder";
import { useStockFocus } from "../useStockFocus";

/**
 * 슈퍼신호등 대시보드 (2026-08-26) — **이 체계가 정말 돈이 되는지 검증하는 자리.**
 *
 * 신호등 찾기의 슈퍼신호등 탭이 「오늘 뭐가 걸렸나」라면, 여기는 「걸린 것들이
 * 그 뒤로 어떻게 됐나」다. 편입 시점의 점수·가격을 못 박아 두고, 이후의 주가·점수·
 * 수급·시장을 따라가면서 세 가지에 답한다:
 *
 *   ① 지금 추적 중인 종목들은 어떤 상태인가        — 표
 *   ② 편입하면 며칠 뒤 얼마나 벌리나 (체계 검증)     — 요약 카드 + 채점표
 *   ③ 개별 종목은 왜 잘됐고 왜 이탈했나 (복기)      — 상세 시트 (이탈 기록·메모)
 */

const pct = (v: number | null | undefined, digits = 1): string =>
  v === null || v === undefined ? "-" : `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`;

const cls = (v: number | null | undefined): string =>
  v === null || v === undefined ? "" : v >= 0 ? "positive" : "negative";

function GradeCell({ g }: { g: { avg: number | null; n: number } }) {
  return (
    <td className={`num ${cls(g.avg)}`}>
      {g.avg === null ? "-" : pct(g.avg)}
      <span className="pt-n"> ({g.n})</span>
    </td>
  );
}

/**
 * 표의 열 정의 (2026-08-31 — "열이 꽤 많아졌으니 강조할 부분들이 강조해서
 * 표시해야 눈에 띌듯. 그리고 표 순서도 변경가능하게").
 *
 * 열을 JSX 로 흩어 두면 **순서를 바꿀 수가 없다** — 머리와 몸이 같은 순서여야
 * 하는데 둘이 따로 적혀 있으면 한쪽만 옮겨져 표가 어긋난다. 배열 하나로 두고
 * 머리·몸이 같은 배열을 돈다.
 *
 * `emph` 는 **눈이 먼저 가야 하는 열**이다. 열다섯 개가 같은 무게로 있으면
 * 아무것도 안 보인다 — 성적(편입 대비·지수 대비)과 지금 상태(당일)만 굵게 둔다.
 */
interface Ctx {
  crossOnly: boolean;
  daily: NonNullable<SuperEntry["daily"]>;
  nowScore: number | null;
  scoreDelta: number | null;
}

interface Col {
  key: string;
  label: string;
  hint?: string;
  /** 눈이 먼저 가야 하는 열 — 굵게, 배경으로 살짝 띄운다 */
  emph?: boolean;
  /** 숫자 열 — 오른쪽 정렬 */
  num?: boolean;
  sortable?: boolean;
  accessor?: (e: SuperEntry) => string | number;
  cell: (e: SuperEntry, x: Ctx) => React.ReactNode;
  /** 값에 따라 색을 입힌다 (등락) */
  tone?: (e: SuperEntry) => number | null | undefined;
}

const COLS: Col[] = [
  {
    key: "state",
    label: "상태",
    accessor: (e) => (e.active !== false ? 1 : 0),
    cell: (e) => (e.active !== false ? "🟢" : "⛔"),
  },
  {
    key: "name",
    label: "종목",
    accessor: (e) => e.name,
    cell: (e) => (
      <>
        <b>{e.name}</b>{" "}
        {/* 어느 그룹에서 온 종목인지 — 🌟 슈퍼 원장 · ⚡ 교차 그룹 */}
        {e.groupTags?.includes("super") && <span title="슈퍼신호등 원장 (교집합 편입)">🌟</span>}
        {e.groupTags?.includes("cross") && (
          <span title="관심 그룹 「슈퍼신호등+교차」 (맥박 교차 자동 편입)">⚡</span>
        )}{" "}
        <span className="pt-n">{e.code}</span>
      </>
    ),
  },
  {
    key: "added",
    label: "편입일",
    accessor: (e) => e.addedDate,
    cell: (e) => (
      <>
        {e.addedDate.slice(5)}
        {/* 오늘 편입 — 첫날에만 붙는다 */}
        {e.isNew && (
          <span className="ss-new" title="오늘 편입됐습니다">
            N
          </span>
        )}
      </>
    ),
  },
  {
    key: "seen",
    label: "반복",
    hint: "교집합에 걸린 날이 몇 번인가 — 편입 후 며칠과는 다른 값입니다",
    num: true,
    accessor: (e) => e.seenCount,
    cell: (e, x) => (x.crossOnly ? "-" : `${e.seenCount}일`),
  },
  {
    key: "dsince",
    label: "경과",
    hint: "편입일로부터 며칠 — 편입 당일은 0일",
    num: true,
    accessor: (e) => e.daysSince ?? 0,
    cell: (e) => `${e.daysSince ?? 0}일`,
  },
  {
    key: "lists",
    label: "목록",
    num: true,
    accessor: (e) => e.lists.length,
    cell: (e, x) => (x.crossOnly ? "-" : `${e.lists.length}곳`),
  },
  {
    key: "score",
    label: "점수",
    num: true,
    accessor: (e) => e.score,
    cell: (e, x) =>
      x.crossOnly ? (
        "-"
      ) : (
        <>
          {e.score}
          {x.scoreDelta !== null && x.scoreDelta !== 0 && (
            <i className={x.scoreDelta > 0 ? "positive" : "negative"}> →{x.nowScore}</i>
          )}
        </>
      ),
  },
  {
    key: "spark",
    label: "점수 흐름",
    sortable: false,
    cell: (_e, x) => <Spark values={x.daily.map((d) => d.score)} color="var(--green)" />,
  },
  {
    key: "price",
    label: "현재가",
    num: true,
    accessor: (e) => e.price ?? -1,
    cell: (e) => (e.price ? e.price.toLocaleString("ko-KR") : "-"),
  },
  {
    key: "today",
    label: "당일",
    num: true,
    emph: true,
    accessor: (e) => e.changeRate ?? -9999,
    tone: (e) => e.changeRate,
    cell: (e) => pct(e.changeRate),
  },
  {
    key: "theme",
    label: "테마",
    hint: "든 네이버 테마 중 오늘 가장 강한 것 — 식으면 이탈이 가깝다",
    accessor: (e) => e.theme?.changeRate ?? -9999,
    cell: (e) =>
      e.theme ? (
        <>
          <span className="sd-theme-name">{e.theme.name}</span>{" "}
          <b className={cls(e.theme.changeRate)}>{pct(e.theme.changeRate)}</b>
          {e.theme.streak >= 2 && <i className="lens-streak">{e.theme.streak}일↑</i>}
        </>
      ) : (
        "-"
      ),
  },
  {
    key: "etfBack",
    label: "ETF 뒷배",
    hint: "테마로 담은 상위 3 ETF 의 오늘 평균 (신호등 뒷배와 같은 규칙)",
    num: true,
    accessor: (e) => e.etfBack?.rate ?? -9999,
    tone: (e) => e.etfBack?.rate,
    cell: (e) => (e.etfBack ? pct(e.etfBack.rate) : "-"),
  },
  {
    key: "since",
    label: "편입 대비",
    num: true,
    emph: true,
    accessor: (e) => e.sinceAdded ?? -9999,
    tone: (e) => e.sinceAdded,
    cell: (e) => pct(e.sinceAdded),
  },
  {
    key: "priceSpark",
    label: "주가 흐름",
    sortable: false,
    cell: (e, x) => (
      <Spark
        values={x.daily.map((d) => (d.close > 0 ? d.close : null))}
        color="var(--blue)"
        refY={e.addedPrice}
      />
    ),
  },
  {
    key: "d1",
    label: "+1일",
    num: true,
    accessor: (e) => e.returns?.d1 ?? -9999,
    tone: (e) => e.returns?.d1,
    cell: (e) => pct(e.returns?.d1),
  },
  {
    key: "d5",
    label: "+5일",
    num: true,
    accessor: (e) => e.returns?.d5 ?? -9999,
    tone: (e) => e.returns?.d5,
    cell: (e) => pct(e.returns?.d5),
  },
  {
    key: "d20",
    label: "+20일",
    num: true,
    accessor: (e) => e.returns?.d20 ?? -9999,
    tone: (e) => e.returns?.d20,
    cell: (e) => pct(e.returns?.d20),
  },
  /*
   * **지수 대비** (2026-08-31) — 이 열이 없으면 위의 +1/+5/+20 은 뜻이 없다.
   * 「+1일 -0.13%」가 나쁜 건지는 그날 시장을 알아야 답할 수 있다. 강조한다.
   */
  {
    key: "ex1",
    label: "지수 대비 +1",
    hint: "같은 날짜 코스피 수익률을 뺀 값(%p) — 「남보다 나았나」",
    num: true,
    emph: true,
    accessor: (e) => e.excess?.d1 ?? -9999,
    tone: (e) => e.excess?.d1,
    cell: (e) => pp(e.excess?.d1),
  },
  {
    key: "ex5",
    label: "지수 대비 +5",
    hint: "같은 날짜 코스피 수익률을 뺀 값(%p)",
    num: true,
    accessor: (e) => e.excess?.d5 ?? -9999,
    tone: (e) => e.excess?.d5,
    cell: (e) => pp(e.excess?.d5),
  },
  {
    key: "ex20",
    label: "지수 대비 +20",
    hint: "같은 날짜 코스피 수익률을 뺀 값(%p)",
    num: true,
    accessor: (e) => e.excess?.d20 ?? -9999,
    tone: (e) => e.excess?.d20,
    cell: (e) => pp(e.excess?.d20),
  },
  /*
   * **이탈 후** — 이탈 규칙이 맞았는지 재는 유일한 길이다.
   * 부호는 이탈한 사람 관점: 양수면 「나오고 나서 올랐다(아까웠다)」.
   * 그래서 색을 **뒤집는다** — 올랐으면 빨강이 아니라 아쉬움이다.
   */
  {
    key: "ax5",
    label: "이탈 후 +5",
    hint: "이탈일 종가 대비 — 양수면 나오고 나서 올랐다는 뜻(이탈이 일렀다)",
    num: true,
    accessor: (e) => e.afterExit?.d5 ?? -9999,
    cell: (e) =>
      e.afterExit?.d5 == null ? (
        "-"
      ) : (
        <span className={e.afterExit.d5 > 0 ? "negative" : "positive"}>{pct(e.afterExit.d5)}</span>
      ),
  },
  {
    key: "ax20",
    label: "이탈 후 +20",
    hint: "이탈일 종가 대비 — 양수면 나오고 나서 올랐다는 뜻(이탈이 일렀다)",
    num: true,
    accessor: (e) => e.afterExit?.d20 ?? -9999,
    cell: (e) =>
      e.afterExit?.d20 == null ? (
        "-"
      ) : (
        <span className={e.afterExit.d20 > 0 ? "negative" : "positive"}>{pct(e.afterExit.d20)}</span>
      ),
  },
  {
    key: "note",
    label: "메모",
    sortable: false,
    cell: (e) => (
      <>
        {(e.exits ?? []).length > 0 && "⛔"}
        {e.note && "📝"}
      </>
    ),
  },
];

/** 칸의 클래스 — 숫자·강조·등락색을 한자리에서 정한다 */
function cellCls(c: Col, e: SuperEntry): string {
  const bits: string[] = [];
  if (c.num) bits.push("num");
  if (c.emph) bits.push("sd-emph");
  if (c.key === "name") bits.push("sticky-col");
  if (c.key === "theme") bits.push("sd-theme-cell");
  if (c.key === "note") bits.push("sd-note-cell");
  if (c.tone) {
    const v = c.tone(e);
    if (v !== null && v !== undefined && Number.isFinite(v)) bits.push(cls(v));
  }
  return bits.join(" ");
}

/** %p — 초과수익은 퍼센트포인트다. %와 섞이면 둘 다 못 읽는다 */
function pp(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "-";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%p`;
}

export function SuperDashboardPage({
  onSelectStock,
}: {
  onSelectStock: (code: string, name: string) => void;
}) {
  const [entries, setEntries] = useState<SuperEntry[]>([]);
  const [grade, setGrade] = useState<SuperGradeRow[]>([]);
  const [stats, setStats] = useState<SuperStats | null>(null);
  const [lastRun, setLastRun] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ code: string; name: string } | null>(null);
  const [showExited, setShowExited] = useState(true);
  /*
   * 창 연동 (2026-08-27 — 「슈퍼신호등에서 종목 클릭하면 보드판에 반영이 안 되네」).
   * 종목 고르는 길은 원래 App.onSelectStock 하나로 모이는데, 이 표의 행 클릭은
   * 슈퍼 전용 시트를 열려고 그 길을 안 지난다 — 그래서 연동 전파만 따로 얹는다.
   * StockDetail 모달은 안 띄운다(이 화면의 본체는 슈퍼 상세 시트다). 연동이
   * 꺼져 있으면 publish 가 스스로 아무 일도 하지 않는다.
   */
  const { publish } = useStockFocus();

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = await api.signalSuper();
      setEntries(r.entries);
      setGrade(r.grade);
      setStats(r.stats);
      setLastRun(r.lastRunDate);
    } catch (e) {
      setError(e instanceof Error ? e.message : "불러오기 실패");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const visible = showExited ? entries : entries.filter((e) => e.active !== false);
  /*
   * 기본 정렬 = **지금 점수 높은 순** (2026-08-27 사용자 지정 "점수높은순으로").
   * 점수는 일별 기록의 마지막(오늘 자)이 있으면 그걸, 없으면 편입 점수를 쓴다 —
   * 지금 센 놈이 위로 오는 게 보는 목적에 맞다. 추적 중이 이탈보다 먼저다.
   * 머리 클릭 정렬은 이 위에 얹힌다(3번째 클릭 「원래 순서」= 이 순서).
   */
  const nowScoreOf = (e: SuperEntry): number => {
    const daily = e.daily ?? [];
    return daily.length > 0 ? daily[daily.length - 1].score : e.score;
  };
  const ranked = [...visible].sort((a, b) => {
    const act = Number(b.active !== false) - Number(a.active !== false);
    if (act !== 0) return act;
    return nowScoreOf(b) - nowScoreOf(a);
  });
  /*
   * 열 순서는 **사용자가 바꾼다** (2026-08-31 — "나중에 보는 우선순위가
   * 달라질 수도 있으니깐"). 시세분석 표와 같은 훅·같은 저장소(서버, 기기 공유).
   * ⚠️ 머리와 몸이 **같은 배열**을 돌아야 한다 — 따로 적으면 한쪽만 옮겨져 표가 어긋난다.
   */
  const colOrder = useCardOrder("super.cols", COLS.map((c) => c.key));
  const orderedCols = [...COLS].sort((a, b) => colOrder.orderOf(a.key) - colOrder.orderOf(b.key));

  const sort = useSortableTable(ranked);

  /* 승률 카드의 게이지 — 50% 가 동전 던지기 선이다 */
  const winBar = (w: { rate: number | null; n: number }) => (
    <div className="sd-win">
      <div className="sd-win-bar">
        <span style={{ width: `${w.rate ?? 0}%` }} />
        <i className="sd-win-half" />
      </div>
      <b>{w.rate === null ? "-" : `${w.rate.toFixed(0)}%`}</b>
      <span className="pt-n">{w.n}건</span>
    </div>
  );

  return (
    <div>
      <RefreshBar onRefresh={load} loading={loading} />
      {error && <div className="error-banner">{error}</div>}

      <p className="page-note">
        매일 15:45, 일곱 목록의 <b>교집합에 걸린 초록</b>을 편입해 따라갑니다. 편입 시점을
        못 박아 두고 이후 주가·점수·수급·시장을 기록합니다 — <b>슈퍼신호등 체계 자체를
        검증하는 자리</b>입니다. {lastRun && <>마지막 편입 실행 {lastRun}.</>}
      </p>

      {/* ── 요약 카드 ─────────────────────────────────── */}
      {stats && (
        <div className="sd-cards">
          <div className="sd-card">
            <span className="sd-card-label">추적 중</span>
            <b className="sd-card-big">{stats.activeCount}</b>
            <span className="pt-n">오늘 신규 {stats.todayAdded}</span>
          </div>
          <div className="sd-card">
            <span className="sd-card-label">이탈</span>
            <b className="sd-card-big">{stats.exitedCount}</b>
            <span className="pt-n">기록은 남습니다</span>
          </div>
          <div className="sd-card">
            <span className="sd-card-label">5일 뒤 승률</span>
            {winBar(stats.win.d5)}
          </div>
          <div className="sd-card">
            <span className="sd-card-label">20일 뒤 승률</span>
            {winBar(stats.win.d20)}
          </div>
          {(stats.best || stats.worst) && (
            <div className="sd-card">
              <span className="sd-card-label">20일 최고 / 최악</span>
              <span className="sd-card-line">
                {stats.best && (
                  <>
                    <b className="positive">{pct(stats.best.v)}</b> {stats.best.name}
                  </>
                )}
              </span>
              <span className="sd-card-line">
                {stats.worst && (
                  <>
                    <b className="negative">{pct(stats.worst.v)}</b> {stats.worst.name}
                  </>
                )}
              </span>
            </div>
          )}
        </div>
      )}

      {/* ── 체계 채점표 ───────────────────────────────── */}
      {grade.length > 0 && (
        <section className="card sd-grade">
          <h3>편입 후 평균 수익률 — 교집합이 넓을수록, 오래 걸릴수록 진짜인가</h3>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>구간</th>
                  <th>1일 뒤</th>
                  <th>5일 뒤</th>
                  <th>20일 뒤</th>
                </tr>
              </thead>
              <tbody>
                {grade.map((g) => (
                  <tr key={g.label}>
                    <td>{g.label}</td>
                    <GradeCell g={g.d1} />
                    <GradeCell g={g.d5} />
                    <GradeCell g={g.d20} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="pt-n sd-hint">
            괄호는 표본 수 — 표본이 적을 때의 평균은 참고만. 「목록 4곳 이상」과 「이틀 이상
            반복」이 전체보다 좋아야 교집합·지속성 가설이 맞는 것입니다.
          </p>
        </section>
      )}

      {/* ── 종목 표 ──────────────────────────────────── */}
      <div className="filter-row">
        <button className={`filter-btn ${showExited ? "active" : ""}`} onClick={() => setShowExited((v) => !v)}>
          이탈 포함 {showExited ? "켬" : "끔"}
        </button>
        <span className="pt-n">행을 누르면 흐름 상세(주가·점수·수급·이탈 기록)가 열립니다</span>
      </div>

      {entries.length === 0 && !loading && (
        <div className="empty">
          아직 편입된 종목이 없습니다 — 평일 15:45 에 자동으로 뽑습니다. 신호등 찾기 &gt;
          슈퍼신호등 탭에서 「지금 돌리기」로 바로 돌릴 수도 있습니다.
        </div>
      )}

      {visible.length > 0 && (
        <div className="data-table-wrap">
          <table className="data-table sd-table">
            <thead>
              <tr>
                {orderedCols.map((c) =>
                  c.sortable === false ? (
                    <th
                      key={c.key}
                      className={c.emph ? "sd-emph" : undefined}
                      title={c.hint}
                      {...colOrder.drag.props(c.key)}
                    >
                      {c.label}
                    </th>
                  ) : (
                    <SortableTh
                      key={c.key}
                      columnKey={c.key}
                      label={c.label}
                      accessor={c.accessor!}
                      sort={sort}
                      className={`${c.emph ? "sd-emph " : ""}${colOrder.drag.cls(c.key)}`}
                      thProps={{ title: c.hint, ...colOrder.drag.props(c.key) }}
                    />
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {sort.sorted.map((e) => {
                const daily = e.daily ?? [];
                const nowScore = daily.length > 0 ? daily[daily.length - 1].score : null;
                const scoreDelta = nowScore !== null ? nowScore - e.score : null;
                /* 교차 그룹에서만 온 줄 — 슈퍼 원장(점수·이탈 체계)이 없어 관찰만 한다 */
                const crossOnly = e.groupTags != null && !e.groupTags.includes("super");
                return (
                  <tr
                    key={e.code}
                    className={`sd-row${e.active === false ? " exited" : ""}`}
                    onClick={() => {
                      /* 교차 전용은 슈퍼 상세가 없다 — 종목 상세(연동 포함)로 */
                      if (crossOnly) onSelectStock(e.code, e.name);
                      else {
                        setDetail({ code: e.code, name: e.name });
                        publish(e.code, e.name);
                      }
                    }}
                  >
                    {orderedCols.map((c) => (
                      <td key={c.key} className={cellCls(c, e)}>
                        {c.cell(e, { crossOnly, daily, nowScore, scoreDelta })}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {detail && (
        <SuperDetailSheet
          code={detail.code}
          name={detail.name}
          onClose={() => setDetail(null)}
          onOpenStock={onSelectStock}
          onChanged={() => void load()}
        />
      )}
    </div>
  );
}
