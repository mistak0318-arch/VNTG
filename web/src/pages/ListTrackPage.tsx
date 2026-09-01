import { useCallback, useEffect, useState } from "react";
import { SuperDetailSheet } from "../components/SuperDetailSheet";
import { api, type ListTrackSummary, type ListTrackRow } from "../api";
/* 접기 — 조건 검색과 **같은 훅**을 쓴다. 열쇠 접두사(`lt`)는 그대로라 접어 둔 상태가 이어진다 */
import { useFold as useFoldBase } from "../useFold";

const useFold = (key: string, initial = false) => useFoldBase(key, initial, "lt");

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
  /**
   * 상세 시트 — **슈퍼신호등과 같은 컴포넌트**를 쓴다 (2026-09-01).
   *
   * 벤티지: "슈퍼신호등 이거 공통모듈도 만들어서 신호등 분석의 종목들에도
   * 적용해줘." 두 원장은 편입 규칙만 다르고 묻는 것이 똑같다 —
   * 편입 후 시장·테마 대비 어땠나, 점수는 어떻게 흘렀나, 수급은 누가 샀나.
   */
  const [sheet, setSheet] = useState<{ code: string; name: string } | null>(null);
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

  /**
   * 원장에서 뺀다 — 벤티지: "내가 봐서 시가총액이 너무 적거나 거래대금 너무
   * 적은건 지워버리게."
   *
   * 이탈과 다르다. 이탈은 「걸렸었는데 벗어났다」는 기록이라 남기고, 삭제는
   * 「애초에 볼 게 아니었다」라 진짜로 뺀다 — 못 사는 종목이 원장에 남으면
   * 살 수 없었던 수익률이 섞여 성적 평균을 오염시킨다.
   *
   * 되돌릴 수 없으므로 한 번 묻는다.
   */
  const remove = useCallback(
    (code: string, name: string) => {
      if (!window.confirm(`${name} 을(를) 원장에서 뺍니다.

관심종목의 자동 그룹에서도 같이 빠집니다. 되돌릴 수 없습니다.`))
        return;
      void api
        .signalListTrackRemove(code)
        .then(() => load())
        .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
    },
    [load],
  );

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
        {/*
          **일곱 목록이 다 같은 수면 의심한다** (2026-09-01).

          8/31 실행에서 일곱 목록이 전부 정확히 60종목이었다. 각 TR 이 우연히 같은
          수를 줄 리 없다 — 보통주 목록(`stockListCache`)이 반쪽으로 굳어 **모든
          모집단이 거기 걸린** 것이었다. 화면에는 정직하게 60이 찍혀 있었는데도
          그게 이상하다는 걸 알아보지 못했다.

          서버에 방어를 넣었지만(반쪽이면 안 굳힌다), 그래도 **화면이 말을 해야**
          같은 일이 또 나도 바로 안다. 숫자가 있는 것과 읽히는 것은 다르다.
        */}
        {(() => {
          const sizes = Object.values(data.counts ?? {}).map((c) => c.universe);
          const allSame = sizes.length > 1 && sizes.every((n) => n === sizes[0]);
          if (!allSame || sizes[0] >= 400) return null;
          return (
            <p className="sim-note lt-warn">
              ⚠️ 일곱 목록이 <b>전부 {sizes[0]}종목</b>으로 같습니다. 목록마다 성격이 다른데
              같은 수가 나올 리 없습니다 — <b>보통주 목록이 반쪽으로 들어왔을 때</b> 이렇게
              됩니다(모든 모집단이 그 목록으로 걸러지기 때문). 「지금 돌리기」로 다시
              돌려 보세요.
            </p>
          );
        })()}
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
                  {/*
                    **지수 대비** (2026-09-01) — 슈퍼 채점표와 같은 칸.
                    이게 없으면 위의 셋은 뜻이 없다. 「+2%」가 잘한 건지는 그날 시장이
                    몇 % 였는지를 알아야 답할 수 있고, 상승장에서는 아무거나 사도 오른다.
                  */}
                  <th className="num sd-emph" title="같은 기간 코스피를 뺀 값 — 이게 진짜 성적이다">
                    지수대비 +20
                  </th>
                  <th className="num">승률(1일)</th>
                  <th className="num" title="평균과 같이 봐야 뜻이 산다 — 「두 번 크게 먹고 여덟 번 잃었다」인지 「고르게 벌었다」인지">
                    승률(20일)
                  </th>
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
                    <td className={`num sd-emph ${cls(g.ex20.avg)}`}>
                      {g.ex20.avg === null ? "-" : `${g.ex20.avg > 0 ? "+" : ""}${g.ex20.avg}%p`}
                      <span className="pt-n"> ({g.ex20.n})</span>
                    </td>
                    <td className="num pt-n">{g.win1 === null ? "-" : `${g.win1}%`}</td>
                    <td className="num pt-n">{g.win20 === null ? "-" : `${g.win20}%`}</td>
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
            {/*
              **슈퍼신호등과 같은 칸** (2026-09-01 — "슈퍼 신호등에 있는 우리가 보려고
              했던 이런 좋은 기능들을 같이 보는게 맞지").

              원장 자체는 이쪽이 더 많이 들고 있었다(순위·이탈·연속미달). 모자란 것은
              **화면에 붙는 값**이었다 — 지금 가격, 편입 대비, 무리(테마·ETF).
              전부 조회 0회로 만들어진다(스냅샷 엿보기 + 파일 렌즈).
            */}
            <thead>
              <tr>
                <th>상태</th>
                <th>종목</th>
                <th className="num" title="편입일 그 목록에서의 자리">순위</th>
                <th className="num">점수</th>
                <th className="num" title="그 목록에 며칠째 이어서 걸렸나">반복</th>
                <th className="num" title="편입일로부터 며칠(달력일). 반복과 다른 질문의 답이다">경과</th>
                <th>편입일</th>
                <th className="num">편입가</th>
                <th className="num">현재가</th>
                <th className="num">당일</th>
                <th className="num" title="편입가 대비 — 담고 나서 얼마나">편입 대비</th>
                <th title="이 종목이 든 테마 중 오늘 가장 강한 것. 무리가 식으면 이탈이 가깝다">무리</th>
                <th className="num" title="이 종목을 많이 담은 상위 3 ETF 의 오늘 평균">ETF 뒷배</th>
                <th className="num">+1일</th>
                <th className="num">+5일</th>
                <th className="num">+20일</th>
                <th className="num" title="지수 대비 초과수익 — 이게 없으면 위의 셋은 뜻이 없다">지수대비 +20</th>
                <th title="편입일의 시장 상태 — 마우스를 올리면 폭·신고가가 나옵니다">장세</th>
                <th title="원장에서 뺍니다">삭제</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((e) => (
                <Row
                  key={`${e.list}:${e.code}`}
                  e={e}
                  onOpen={(c, n) => setSheet({ code: c, name: n })}
                  onRemove={remove}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="table-note">
        <b>순위</b>는 편입일 그 목록에서의 자리입니다 — 「상위권일수록 나은가」를 나중에
        물으려면 있어야 합니다. <b>반복</b>은 그 목록에 며칠째 이어서 걸렸나입니다.
        <b>장세</b>는 편입일의 시장 상태입니다 — 마우스를 올리면 폭·신고가가 나옵니다
        (폭이 좁은 날의 초록은 실측에서 시장에 -2.15%p 졌습니다). 행을 누르면{" "}
        <b>흐름 상세</b>(주가·점수·수급·이탈 기록)가 열립니다.
      </div>

      {/*
        상세 시트 — **슈퍼신호등과 같은 컴포넌트**다 (2026-09-01).
        `source="list"` 하나로 갈린다. 서버가 같은 모양의 응답을 준다.
      */}
      {sheet && (
        <SuperDetailSheet
          source="list"
          code={sheet.code}
          name={sheet.name}
          onClose={() => setSheet(null)}
          onOpenStock={onSelectStock}
          onChanged={load}
        />
      )}
    </div>
  );
}

