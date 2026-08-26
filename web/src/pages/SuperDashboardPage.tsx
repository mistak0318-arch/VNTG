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
                <SortableTh
                  columnKey="state"
                  label="상태"
                  accessor={(e: SuperEntry) => (e.active !== false ? 1 : 0)}
                  sort={sort}
                />
                <SortableTh columnKey="name" label="종목" accessor={(e: SuperEntry) => e.name} sort={sort} />
                <SortableTh
                  columnKey="added"
                  label="편입일"
                  accessor={(e: SuperEntry) => e.addedDate}
                  sort={sort}
                />
                <SortableTh
                  columnKey="seen"
                  label="반복"
                  accessor={(e: SuperEntry) => e.seenCount}
                  sort={sort}
                />
                <SortableTh
                  columnKey="lists"
                  label="목록"
                  accessor={(e: SuperEntry) => e.lists.length}
                  sort={sort}
                />
                <SortableTh
                  columnKey="score"
                  label="점수"
                  accessor={(e: SuperEntry) => e.score}
                  sort={sort}
                />
                <th>점수 흐름</th>
                <SortableTh
                  columnKey="price"
                  label="현재가"
                  accessor={(e: SuperEntry) => e.price ?? -1}
                  sort={sort}
                />
                <SortableTh
                  columnKey="since"
                  label="편입 대비"
                  accessor={(e: SuperEntry) => e.sinceAdded ?? -9999}
                  sort={sort}
                />
                <th>주가 흐름</th>
                <SortableTh
                  columnKey="d1"
                  label="+1일"
                  accessor={(e: SuperEntry) => e.returns?.d1 ?? -9999}
                  sort={sort}
                />
                <SortableTh
                  columnKey="d5"
                  label="+5일"
                  accessor={(e: SuperEntry) => e.returns?.d5 ?? -9999}
                  sort={sort}
                />
                <SortableTh
                  columnKey="d20"
                  label="+20일"
                  accessor={(e: SuperEntry) => e.returns?.d20 ?? -9999}
                  sort={sort}
                />
                <th>메모</th>
              </tr>
            </thead>
            <tbody>
              {sort.sorted.map((e) => {
                const daily = e.daily ?? [];
                const nowScore = daily.length > 0 ? daily[daily.length - 1].score : null;
                const scoreDelta = nowScore !== null ? nowScore - e.score : null;
                return (
                  <tr
                    key={e.code}
                    className={`sd-row${e.active === false ? " exited" : ""}`}
                    onClick={() => {
                      setDetail({ code: e.code, name: e.name });
                      publish(e.code, e.name);
                    }}
                  >
                    <td>{e.active !== false ? "🟢" : "⛔"}</td>
                    <td className="sticky-col">
                      <b>{e.name}</b> <span className="pt-n">{e.code}</span>
                    </td>
                    <td>{e.addedDate.slice(5)}</td>
                    <td className="num">{e.seenCount}일</td>
                    <td className="num">{e.lists.length}곳</td>
                    <td className="num">
                      {e.score}
                      {scoreDelta !== null && scoreDelta !== 0 && (
                        <i className={scoreDelta > 0 ? "positive" : "negative"}>
                          {" "}
                          →{nowScore}
                        </i>
                      )}
                    </td>
                    <td>
                      <Spark values={daily.map((d) => d.score)} color="var(--green)" />
                    </td>
                    <td className="num">{e.price ? e.price.toLocaleString("ko-KR") : "-"}</td>
                    <td className={`num strong-col ${cls(e.sinceAdded)}`}>{pct(e.sinceAdded)}</td>
                    <td>
                      <Spark
                        values={daily.map((d) => (d.close > 0 ? d.close : null))}
                        color="var(--blue)"
                        refY={e.addedPrice}
                      />
                    </td>
                    <td className={`num ${cls(e.returns?.d1)}`}>{pct(e.returns?.d1)}</td>
                    <td className={`num ${cls(e.returns?.d5)}`}>{pct(e.returns?.d5)}</td>
                    <td className={`num ${cls(e.returns?.d20)}`}>{pct(e.returns?.d20)}</td>
                    <td className="sd-note-cell" title={e.note || ""}>
                      {(e.exits ?? []).length > 0 && "⛔"}
                      {e.note && "📝"}
                    </td>
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
