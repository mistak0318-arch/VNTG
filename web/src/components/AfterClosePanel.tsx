import { useEffect, useState } from "react";
import { api, type AfterCloseRun } from "../api";

/**
 * **마감 뒤 정리** (2026-09-01) — 무엇이 언제 돌았고, 손으로 다시 돌린다.
 *
 * 벤티지: "장 마감하고 일봉이랑 데이터 다 받아오고 나서 트리거를 통해서 신호등
 * 분석이랑 슈퍼신호등 한번 돌려야 하는 거 아냐?" / "1번과 2번을 내가 수동으로도
 * 시작할 수 있지? 지금 한 번 돌리게."
 *
 * ## 왜 순서가 중요한가
 *
 * 앞의 것이 뒤의 것의 **바탕**이다. 여태 시각으로만 잡혀 있어서 슈퍼신호등이
 * 일봉보다 먼저 돌고, 신호등 분석이 원장보다 먼저 돌았다 — 분석의
 * 「주포·투신·연기금 순매수 상위」는 원장을 읽는데 그 수집이 한 시간 뒤였다.
 *
 * 그래서 화면도 **번호를 붙여** 보여 준다. 무엇을 먼저 돌려야 하는지가 눈에
 * 보여야 손으로 돌릴 때도 순서를 안 어긴다.
 */

const STEPS: { key: string; label: string; why: string; heavy?: string }[] = [
  {
    key: "bars",
    label: "① 일봉 전종목",
    why: "장세 판정 · 테마 · ETF 뒷배 · 전종목 모집단이 전부 이걸 바탕으로 합니다",
    heavy: "약 30~40분",
  },
  {
    key: "ledger",
    label: "② 일별 원장 전종목",
    why: "수급 13주체 · 공매도 · 대차 · 지분율 · 프로그램. 「주포 순매수 상위」 같은 목록이 이걸 읽습니다",
    heavy: "약 41분",
  },
  { key: "regime", label: "③ 장세 점검", why: "①이 있어야 20일선 위 비율이 오늘 것입니다" },
  {
    key: "track",
    label: "④ 신호등 추적기",
    why: "문턱별(70/80/90)로 담아 「90점이 진짜 70점보다 나은가」를 검증합니다 — 종목을 찾는 게 아니라 신호등을 채점하는 자리입니다",
  },
  {
    key: "listTrack",
    label: "⑤ 신호등 분석 (목록별)",
    why: "열세 목록을 각각 받아 초록을 담습니다. ①②가 다 있어야 제 값이고, ⑥이 이 목록을 그대로 씁니다",
    heavy: "약 40분",
  },
  {
    key: "super",
    label: "⑥ 슈퍼신호등 (교집합)",
    why: "⑤가 받아 둔 목록에서 여러 곳에 동시에 걸린 초록만 — 그래서 ⑤ 다음입니다. 관심종목 점수대 그룹도 여기서 동기화합니다",
  },
  {
    key: "cross",
    label: "⑦ 교차 신호 (주도주 ∩ 슈퍼)",
    why: "⑥ 원장을 읽어 교집합을 냅니다. 여태 「시장 흐름」 화면을 열어야만 돌았습니다",
  },
  {
    key: "trade",
    label: "⑧ 수출입 동향",
    why: "관세청 발표(월 1일·15일 언저리)를 받아 둡니다. 여태 「수출 동향」 화면을 열어야만 받았습니다",
  },
  {
    key: "samples",
    label: "⑨ 검증 표본",
    why: "①일봉 + ②원장으로 다시 만듭니다 — 조회 0회, 몇 분",
  },
];

function dur(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`;
}

export function AfterClosePanel() {
  const [st, setSt] = useState<AfterCloseRun | null>(null);
  const [pick, setPick] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = () => {
    void api
      .afterCloseStatus()
      .then((r) => setSt(r.status))
      .catch(() => undefined);
  };

  useEffect(load, []);

  /* 도는 동안 따라간다 — 두 시간짜리라 안 보이면 멈춘 것처럼 느껴진다 */
  useEffect(() => {
    if (!st?.running) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [st?.running]);

  const toggle = (k: string) =>
    setPick((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]));

  async function run(steps?: string[]) {
    const names = steps?.length
      ? STEPS.filter((s) => steps.includes(s.key))
          .map((s) => s.label)
          .join(" · ")
      : "전체 (①~⑨)";
    if (!window.confirm(`${names} 을(를) 지금 돌립니다.\n\n장중에는 다른 화면이 느려집니다. 진행할까요?`)) {
      return;
    }
    setBusy(true);
    try {
      await api.afterCloseRun(steps);
      setMsg("시작했습니다 — 진행이 아래에 뜹니다");
      setTimeout(load, 800);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "시작 실패");
    } finally {
      setBusy(false);
    }
  }

  const doneOf = (k: string) => st?.steps.find((s) => s.key === k);

  return (
    <div className="ac">
      <p className="table-note">
        평일 <b>15:40</b>에 자동으로 <b>차례대로</b> 돕니다. 앞의 것이 뒤의 것의 바탕이라
        순서가 중요합니다 — 예전에는 시각으로만 잡혀 있어서 슈퍼신호등이 일봉보다 먼저
        돌고, 신호등 분석이 원장보다 먼저 도는 일이 있었습니다.
      </p>

      {st && (
        <div className={`ac-head${st.running ? " running" : ""}`}>
          <b>{st.day}</b>
          {st.running ? (
            <span className="ac-run">도는 중 — {st.at ?? "…"}</span>
          ) : (
            <span className="pt-n">
              {st.finishedAt
                ? `${st.startedAt.slice(11, 16)} ~ ${st.finishedAt.slice(11, 16)} 완료`
                : "안 끝남"}
            </span>
          )}
        </div>
      )}

      <div className="ac-list">
        {STEPS.map((s) => {
          const d = doneOf(s.key);
          return (
            <label className={`ac-row${d ? (d.ok ? " ok" : " bad") : ""}`} key={s.key}>
              <input
                type="checkbox"
                checked={pick.includes(s.key)}
                onChange={() => toggle(s.key)}
                disabled={st?.running}
              />
              <span className="ac-name">
                <b>{s.label}</b>
                {s.heavy && <i className="ac-heavy">{s.heavy}</i>}
                {d && (
                  <i className={d.ok ? "ac-done" : "ac-fail"}>
                    {d.ok ? "✅" : "⚠️"} {dur(d.ms)}
                    {d.note ? ` — ${d.note}` : ""}
                    {d.error ? ` — ${d.error}` : ""}
                  </i>
                )}
              </span>
              <span className="ac-why">{s.why}</span>
            </label>
          );
        })}
      </div>

      <div className="filter-row ac-act">
        <button
          className="filter-btn"
          onClick={() => void run(pick)}
          disabled={busy || pick.length === 0 || st?.running}
        >
          {pick.length > 0 ? `고른 ${pick.length}개 돌리기` : "위에서 고르세요"}
        </button>
        <button
          className="filter-btn primary"
          onClick={() => void run()}
          disabled={busy || st?.running}
        >
          전체 돌리기 (①~⑨)
        </button>
        {msg && <span className="table-note">{msg}</span>}
      </div>

      <div className="table-note">
        ⚠️ 전체는 <b>두 시간 남짓</b> 걸리고 그동안 키움 조회를 거의 다 씁니다 — 다른
        화면이 느려집니다. <b>①②만</b> 돌려 두면 나머지는 오늘 밤 자동으로 제 값으로
        돕니다(그 둘이 바탕이라서입니다).
      </div>
    </div>
  );
}
