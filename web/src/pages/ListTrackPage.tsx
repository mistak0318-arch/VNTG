import { useCallback, useEffect, useState } from "react";
import { api, type ListTrackSummary, type ListEntry } from "../api";

/**
 * 접기 — **기기별로 기억한다** (2026-08-31 — "이것들 좀 접는 구조 좀 만들어주라
 * 칸을 많이 차지해").
 *
 * 슈퍼신호등 채점표(`GradeBoard`)와 같은 문법이다. 접힌 상태에서도 **제일 중요한
 * 한 줄은 보인다** — 펴 볼지 판단할 근거가 있어야 한다.
 */
function useFold(key: string, initial = false) {
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(`vntg.lt.${key}`);
      return v === null ? initial : v === "1";
    } catch {
      return initial;
    }
  });
  /** 값을 못 박는다 — 「전체 펼치기」가 이걸 쓴다 */
  const set = (v: boolean) => {
    setOpen(v);
    try {
      localStorage.setItem(`vntg.lt.${key}`, v ? "1" : "0");
    } catch {
      /* 못 적으면 다음에 원래대로일 뿐 */
    }
  };
  const toggle = () => set(!open);
  return [open, toggle, set] as const;
}

/** 등락 색 — 0 은 색을 안 준다 */
const cls = (v: number | null | undefined): string =>
  v === null || v === undefined || !Number.isFinite(v) ? "" : v > 0 ? "positive" : v < 0 ? "negative" : "";
import { SuperMark } from "../useSuperMarks";
import { WatchStar } from "../useWatchedCodes";

/**
 * 신호등 분석 — **목록별 단독 추적.**
 *
 * ## 왜 이 화면이 있나
 *
 * 슈퍼신호등을 표본으로 되짚었더니 **앞문(교집합)이 값을 안 했다** — 교집합만
 * 초과 +0.28%p, 초록만 +1.40%p, 둘 다 +1.36%p. 그런데 그건 **근사**였다:
 * 일곱 목록 중 여섯만 되살렸고 순위도 표본 안에서 매겼다.
 *
 * 근사로는 거기까지다. **실제로 두 원장을 나란히 쌓아야** 답이 난다:
 *
 *   이 화면      각 목록 상위 500 → 초록이면 편입 (교집합 안 봄)
 *   슈퍼신호등    같은 목록들 → 3곳 이상 교집합 → 초록이면 편입
 *
 * 편입·이탈 규칙이 **똑같다.** 그래야 두 원장의 차이가 「교집합을 봤나 안 봤나」
 * 하나로 좁혀진다. 몇 달 뒤 두 성적을 견주면 근사가 아닌 답이 나온다.
 *
 * ## 상한이 없다
 *
 * 슈퍼신호등은 교집합 통과분 중 40개만 신호등을 잰다 — 넘치면 **초록이었을 수도
 * 있는데 재보지도 못하고** 잘린다. 여기는 합집합 전체를 잰다(1,200~1,800종목).
 * 40분쯤 걸리지만 장 마감 후 백그라운드라 상관없다.
 */

