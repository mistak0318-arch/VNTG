import { useEffect, useState } from "react";
import { api, type AfterCloseRun, type StepResult } from "../api";

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

/** ISO → 09/08 15:42 (KST) */
function when(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const k = new Date(d.getTime() + 9 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(k.getUTCMonth() + 1)}/${p(k.getUTCDate())} ${p(k.getUTCHours())}:${p(k.getUTCMinutes())}`;
}

/** 09/08 15:42 → 15:42 */
function hm(iso?: string): string {
  const w = when(iso);
  return w ? w.slice(6) : "";
}

export function AfterClosePanel() {
  const [st, setSt] = useState<AfterCloseRun | null>(null);
  /**
   * **단계별 마지막 성적** (2026-09-08 — 벤티지 "최근 진행한 히스토리 좀 각 메뉴별로 달아줘.
   * 언제 했는지 뭘 성공했는지 알 수가 없네").
   *
   * 여태 결과는 서버 **메모리**에만 있었다. 재시작하면 사라지므로 아침에 열면 어젯밤에 뭐가
   * 돌았는지 화면에 아무것도 없었다 — 텔레그램을 뒤지는 수밖에. 이제 파일에서 읽어 온다.
   */
  const [last, setLast] = useState<Record<string, StepResult & { day: string }>>({});
  const [history, setHistory] = useState<AfterCloseRun[]>([]);
  const [showHist, setShowHist] = useState(false);
  const [pick, setPick] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = () => {
    void api
      .afterCloseStatus()
      .then((r) => {
        setSt(r.status);
        setLast(r.lastByStep ?? {});
        setHistory(r.history ?? []);
      })
      .catch(() => undefined);
  };

  useEffect(load, []);

  /*
   * 도는 동안은 2.5초, 아닐 때도 6초에 한 번 (2026-09-08).
   *
   * 예전엔 **「도는 중」일 때만** 물었다. 그러면 15:40 에 자동 회차가 시작돼도 열어 둔 화면은
   * 영영 모른다 — 새로고침해야 그제야 「도는 중」이 되고 그때부터 따라간다. 진행 막대를
   * 붙여 놓고 정작 시작을 못 보면 소용이 없다. 쉬는 동안의 6초는 우리 서버의 메모리를
   * 읽는 값이라 조회가 안 나간다.
   */
  useEffect(() => {
    const t = setInterval(load, st?.running ? 2500 : 6000);
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
            <span className="ac-run">
              도는 중 — {st.at ?? "…"}
              {st.stepTotal ? ` (${st.stepNo ?? 0}/${st.stepTotal}단계)` : ""}
            </span>
          ) : (
            <span className="pt-n">
              {st.finishedAt ? `${when(st.startedAt)} ~ ${hm(st.finishedAt)} 완료` : "안 끝남"}
              {st.reason ? ` · ${st.reason}` : ""}
            </span>
          )}
          {/* 전체가 어디쯤인지 — 두 시간짜리라 막대가 없으면 멈춘 것처럼 느껴진다 */}
          {st.running && st.stepTotal ? (
            <span className="ac-bar" title={`${st.stepNo ?? 0}/${st.stepTotal}단계`}>
              <i style={{ width: `${Math.round(((st.stepNo ?? 0) / st.stepTotal) * 100)}%` }} />
            </span>
          ) : null}
        </div>
      )}

      <div className="ac-list">
        {STEPS.map((s) => {
          /* 이번 회차 결과가 있으면 그것, 없으면 **지난 회차의 마지막 성적** */
          const today = doneOf(s.key);
          const d = today ?? last[s.key];
          const old = !today && Boolean(last[s.key]);
          const nowHere = Boolean(st?.running && st.atKey === s.key);
          const pr = st?.progress && st.progress.key === s.key ? st.progress : null;
          const pct = pr && pr.total > 0 ? Math.min(100, Math.round((pr.done / pr.total) * 100)) : null;
          return (
            <label
              className={`ac-row${d ? (d.ok ? " ok" : " bad") : ""}${nowHere ? " now" : ""}`}
              key={s.key}
            >
              <input
                type="checkbox"
                checked={pick.includes(s.key)}
                onChange={() => toggle(s.key)}
                disabled={st?.running}
              />
              <span className="ac-name">
                <b>{s.label}</b>
                {s.heavy && <i className="ac-heavy">{s.heavy}</i>}
                {/*
                  **언제 · 성공 · 몇 건.** 지난 회차 것이면 날짜를 앞에 적는다 — 어제 성적을
                  오늘 것으로 읽으면 「돌았구나」 하고 넘어가게 된다.
                */}
                {d && !nowHere && (
                  <i className={d.ok ? "ac-done" : "ac-fail"} title={d.error ?? d.note ?? ""}>
                    {d.ok ? "✅" : "⚠️"} {old ? `${when(d.at) || (d as { day?: string }).day || ""} · ` : ""}
                    {dur(d.ms)}
                    {d.note ? ` — ${d.note}` : ""}
                    {d.error ? ` — ${d.error}` : ""}
                  </i>
                )}
                {/* 지금 도는 단계 — 몇 개 중 몇 개까지 왔나 */}
                {nowHere && (
                  <i className="ac-now">
                    {pr
                      ? `⏳ ${pr.done.toLocaleString()}/${pr.total.toLocaleString()}${pct !== null ? ` (${pct}%)` : ""}${pr.note ? ` · ${pr.note}` : ""}`
                      : "⏳ 도는 중 — 이 단계는 진행을 못 재는 작업입니다"}
                  </i>
                )}
              </span>
              {pct !== null && (
                <span className="ac-bar step">
                  <i style={{ width: `${pct}%` }} />
                </span>
              )}
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

      {/* **지난 회차** — 오늘 것만 보면 「어제는 됐었나」를 알 수 없다 (2026-09-08) */}
      {history.length > 0 && (
        <div className="ac-hist">
          <button type="button" className="filter-btn" onClick={() => setShowHist((v) => !v)}>
            지난 회차 {history.length}개 {showHist ? "접기" : "보기"}
          </button>
          {showHist && (
            <div className="ac-hist-list">
              {history.map((r) => {
                const bad = r.steps.filter((x) => !x.ok);
                return (
                  <div className={`ac-hist-run${bad.length ? " bad" : ""}`} key={r.startedAt}>
                    <div className="ac-hist-h">
                      <b>{r.day}</b>
                      <span className="pt-n">
                        {when(r.startedAt)}
                        {r.finishedAt ? ` ~ ${hm(r.finishedAt)}` : " · 안 끝남"}
                        {r.reason ? ` · ${r.reason}` : ""}
                      </span>
                      <span className={bad.length ? "ac-fail" : "ac-done"}>
                        {bad.length ? `⚠️ ${bad.length}단계 실패` : `✅ ${r.steps.length}단계`}
                      </span>
                    </div>
                    <div className="ac-hist-steps">
                      {r.steps.map((x) => (
                        <span className={x.ok ? "ac-done" : "ac-fail"} key={x.key}>
                          {x.ok ? "✅" : "⚠️"} {x.label}
                          {x.note ? ` · ${x.note}` : ""}
                          {x.error ? ` · ${x.error}` : ""}
                          <i className="pt-n"> {dur(x.ms)}</i>
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="table-note">
        ⚠️ 전체는 <b>두 시간 남짓</b> 걸리고 그동안 키움 조회를 거의 다 씁니다 — 다른
        화면이 느려집니다. <b>①②만</b> 돌려 두면 나머지는 오늘 밤 자동으로 제 값으로
        돕니다(그 둘이 바탕이라서입니다).
      </div>
    </div>
  );
}