/** 수익률 한 칸 — 없으면 「아직」이라고 적는다. 0 으로 채우면 거짓말이 된다 */
function Ret({ v }: { v: number | null | undefined }) {
  if (v === null || v === undefined || !Number.isFinite(v))
    return <span className="pt-n">아직</span>;
  return (
    <span className={cls(v)}>
      {v > 0 ? "+" : ""}
      {v.toFixed(1)}%
    </span>
  );
}

function Row({
  e,
  onOpen,
  onRemove,
}: {
  e: ListTrackRow;
  /** 행을 누르면 상세 시트 — 슈퍼신호등과 같은 컴포넌트다 */
  onOpen: (code: string, name: string) => void;
  onRemove: (code: string, name: string) => void;
}) {
  return (
    <tr onClick={() => onOpen(e.code, e.name)} style={{ cursor: "pointer" }}>
      <td>
        {e.active !== false ? "🟢" : "⛔"}
        {e.isNew && <i className="lt-new">N</i>}
      </td>
      <td>
        <WatchStar code={e.code} />
        <b>{e.name}</b> <SuperMark code={e.code} />
        <span className="pt-n"> {e.code}</span>
      </td>
      <td className="num">{e.rank}</td>
      <td className="num">{e.score}</td>
      <td className="num">{e.seenCount}일</td>
      <td className="num pt-n">{e.daysSince}일</td>
      <td>{e.addedDate.slice(5)}</td>
      <td className="num">{e.addedPrice.toLocaleString("ko-KR")}</td>
      <td className="num">{e.price === null ? "-" : e.price.toLocaleString("ko-KR")}</td>
      <td className={`num ${cls(e.changeRate)}`}>
        {e.changeRate === null
          ? "-"
          : `${e.changeRate > 0 ? "+" : ""}${e.changeRate.toFixed(2)}%`}
      </td>
      <td className="num">
        <Ret v={e.sinceAdded} />
      </td>
      {/* 무리 — 걸린 종목의 테마가 식으면 이탈이 가깝다 */}
      <td className="pt-n">
        {e.theme ? (
          <>
            {e.theme.name}{" "}
            <span className={cls(e.theme.changeRate)}>
              {e.theme.changeRate > 0 ? "+" : ""}
              {e.theme.changeRate.toFixed(1)}%
            </span>
            {e.theme.streak > 1 && <i className="lt-streak">{e.theme.streak}일↑</i>}
          </>
        ) : (
          "-"
        )}
      </td>
      <td className={`num ${cls(e.etfBack?.rate ?? null)}`} title={e.etfBack?.top}>
        {e.etfBack
          ? `${e.etfBack.rate > 0 ? "+" : ""}${e.etfBack.rate.toFixed(2)}%`
          : "-"}
      </td>
      <td className="num">
        <Ret v={e.returns?.d1} />
      </td>
      <td className="num">
        <Ret v={e.returns?.d5} />
      </td>
      <td className="num">
        <Ret v={e.returns?.d20} />
      </td>
      <td className="num">
        <Ret v={e.excess?.d20} />
      </td>
      {/*
        **장세는 한 글자로** (2026-09-01 — 벤티지: "쟤는 쓸데없이 너무 길다").

        「정상 (폭 57.1%)」이 줄마다 되풀이되면서 칸을 제일 넓게 먹고 있었다.
        같은 날 편입한 종목은 값이 전부 같으니 그 넓이만큼 아무것도 안 알려 준다.
        폭 숫자는 마우스를 올리면 나온다.
      */}
      <td
        className={`lt-regime ${e.regime?.weak ? "negative" : ""}`}
        title={
          e.regime
            ? `편입일 시장 폭 ${e.regime.breadth ?? "-"}% · 신고가 ${e.regime.newHigh ?? "-"}${
                e.regime.weak ? " — 폭이 좁은 날의 초록은 실측에서 시장에 -2.15%p 졌습니다" : ""
              }`
            : "편입일 장세를 못 읽었습니다"
        }
      >
        {e.regime ? (e.regime.weak ? "약함" : "정상") : "-"}
      </td>
      {/* 삭제 — 시가총액·거래대금이 너무 적어 애초에 볼 게 아니었던 종목 */}
      <td className="lt-del">
        <button
          className="sd-del"
          title="원장에서 뺍니다 — 관심종목의 자동 그룹에서도 같이 빠집니다"
          onClick={(ev) => {
            ev.stopPropagation();
            onRemove(e.code, e.name);
          }}
        >
          ✕
        </button>
      </td>
    </tr>
  );
}