export function ListTrackPage({
  onSelectStock,
}: {
  onSelectStock: (code: string, name: string) => void;
}) {
  const [data, setData] = useState<ListTrackSummary | null>(null);
  const [job, setJob] = useState<{
    status: string;
    step: string;
    done: number;
    total: number;
    added: number;
    counts?: Record<string, { universe: number; green: number }>;
  } | null>(null);
  const [tab, setTab] = useState<string>("");
  const [showExited, setShowExited] = useState(false);
  const [openSum, toggleSum, setSum] = useFold("summary", true);
  const [openGrade, toggleGrade, setGrade] = useFold("grade", false);
  /*
   * **전체 펼치기/접기** (2026-08-31 — "전체보기도 만들어야지 화면에 일일히 다
   * 누를 수는 없잖아"). 접는 칸이 늘수록 하나씩 펴는 게 더 불편해진다.
   *
   * 하나라도 접혀 있으면 「전체 펼치기」, 다 펴져 있으면 「전체 접기」로 바뀐다 —
   * 버튼이 지금 무엇을 할지 스스로 말해야 한다.
   */
  const allOpen = openSum && openGrade;
  const setAll = (v: boolean) => {
    setSum(v);
    setGrade(v);
  };
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .listTrack()
      .then((r) => {
        setData(r);
        setTab((t) => t || r.byList[0]?.key || "");
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    load();
    const t = window.setInterval(() => {
      api
        .listTrackJob()
        .then((j) => {
          setJob(j.status === "idle" ? null : j);
          /* 끝나면 원장을 다시 받는다 — 안 그러면 새 편입이 화면에 안 뜬다 */
          if (j.status === "done") load();
        })
        .catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(t);
  }, [load]);

  if (err) return <div className="error-banner">{err}</div>;
  if (!data) return <div className="empty">불러오는 중…</div>;

  const mine = data.entries.filter((e) => e.list === tab);
  const visible = mine
    .filter((e) => showExited || e.active !== false)
    .sort((a, b) => b.addedDate.localeCompare(a.addedDate) || a.rank - b.rank);
  const counts = data.counts[tab];

  return (
    <div className="lt">
      <p className="page-note">
        <b>일곱 목록에서 각각 상위 500종목</b>을 받아 <b>신호등이 초록</b>인 것을 전부
        담습니다 — <b>교집합을 안 봅니다.</b> 편입·이탈 규칙은 슈퍼신호등과 똑같아서,
        두 원장의 차이가 <b>「교집합을 봤나 안 봤나」 하나</b>로 좁혀집니다.
        <br />
        매일 <b>16:30</b> 자동 실행 · 마지막 {data.lastRunDate ?? "아직 없음"}
      </p>

      <p className="sim-note">
        ⚠️ <b>이건 「어느 쪽이 맞나」를 재려고 만든 자리입니다.</b> 표본 재구성에서는
        교집합이 값을 안 했지만(교집합만 +0.28%p, 초록만 +1.40%p) 그건 <b>근사</b>였습니다
        — 일곱 목록 중 여섯만 되살렸고 순위도 표본 안에서 매겼습니다. 실제 원장이
        쌓여야 답이 납니다. <b>지금은 판단 근거가 아니라 쌓는 중입니다.</b>
      </p>

      {job && (
        <div className="pub-progress">
          <div className="pub-progress-head">
            <b>신호등 분석 — {job.step}</b>
            <span className="pub-progress-count">
              {job.done}/{job.total}
              {job.added > 0 && ` · 새로 ${job.added}`}
            </span>
            {job.status === "running" && <span className="pub-spinner" aria-hidden="true" />}
          </div>
        </div>
      )}

      <div className="filter-row">
        <button
          className="filter-btn active"
          onClick={() => {
            void api.listTrackRun().catch(() => undefined);
          }}
          disabled={job?.status === "running"}
        >
          {job?.status === "running" ? "돌리는 중…" : "지금 돌리기"}
        </button>
        <button className="filter-btn" onClick={() => setAll(!allOpen)}>
          {allOpen ? "▴ 전체 접기" : "▾ 전체 펼치기"}
        </button>
        <span className="pt-n">
          40분쯤 걸립니다 — 백그라운드라 화면을 떠나도 됩니다. 끝나면 🔔 알림이 옵니다
        </span>
      </div>

      {/* ── 목록별 요약 — 어디에 초록이 몰려 있나 ── */}
      <section className="card">
        <button className="gb-head" onClick={toggleSum}>
          <span className="gb-caret">{openSum ? "▾" : "▸"}</span>
          <b>목록별 요약</b>
          <span className="pt-n">어느 목록에 초록이 몰려 있나</span>
          {!openSum && (
            <span className="gb-peek">
              추적 <b>{data.byList.reduce((a, b) => a + b.active, 0)}</b>
              <span className="pt-n"> · 일곱 목록</span>
            </span>
          )}
        </button>
        {openSum && (
        <div className="table-wrap">
          <table className="sim-table">
            <thead>
              <tr>
                <th>목록</th>
                <th className="num">받은 종목</th>
                <th className="num">그중 초록</th>
                <th className="num">초록 비율</th>
                <th className="num">추적 중</th>
                <th className="num">이탈</th>
                <th className="num">평균 점수</th>
              </tr>
            </thead>
            <tbody>
              {data.byList.map((b) => {
                const c = data.counts[b.key];
                const ratio = c && c.universe > 0 ? (c.green / c.universe) * 100 : null;
                return (
                  <tr
                    key={b.key}
                    className={tab === b.key ? "gb-base" : ""}
                    onClick={() => setTab(b.key)}
                    style={{ cursor: "pointer" }}
                  >
                    <td>{b.label}</td>
                    <td className="num">{c ? c.universe.toLocaleString("ko-KR") : "-"}</td>
                    <td className="num">{c ? c.green.toLocaleString("ko-KR") : "-"}</td>
                    <td className="num">{ratio === null ? "-" : `${ratio.toFixed(1)}%`}</td>
                    <td className="num">{b.active}</td>
                    <td className="num pt-n">{b.exited}</td>
                    <td className="num">{b.avgScore ?? "-"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        )}
        {openSum && (
          <p className="pt-n">
            <b>초록 비율</b>이 목록의 성격을 말합니다 — 높으면 그 목록이 이미 신호등과
            비슷한 것을 보고 있다는 뜻이고, 낮으면 다른 것을 봅니다. 줄을 누르면 아래에
            그 목록의 종목이 뜹니다.
          </p>
        )}
      </section>

      {/* ── 성적표 — 이 원장의 존재 이유 ── */}
      {data.grade.length > 0 && (
        <section className="card">
          <button className="gb-head" onClick={toggleGrade}>
            <span className="gb-caret">{openGrade ? "▾" : "▸"}</span>
            <b>편입 후 성적</b>
            <span className="pt-n">슈퍼신호등 채점표와 같은 자 — 두 원장을 견주려고</span>
            {!openGrade && data.grade[0] && (
              <span className="gb-peek">
                전체 {data.grade[0].n}건
                <span className="pt-n">
                  {" "}
                  · 1일 {data.grade[0].d1.avg === null ? "아직" : `${data.grade[0].d1.avg}%`}
                </span>
              </span>
            )}
          </button>
          {openGrade && (
          <>
          <p className="pt-n">
            <b>슈퍼신호등 채점표와 같은 자</b>로 잽니다(편입일 종가 대비) — 그래야 두
            원장을 나란히 놓고 「교집합이 값을 하나」에 답할 수 있습니다.
          </p>
          <div className="table-wrap">
            <table className="sim-table">
              <thead>
                <tr>
                  <th>구간</th>
                  <th className="num">편입</th>
                  <th className="num">1일</th>
                  <th className="num">5일</th>
                  <th className="num">20일</th>
                  <th className="num">승률(1일)</th>
                </tr>
              </thead>
              <tbody>
                {data.grade.map((g, i) => (
                  <tr key={g.label} className={i === 0 ? "gb-base" : g.n < 5 ? "sim-thin" : ""}>
                    <td>{g.label}</td>
                    <td className="num">{g.n.toLocaleString("ko-KR")}</td>
                    <td className={`num ${cls(g.d1.avg)}`}>
                      {g.d1.avg === null ? "-" : `${g.d1.avg > 0 ? "+" : ""}${g.d1.avg}%`}
                      <span className="pt-n"> ({g.d1.n})</span>
                    </td>
                    <td className={`num ${cls(g.d5.avg)}`}>
                      {g.d5.avg === null ? "-" : `${g.d5.avg > 0 ? "+" : ""}${g.d5.avg}%`}
                      <span className="pt-n"> ({g.d5.n})</span>
                    </td>
                    <td className={`num ${cls(g.d20.avg)}`}>
                      {g.d20.avg === null ? "-" : `${g.d20.avg > 0 ? "+" : ""}${g.d20.avg}%`}
                      <span className="pt-n"> ({g.d20.n})</span>
                    </td>
                    <td className="num pt-n">{g.win1 === null ? "-" : `${g.win1}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="pt-n">
            괄호는 <b>성적이 찬 표본 수</b>입니다 — 편입 수와 다릅니다(20일이 안 지난
            종목은 20일 칸이 비어 있습니다). 표본 5 미만인 줄은 흐리게 그렸습니다.
          </p>
          </>
          )}
        </section>
      )}

      {/* ── 목록 고르기 ── */}
      <div className="filter-row">
        {data.byList.map((b) => (
          <button
            key={b.key}
            className={`filter-btn ${tab === b.key ? "active" : ""}`}
            onClick={() => setTab(b.key)}
          >
            {b.label}
            {b.active > 0 && <i className="pt-n"> {b.active}</i>}
          </button>
        ))}
        <button
          className={`filter-btn ${showExited ? "active" : ""}`}
          onClick={() => setShowExited((v) => !v)}
        >
          이탈 포함 {showExited ? "켬" : "끔"}
        </button>
      </div>

      {counts && (
        <div className="table-note">
          이 목록에서 상위 <b>{counts.universe}종목</b>을 받아 <b>{counts.green}종목</b>이
          초록이었습니다 ({((counts.green / Math.max(1, counts.universe)) * 100).toFixed(1)}%).
        </div>
      )}

      {visible.length === 0 ? (
        <div className="empty">
          아직 담긴 종목이 없습니다 — 「지금 돌리기」를 누르거나 평일 16:30 자동 실행을
          기다리세요.
        </div>
      ) : (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>상태</th>
                <th>종목</th>
                <th className="num">순위</th>
                <th className="num">점수</th>
                <th className="num">반복</th>
                <th>편입일</th>
                <th className="num">편입가</th>
                <th>장세</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((e) => (
                <Row key={`${e.list}:${e.code}`} e={e} onSelectStock={onSelectStock} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="table-note">
        <b>순위</b>는 편입일 그 목록에서의 자리입니다 — 「상위권일수록 나은가」를 나중에
        물으려면 있어야 합니다. <b>반복</b>은 그 목록에 며칠째 이어서 걸렸나입니다.
        <b>장세</b>는 편입일의 시장 상태입니다(폭이 좁은 날의 초록은 실측에서 시장에
        -2.15%p 졌습니다).
      </div>
    </div>
  );
}

function Row({
  e,
  onSelectStock,
}: {
  e: ListEntry;
  onSelectStock: (code: string, name: string) => void;
}) {
  return (
    <tr onClick={() => onSelectStock(e.code, e.name)} style={{ cursor: "pointer" }}>
      <td>{e.active !== false ? "🟢" : "⛔"}</td>
      <td>
        <WatchStar code={e.code} />
        <b>{e.name}</b> <SuperMark code={e.code} />
        <span className="pt-n"> {e.code}</span>
      </td>
      <td className="num">{e.rank}</td>
      <td className="num">{e.score}</td>
      <td className="num">{e.seenCount}일</td>
      <td>{e.addedDate.slice(5)}</td>
      <td className="num">{e.addedPrice.toLocaleString("ko-KR")}</td>
      <td className={e.regime?.weak ? "negative" : ""}>
        {e.regime
          ? e.regime.weak
            ? `약함 (폭 ${e.regime.breadth ?? "-"}%)`
            : `정상 (폭 ${e.regime.breadth ?? "-"}%)`
          : "-"}
      </td>
    </tr>
  );
}
