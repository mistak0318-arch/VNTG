import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type CisAccountView,
  type CisConfig,
  type CisDay,
  type CisFill,
  type CisPersonaState,
  type CisProfile,
  type CisRuleLabel,
  type CisRules,
  type CisSlotEntry,
  type CisStats,
  type CisUsageRow,
  type PublishJob,
} from "../api";
import { ProgressSteps } from "../components/ProgressSteps";

/**
 * CIS 일지 — 시스가 굴리는 모의 계좌를 보는 자리.
 *
 * ⚠️ **모의다.** 이 HTS 는 조회 전용이고 주문 API 가 없다. 화면 어디에도
 * 「주문」이 없는 이유이고, 머리에 그렇게 적어 둔다 — 몇 달 뒤에 봤을 때
 * 실제 계좌로 착각하면 안 된다.
 *
 * ## 서브탭을 이 순서로 두는 이유
 *
 *   오늘 → 복기 → 매매일지 → 계좌 → 통계 → 활용법 → 설정
 *
 * 매일 여는 것이 앞이다. 「오늘 뭐 했나」가 첫 화면이고, 그다음이 「요즘 어땠나」다.
 * 계좌·통계는 가끔 보고, 설정은 더 가끔 본다. 자주 쓰는 것이 앞이라는 원칙은
 * 이 앱의 다른 화면들과 같다.
 */

/**
 * 하루 세 번. 각 시간대는 **직전 구간을 복기하고 다음 구간을 판단한다**
 * (2026-08-31 — "장중 3번의 복기는 그사이에 대한 복기와 시장상황에 대해서
 * 판단할 내용을 적어두는거").
 */
const SLOTS = [
  { key: "morning" as const, label: "아침", hint: "간밤을 읽고 오늘을 계획", icon: "🌅", at: "08:40" },
  { key: "noon" as const, label: "점심", hint: "오전을 복기하고 오후를 판단", icon: "☀️", at: "12:30" },
  { key: "evening" as const, label: "저녁", hint: "오늘을 복기하고 내일을 준비", icon: "🌆", at: "15:45" },
];

const TABS = [
  { key: "today", label: "오늘" },
  { key: "review", label: "복기 노트" },
  { key: "fills", label: "매매일지" },
  { key: "account", label: "계좌" },
  { key: "stats", label: "통계" },
  { key: "usage", label: "HTS 활용법" },
  { key: "config", label: "CIS 모드" },
];

/** KST 오늘 — 서버(cisAccount.today)와 같은 기준이라야 「오늘」이 어긋나지 않는다 */
function todayStr(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}
const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];
function dateLabel(d: string): string {
  const t = new Date(`${d}T00:00:00Z`);
  return `${d.slice(5).replace("-", "/")} (${WEEKDAY[t.getUTCDay()]})`;
}

const won = (n: number) => `${Math.round(n).toLocaleString("ko-KR")}원`;
/**
 * 큰 돈을 짧게 — 억/만 단위. 「40,000,000원」과 「1.1억」이 나란히 있으면 크기가
 * 한눈에 안 비교된다. 같은 자리에 놓을 값들은 같은 문법으로 적는다.
 */
const 억 = (n: number) => {
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(n % 100_000_000 === 0 ? 0 : 1)}억`;
  if (n >= 10_000) return `${Math.round(n / 10_000).toLocaleString("ko-KR")}만`;
  return won(n);
};
const signed = (n: number) => `${n > 0 ? "+" : ""}${Math.round(n).toLocaleString("ko-KR")}`;
const cls = (n: number) => (n > 0 ? "positive" : n < 0 ? "negative" : "");

/** 규칙이 만든 글은 마크다운이다 — 제목·목록·굵게만 해석한다 */
function CisText({ text }: { text: string }) {
  const parts = text.split("\n").map((raw, i) => {
    const line = raw.trim();
    if (!line) return null;
    if (line.startsWith("> ")) {
      return (
        <div className="cis-quote" key={i}>
          {inline(line.slice(2))}
        </div>
      );
    }
    if (line.startsWith("### ")) {
      return (
        <h5 className="cis-h3" key={i}>
          {line.slice(4)}
        </h5>
      );
    }
    if (line.startsWith("## ")) {
      return (
        <h4 className="ai-h" key={i}>
          {line.slice(3)}
        </h4>
      );
    }
    if (/^\s*-\s/.test(raw)) {
      /* 들여쓴 목록은 한 단 더 — 「왜 샀나」가 종목 밑에 붙는다 */
      const deep = /^\s{2,}-\s/.test(raw);
      return (
        <div className={`ai-li${deep ? " cis-li-sub" : ""}`} key={i}>
          {inline(line.replace(/^-\s/, ""))}
        </div>
      );
    }
    return (
      <p className="ai-p" key={i}>
        {inline(line)}
      </p>
    );
  });
  return <div className="cis-text">{parts}</div>;
}

function inline(s: string): React.ReactNode[] {
  return s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <b key={i}>{part.slice(2, -2)}</b>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

const COND_LABEL: Record<CisPersonaState["condition"], { text: string; cls: string }> = {
  new: { text: "이제 시작", cls: "" },
  steady: { text: "평온", cls: "" },
  hot: { text: "잘 맞는 중", cls: "positive" },
  cold: { text: "안 맞는 중", cls: "negative" },
  bruised: { text: "얻어맞은 뒤", cls: "negative" },
};

export function CisPage({ onSelectStock }: { onSelectStock?: (code: string, name: string) => void }) {
  const [account, setAccount] = useState<string>(
    () => localStorage.getItem("vntg.cis.account") || "trade",
  );
  const [tab, setTab] = useState<string>(() => localStorage.getItem("vntg.cis.tab") || "today");
  const [profiles, setProfiles] = useState<CisProfile[]>([]);
  const [config, setConfig] = useState<CisConfig | null>(null);
  const [ruleLabels, setRuleLabels] = useState<Record<string, CisRuleLabel>>({});
  const [aiReady, setAiReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => localStorage.setItem("vntg.cis.account", account), [account]);
  useEffect(() => localStorage.setItem("vntg.cis.tab", tab), [tab]);

  const loadConfig = useCallback(() => {
    api
      .cisConfig()
      .then((r) => {
        setConfig(r.config);
        setRuleLabels(r.ruleLabels);
        setAiReady(r.aiReady);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(loadConfig, [loadConfig]);

  const profile = profiles.find((p) => p.id === account) ?? null;
  useEffect(() => {
    api.cisAccounts().then((r) => setProfiles(r.accounts)).catch(() => {});
  }, []);

  return (
    <div className="cis-page">
      <h2 className="page-title">
        🧠 CIS 일지
        <span className="cis-sub">시스가 굴리는 모의 계좌 — 실제 주문은 나가지 않습니다</span>
      </h2>

      {error && <div className="error-banner">{error}</div>}

      {config && !config.enabled && (
        <div className="cis-off">
          <b>CIS 모드가 꺼져 있습니다.</b> 켜야 시스가 판단하고 일지를 씁니다.
          <button className="filter-btn" onClick={() => setTab("config")}>
            설정으로
          </button>
        </div>
      )}

      {/*
        계좌 — 성격이 다른 돈이라 맨 위에서 고른다. 단추가 아니라 **카드**인 이유는
        셋이 서로 다른 계좌라는 것이 한눈에 보여야 해서다. 서브탭과 같은 모양이면
        「탭이 열 개」로 읽힌다.
      */}
      <div className="cis-accounts">
        {profiles.map((p) => (
          <button
            key={p.id}
            className={`cis-acct ${account === p.id ? "on" : ""} cis-acct-${p.id}`}
            onClick={() => setAccount(p.id)}
            title={p.hint}
          >
            <b>{p.name}</b>
            <i>{억(p.seed)}</i>
            <em>{p.etfOnly ? "ETF" : "개별종목"}{p.riskCap < 100 ? ` · 위험 ${p.riskCap}%` : ""}</em>
          </button>
        ))}
      </div>
      {profile && <div className="cis-profile-note">{profile.hint}</div>}

      <div className="cis-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`cis-tab ${tab === t.key ? "on" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "today" && (
        <TodayTab account={account} busy={busy} setBusy={setBusy} enabled={config?.enabled ?? false} />
      )}
      {tab === "review" && <ReviewTab account={account} />}
      {tab === "fills" && <FillsTab account={account} onSelectStock={onSelectStock} />}
      {tab === "account" && <AccountTab account={account} onSelectStock={onSelectStock} />}
      {tab === "stats" && <StatsTab account={account} />}
      {tab === "usage" && <UsageTab account={account} />}
      {tab === "config" && config && (
        <ConfigTab
          config={config}
          ruleLabels={ruleLabels}
          aiReady={aiReady}
          onSaved={(c) => setConfig(c)}
        />
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════ 오늘 */

function TodayTab({
  account,
  busy,
  setBusy,
  enabled,
}: {
  account: string;
  busy: string | null;
  setBusy: (v: string | null) => void;
  enabled: boolean;
}) {
  const [day, setDay] = useState<CisDay | null>(null);
  const [state, setState] = useState<CisPersonaState | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [job, setJob] = useState<PublishJob | null>(null);
  const jobIdRef = useRef<string | null>(null);
  /**
   * 보고 있는 날짜 (2026-08-31 — "전날 전전날 체크하기가 쉽지 않겠는데? 과거
   * 기록도 봐야 의미가 있지. 그날의 얘는 무슨 생각을 했었는지").
   *
   * 오늘만 보이면 이 일지는 쌓을 이유가 없다 — 며칠 전 판단과 그 결과를 나란히
   * 놓고 보는 것이 전부다.
   */
  const [date, setDate] = useState<string>(() => todayStr());
  /** 일지가 있는 날들 — 화살표로 **글이 있는 날만** 건너뛴다(주말·공휴일을 헛돌지 않게) */
  const [written, setWritten] = useState<string[]>([]);
  const isToday = date === todayStr();

  const load = useCallback(() => {
    api.cisDay(account, date).then(setDay).catch(() => setDay(null));
    api
      .cisDays(account, 120)
      .then((r) => {
        setState(r.state);
        setWritten(r.days.map((d) => d.date));
      })
      .catch(() => {});
  }, [account, date]);
  useEffect(load, [load]);

  /*
   * 날짜 건너뛰기. **글이 있는 날 사이만** 오간다 — 하루씩 물러나면 주말·공휴일에
   * 빈 화면이 이어져 몇 번을 눌러야 직전 거래일에 닿는다.
   * 글이 없는 날에 서 있으면(직접 고른 날짜) 그 날짜 기준으로 앞뒤를 찾는다.
   */
  const step = (back: boolean) => {
    const sorted = [...written].sort();
    const next = back
      ? [...sorted].reverse().find((d) => d < date)
      : sorted.find((d) => d > date);
    if (next) setDate(next);
  };
  const hasPrev = written.some((d) => d < date);
  const hasNext = written.some((d) => d > date);

  /*
   * **뒤에서 돌리고 단계를 그린다** (2026-08-31 — "프로그래스 바가 안뜨고
   * 백그라운드 작업이 아니라 브라우저 멈추더라").
   *
   * 주도주 스캔과 종목별 신호등이 각각 수십 초라, 응답을 기다리면 화면이 멈춘
   * 것처럼 보였다. 작업 id 를 받아 1.2초마다 물어 단계를 그린다 —
   * 리포트 발행이 쓰는 것과 같은 컴포넌트다.
   */
  const run = async (slot: string, force: boolean) => {
    setBusy(slot);
    setMsg(null);
    setJob(null);
    try {
      const { jobId } = await api.cisRun(account, slot, force);
      jobIdRef.current = jobId;
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  useEffect(() => {
    if (!busy || !jobIdRef.current) return;
    const id = jobIdRef.current;
    const t = window.setInterval(async () => {
      try {
        const j = await api.cisRunProgress(id);
        setJob(j);
        if (j.status !== "running") {
          window.clearInterval(t);
          jobIdRef.current = null;
          setBusy(null);
          if (j.status === "error") setMsg(j.error ?? "돌리지 못했습니다.");
          /* 끝난 진행률은 잠깐 두었다 치운다 — 무엇을 했는지 읽을 시간을 준다 */
          window.setTimeout(() => setJob(null), 2500);
          load();
        }
      } catch {
        /* 작업이 사라졌다(서버 재시작 등) — 멈춘 채 두지 말고 놓아 준다 */
        window.clearInterval(t);
        jobIdRef.current = null;
        setBusy(null);
        setMsg("진행 상황을 잃었습니다. 화면을 새로 고쳐 확인하세요.");
      }
    }, 1200);
    return () => window.clearInterval(t);
  }, [busy, load]);

  return (
    <>
      {state && (
        <div className={`cis-state cond-${state.condition}`}>
          <span className="cis-avatar" aria-hidden="true">
            🧠
          </span>
          <div className="cis-state-body">
            <div className="cis-state-line">
              <b>시스</b>
              <span className={`cis-state-cond ${COND_LABEL[state.condition].cls}`}>
                {COND_LABEL[state.condition].text}
                {state.streak > 1 && ` · ${state.streak}일째`}
              </span>
              {state.basedOn > 0 && <i>최근 {state.basedOn}일 기준</i>}
            </div>
            {state.lastWord && <q className="cis-lastword">{state.lastWord}</q>}
          </div>
        </div>
      )}

      {/*
        날짜 이동. 화살표는 **글이 있는 날 사이만** 오간다 — 하루씩 물러나면
        주말·공휴일에 빈 화면이 이어져 몇 번을 눌러야 직전 거래일에 닿는다.
      */}
      <div className="cis-datebar">
        <button className="filter-btn" onClick={() => step(true)} disabled={!hasPrev} title="이전 기록">
          ◀
        </button>
        <input
          type="date"
          className="ma-input cis-date"
          value={date}
          max={todayStr()}
          onChange={(e) => e.target.value && setDate(e.target.value)}
        />
        <b className="cis-date-label">{dateLabel(date)}</b>
        <button className="filter-btn" onClick={() => step(false)} disabled={!hasNext} title="다음 기록">
          ▶
        </button>
        {!isToday && (
          <button className="filter-btn" onClick={() => setDate(todayStr())}>
            오늘로
          </button>
        )}
        {written.length > 0 && (
          <span className="cis-written">기록 {written.length}일</span>
        )}
      </div>

      {msg && <div className="table-note cis-msg">{msg}</div>}
      {job && <ProgressSteps job={job} />}

      {SLOTS.map((s) => {
        const e = day?.[s.key] ?? null;
        return (
          <section className="cis-slot" key={s.key}>
            <h3 className={`cis-slot-head slot-${s.key}`}>
              <span className="cis-slot-ico" aria-hidden="true">
                {s.icon}
              </span>
              <span className="cis-slot-title">
                {s.label}
                <i className="cis-slot-hint">{s.hint}</i>
              </span>
              {e ? (
                <span className="cis-at">
                  {new Date(e.at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}
                </span>
              ) : (
                <span className="cis-at cis-at-plan">{s.at} 예정</span>
              )}
              <span className="cis-slot-btns">
                {!e && isToday && (
                  <button
                    className="filter-btn"
                    disabled={!enabled || busy !== null}
                    onClick={() => run(s.key, false)}
                    title={enabled ? "" : "CIS 모드가 꺼져 있습니다"}
                  >
                    {busy === s.key ? "…" : "지금 쓰기"}
                  </button>
                )}
                {e && isToday && (
                  <button
                    className="filter-btn"
                    disabled={busy !== null}
                    onClick={() => {
                      if (
                        window.confirm(
                          `${s.label} 일지를 다시 씁니다.\n\n이미 쓴 글은 사라지고, 매매도 다시 실행됩니다.\n아침 글을 나중에 고치면 그 글이 변명이 됩니다 — 정말 다시 쓸까요?`,
                        )
                      )
                        run(s.key, true);
                    }}
                  >
                    다시 쓰기
                  </button>
                )}
              </span>
            </h3>
            {e ? (
              <SlotBody entry={e} />
            ) : (
              <div className="empty">
                {isToday ? "아직 안 썼습니다." : "이 날은 안 썼습니다."}
              </div>
            )}
          </section>
        );
      })}

      {day?.review && (
        <section className="cis-slot cis-review-box">
          <h3 className="section-heading">
            하루 총평
            <i className="cis-slot-hint">아침 계획과 대조</i>
          </h3>
          <div className="cis-review-nums">
            <span>
              계획 <b>{day.review.planned}</b> → 체결 <b>{day.review.executed}</b>
            </span>
            <span className={cls(day.review.realized)}>
              실현 <b>{signed(day.review.realized)}</b>
            </span>
            <span className={cls(day.review.equityChange)}>
              평가액 <b>{signed(day.review.equityChange)}</b>
            </span>
          </div>
          <CisText text={day.review.text} />
        </section>
      )}
    </>
  );
}

function SlotBody({ entry }: { entry: CisSlotEntry }) {
  return (
    <>
      <div className="cis-snapshot">
        <span>
          평가액 <b>{won(entry.equity)}</b>
        </span>
        <span>
          예수금 <b>{won(entry.cash)}</b>
        </span>
        {entry.debt > 0 && (
          <span className="negative">
            빌린 돈 <b>{won(entry.debt)}</b>
          </span>
        )}
      </div>
      <CisText text={entry.text} />
      {entry.used.length > 0 && (
        <div className="cis-used">
          <i>본 것</i>
          {entry.used.map((u) => (
            <span className="cis-chip" key={u}>
              {u}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

/* ══════════════════════════════════════════════════════════ 복기 노트 */

function ReviewTab({ account }: { account: string }) {
  const [days, setDays] = useState<CisDay[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [allOpen, setAllOpen] = useState(false);
  const [ai, setAi] = useState<{ text: string | null; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.cisDays(account, 60).then((r) => setDays(r.days)).catch(() => setDays([]));
  }, [account]);

  const askReview = async () => {
    setBusy(true);
    try {
      setAi(await api.cisReview(account));
    } catch (e) {
      setAi({ text: null, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  if (days.length === 0) {
    return <div className="empty">아직 쌓인 일지가 없습니다.</div>;
  }

  return (
    <>
      <h3 className="section-heading">
        여러 날 놓고 보기
        <span className="breadth-count">{days.length}일</span>
        <button className="filter-btn" onClick={askReview} disabled={busy}>
          {busy ? "…" : "어느 규칙이 나빴나 (AI)"}
        </button>
        {/* 줄을 눌러 하나씩 펴는 게 기본이지만, 쭉 읽고 싶을 때가 있다 */}
        <button className="filter-btn" onClick={() => setAllOpen((v) => !v)}>
          {allOpen ? "모두 접기" : "모두 펼치기"}
        </button>
      </h3>
      {ai && (
        <div className="cis-slot cis-weekly">
          {ai.text ? <CisText text={ai.text} /> : <div className="table-note">{ai.error ?? "답이 비었습니다."}</div>}
        </div>
      )}

      <div className="data-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>날짜</th>
              <th className="num">계획→체결</th>
              <th className="num">실현</th>
              <th className="num">평가액 변화</th>
              <th>규칙 위반</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <>
                <tr
                  key={d.date}
                  className="cis-row"
                  onClick={() => setOpen(open === d.date ? null : d.date)}
                >
                  <td>
                    {open === d.date ? "▾" : "▸"} {d.date}
                    <i className="cis-wd">{dateLabel(d.date).slice(-3)}</i>
                  </td>
                  <td className="num">
                    {d.review ? `${d.review.planned} → ${d.review.executed}` : "-"}
                  </td>
                  <td className={`num ${d.review ? cls(d.review.realized) : ""}`}>
                    {d.review ? signed(d.review.realized) : "-"}
                  </td>
                  <td className={`num ${d.review ? cls(d.review.equityChange) : ""}`}>
                    {d.review ? signed(d.review.equityChange) : "-"}
                  </td>
                  <td>
                    {d.review?.violations.length ? (
                      <span className="negative">{d.review.violations.join(", ")}</span>
                    ) : (
                      <span className="cis-dim">없음</span>
                    )}
                  </td>
                </tr>
                {(allOpen || open === d.date) && (
                  <tr key={`${d.date}-body`}>
                    <td colSpan={5} className="cis-daybody">
                      {SLOTS.map((s) =>
                        d[s.key] ? (
                          <div className="cis-dayslot" key={s.key}>
                            <h5 className="cis-h3">
                              {s.label} <i>{s.hint}</i>
                            </h5>
                            <CisText text={d[s.key]!.text} />
                          </div>
                        ) : null,
                      )}
                      {d.review && (
                        <div className="cis-dayslot">
                          <h5 className="cis-h3">총평</h5>
                          <CisText text={d.review.text} />
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ══════════════════════════════════════════════════════════ 매매일지 */

function FillsTab({
  account,
  onSelectStock,
}: {
  account: string;
  onSelectStock?: (code: string, name: string) => void;
}) {
  const [fills, setFills] = useState<CisFill[]>([]);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    api
      .cisFills(account, 500)
      .then((r) => {
        setFills(r.fills);
        setTotal(r.total);
      })
      .catch(() => setFills([]));
  }, [account]);

  if (fills.length === 0) return <div className="empty">아직 체결이 없습니다.</div>;

  return (
    <>
      <h3 className="section-heading">
        체결 원장
        <span className="breadth-count">{total}건</span>
      </h3>
      <div className="data-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>날짜</th>
              <th>구분</th>
              <th>종목</th>
              <th className="num">수량</th>
              <th className="num">단가</th>
              <th className="num">손익</th>
              <th className="num">보유</th>
              <th>자금</th>
              <th>근거</th>
            </tr>
          </thead>
          <tbody>
            {fills.map((f) => (
              <tr key={f.id}>
                <td>
                  {f.date}
                  <i className="cis-slot-tag">{f.slot === "morning" ? "아침" : f.slot === "noon" ? "점심" : "저녁"}</i>
                </td>
                <td className={f.side === "buy" ? "positive" : "negative"}>
                  {f.side === "buy" ? "매수" : "매도"}
                </td>
                <td>
                  <button className="link-btn" onClick={() => onSelectStock?.(f.code, f.name)}>
                    {f.name}
                  </button>
                </td>
                <td className="num">{f.qty.toLocaleString()}</td>
                <td className="num">{f.price.toLocaleString()}</td>
                <td className={`num ${f.pnl !== undefined ? cls(f.pnl) : ""}`}>
                  {f.pnl !== undefined ? signed(f.pnl) : "-"}
                </td>
                <td className="num">{f.heldDays !== undefined ? `${f.heldDays}일` : "-"}</td>
                <td>{f.funding === "cash" ? "예수금" : f.funding === "misu" ? "미수" : "신용"}</td>
                <td className="cis-why">{f.why}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ══════════════════════════════════════════════════════════ 계좌 */

function AccountTab({
  account,
  onSelectStock,
}: {
  account: string;
  onSelectStock?: (code: string, name: string) => void;
}) {
  const [v, setV] = useState<CisAccountView | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setV(null);
    api.cisAccount(account).then(setV).catch((e: Error) => setErr(e.message));
  }, [account]);

  if (err) return <div className="error-banner">{err}</div>;
  if (!v) return <div className="empty">불러오는 중…</div>;

  const ret = v.profile.seed > 0 ? ((v.equity - v.profile.seed) / v.profile.seed) * 100 : 0;

  return (
    <>
      <div className="cis-cards">
        <div className="cis-card">
          <i>평가액</i>
          <b>{won(v.equity)}</b>
          <span className={cls(ret)}>
            {ret > 0 ? "+" : ""}
            {ret.toFixed(2)}% · 시드 {억(v.profile.seed)}
          </span>
        </div>
        <div className="cis-card">
          <i>예수금</i>
          <b>{won(v.cash)}</b>
          <span>주식 {won(v.stockValue)}</span>
        </div>
        {(v.misu > 0 || v.credit > 0) && (
          <div className="cis-card">
            <i>빌린 돈</i>
            <b className="negative">{won(v.debt)}</b>
            <span>
              미수 {won(v.misu)} · 신용 {won(v.credit)} · {v.leverage}배
            </span>
          </div>
        )}
        {v.profile.riskCap < 100 && (
          <div className="cis-card">
            <i>위험자산</i>
            <b className={v.risk.over ? "negative" : ""}>{v.risk.riskyPct}%</b>
            <span>
              한도 {v.risk.cap}% · 안전 {won(v.risk.safe)}
              {v.risk.over && " · 한도 초과"}
            </span>
          </div>
        )}
      </div>

      {/* 목표 — 지금 어디쯤인가 */}
      <section className="cis-goal">
        <div className="cis-goal-head">
          <b>{v.goal.label}</b>
          {v.goal.next && (
            <span>
              {won(v.equity)} / {억(v.goal.next)}
              {v.goal.multiple && ` · ${v.goal.multiple}배 남음`}
            </span>
          )}
        </div>
        <div className="cis-goal-bar">
          <i style={{ width: `${Math.max(1, Math.min(100, v.goal.pct))}%` }} />
        </div>
        <div className="table-note">
          최종 100억까지 {v.goal.finalPct.toFixed(2)}%. 진척률은 직전 목표를 0으로 놓고 잽니다 —
          0원 기준으로 재면 단계마다 뜻이 달라집니다.
        </div>
      </section>

      <h3 className="section-heading">보유 {v.positions.length}종목</h3>
      {v.positions.length === 0 ? (
        <div className="empty">보유 없음.</div>
      ) : (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>종목</th>
                <th className="num">수량</th>
                <th className="num">평단</th>
                <th className="num">현재가</th>
                <th className="num">평가손익</th>
                <th className="num">손절</th>
                <th className="num">목표</th>
                <th>자금</th>
                <th>산 이유</th>
              </tr>
            </thead>
            <tbody>
              {v.positions.map((p) => (
                <tr key={`${p.code}-${p.funding}`}>
                  <td>
                    <button className="link-btn" onClick={() => onSelectStock?.(p.code, p.name)}>
                      {p.name}
                    </button>
                    {p.safe && <i className="cis-safe">안전</i>}
                    {p.dueDate && <i className="cis-due">미수 {p.dueDate}</i>}
                  </td>
                  <td className="num">{p.qty.toLocaleString()}</td>
                  <td className="num">{p.avg.toLocaleString()}</td>
                  <td className="num">{p.price !== null ? p.price.toLocaleString() : "-"}</td>
                  <td className={`num ${p.pnl !== null ? cls(p.pnl) : ""}`}>
                    {p.pnl !== null ? `${signed(p.pnl)} (${p.pnlPct}%)` : "-"}
                  </td>
                  <td className="num">{p.stop?.toLocaleString() ?? "-"}</td>
                  <td className="num">{p.target?.toLocaleString() ?? "-"}</td>
                  <td>{p.funding === "cash" ? "예수금" : p.funding === "misu" ? "미수" : "신용"}</td>
                  <td className="cis-why">{p.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {v.curve.length > 1 && <EquityCurve curve={v.curve} seed={v.profile.seed} />}
    </>
  );
}

/**
 * 수익률 곡선 — SVG 하나로 그린다.
 *
 * 차트 라이브러리를 쓰지 않는 이유: 점이 며칠에 하나뿐이고 축도 필요 없다.
 * 무거운 것을 붙이면 이 화면이 그것 때문에 느려진다.
 */
function EquityCurve({ curve, seed }: { curve: { date: string; equity: number }[]; seed: number }) {
  const { path, base, min, max } = useMemo(() => {
    const vals = curve.map((c) => c.equity);
    const lo = Math.min(...vals, seed);
    const hi = Math.max(...vals, seed);
    const span = hi - lo || 1;
    const x = (i: number) => (i / Math.max(1, curve.length - 1)) * 100;
    const y = (v: number) => 100 - ((v - lo) / span) * 100;
    return {
      path: curve.map((c, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(2)},${y(c.equity).toFixed(2)}`).join(" "),
      base: y(seed).toFixed(2),
      min: lo,
      max: hi,
    };
  }, [curve, seed]);

  return (
    <section className="cis-curve">
      <h3 className="section-heading">평가액 흐름</h3>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="cis-curve-svg">
        {/* 시드 선 — 본전이 어디인지가 이 그림에서 제일 중요한 정보다 */}
        <line x1="0" y1={base} x2="100" y2={base} className="cis-curve-base" />
        <path d={path} className="cis-curve-line" />
      </svg>
      <div className="table-note">
        {curve[0].date} ~ {curve[curve.length - 1].date} · {won(min)} ~ {won(max)} · 가로선은 시드({억(seed)})
      </div>
    </section>
  );
}

/* ══════════════════════════════════════════════════════════ 통계 */

function StatsTab({ account }: { account: string }) {
  const [s, setS] = useState<CisStats | null>(null);

  useEffect(() => {
    setS(null);
    api.cisStats(account).then(setS).catch(() => setS(null));
  }, [account]);

  if (!s) return <div className="empty">불러오는 중…</div>;
  if (s.trades === 0) {
    return <div className="empty">아직 청산된 매매가 없어 성적을 낼 수 없습니다.</div>;
  }

  return (
    <>
      <div className="cis-cards">
        <div className="cis-card">
          <i>총 수익률</i>
          <b className={cls(s.totalReturn)}>
            {s.totalReturn > 0 ? "+" : ""}
            {s.totalReturn}%
          </b>
          <span>{s.days}일 · 실현 {signed(s.realized)}</span>
        </div>
        <div className="cis-card">
          <i>승률</i>
          <b>{s.winRate}%</b>
          <span>
            {s.wins}승 {s.trades - s.wins}패 · {s.trades}건
          </span>
        </div>
        <div className="cis-card">
          <i>손익비</i>
          <b className={s.payoff !== null && s.payoff >= 2 ? "positive" : ""}>
            {s.payoff !== null ? s.payoff : "-"}
          </b>
          <span>추세추종은 2 를 넘어야 합니다</span>
        </div>
        <div className="cis-card">
          <i>최대낙폭</i>
          <b className="negative">{s.mdd}%</b>
          <span>평균 보유 {s.avgHold}일</span>
        </div>
        <div className="cis-card">
          <i>매매 비용</i>
          <b className="negative">{won(s.cost)}</b>
          <span>수수료·세금·이자</span>
        </div>
        {s.planRate !== null && (
          <div className="cis-card">
            <i>계획 실행률</i>
            <b>{s.planRate}%</b>
            <span>규칙 어긴 날 {s.violationDays}일</span>
          </div>
        )}
      </div>

      {(s.best || s.worst) && (
        <div className="table-note cis-extreme">
          {s.best && (
            <span>
              가장 크게 번 것 <b className="positive">{s.best.name} {signed(s.best.pnl)}</b> ({s.best.date})
            </span>
          )}
          {s.worst && (
            <span>
              가장 크게 잃은 것 <b className="negative">{s.worst.name} {signed(s.worst.pnl)}</b> ({s.worst.date})
            </span>
          )}
        </div>
      )}

      <BucketTable
        title="매도 사유별"
        hint="손절이 많으면 손절폭이 좁은 것이고, 시간 만료가 많으면 후보가 나쁜 것입니다. 고칠 데가 여기서 갈립니다."
        rows={s.byExit}
      />
      <BucketTable
        title="근거별"
        hint="어떤 화면을 보고 산 것이 나았나. 손익 합이 작은 순서 — 돈이 많이 샌 데가 위입니다."
        rows={s.byReason}
      />
      <BucketTable
        title="자금별"
        hint="신용·미수가 이자와 만기 압박을 물고도 남는 게 있었나."
        rows={s.byFunding}
      />
      <BucketTable title="시간대별" hint="아침에 산 것과 장중에 정리한 것." rows={s.bySlot} />

      {s.violations.length > 0 && (
        <>
          <h3 className="section-heading">규칙을 어긴 것</h3>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>무엇을</th>
                  <th className="num">몇 번</th>
                </tr>
              </thead>
              <tbody>
                {s.violations.map((v) => (
                  <tr key={v.text}>
                    <td>{v.text}</td>
                    <td className="num">{v.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="table-note">
            어기고 벌었어도 어긴 것입니다 — 그날 배운 게 다음에 크게 잃게 만듭니다.
          </div>
        </>
      )}
    </>
  );
}

function BucketTable({
  title,
  hint,
  rows,
}: {
  title: string;
  hint: string;
  rows: CisStats["byExit"];
}) {
  if (rows.length === 0) return null;
  return (
    <>
      <h3 className="section-heading">{title}</h3>
      <div className="data-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>구분</th>
              <th className="num">건수</th>
              <th className="num">승률</th>
              <th className="num">손익 합</th>
              <th className="num">평균</th>
              <th className="num">손익비</th>
              <th className="num">평균 보유</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              /* 표본이 적으면 흐리게 — 세 번 이겨 100% 인 줄이 눈에 세게 박히면 안 된다 */
              <tr key={b.key} className={b.trades < 5 ? "cis-thin" : ""}>
                <td>{b.label}</td>
                <td className="num">{b.trades}</td>
                <td className="num">{b.winRate}%</td>
                <td className={`num ${cls(b.pnl)}`}>{signed(b.pnl)}</td>
                <td className={`num ${cls(b.avgPnl)}`}>{signed(b.avgPnl)}</td>
                <td className="num">{b.payoff ?? "-"}</td>
                <td className="num">{b.avgHold}일</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="table-note">{hint} 건수 5 미만은 흐리게 — 표본이 적으면 믿을 값이 아닙니다.</div>
    </>
  );
}

/* ══════════════════════════════════════════════════════════ 활용법 */

function UsageTab({ account }: { account: string }) {
  const [rows, setRows] = useState<CisUsageRow[]>([]);

  useEffect(() => {
    api.cisUsage(account).then((r) => setRows(r.rows)).catch(() => setRows([]));
  }, [account]);

  if (rows.length === 0) return <div className="empty">아직 쌓인 게 없습니다.</div>;
  const maxUsed = Math.max(...rows.map((r) => r.used), 1);

  return (
    <>
      <h3 className="section-heading">어떤 화면을 보고 판단했나</h3>
      <div className="table-note">
        시스가 판단에 <b>실제로 쓴</b> 화면·지표만 셉니다. 열어만 본 것은 안 셉니다.
        자주 보는데 돈이 안 되는 화면이 보이면 그게 배움입니다.
      </div>
      <div className="data-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>화면 · 지표</th>
              <th className="num">쓴 횟수</th>
              <th>비중</th>
              <th className="num">그걸로 산 매매</th>
              <th className="num">승률</th>
              <th className="num">손익 합</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <td>{r.name}</td>
                <td className="num">{r.used}</td>
                <td>
                  <div className="cis-bar">
                    <i style={{ width: `${(r.used / maxUsed) * 100}%` }} />
                  </div>
                </td>
                <td className="num">{r.trades || "-"}</td>
                <td className="num">{r.winRate !== null ? `${r.winRate}%` : "-"}</td>
                <td className={`num ${cls(r.pnl)}`}>{r.pnl ? signed(r.pnl) : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ══════════════════════════════════════════════════════════ 설정 */

function ConfigTab({
  config,
  ruleLabels,
  aiReady,
  onSaved,
}: {
  config: CisConfig;
  ruleLabels: Record<string, CisRuleLabel>;
  aiReady: boolean;
  onSaved: (c: CisConfig) => void;
}) {
  const [draft, setDraft] = useState<CisConfig>(config);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => setDraft(config), [config]);

  const save = async (patch: Partial<CisConfig>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    setSaving(true);
    try {
      const r = await api.cisSaveConfig(next);
      onSaved(r.config);
      setDraft(r.config);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    } finally {
      setSaving(false);
    }
  };

  const rule = (k: keyof CisRules, v: number) =>
    save({ rules: { ...draft.rules, [k]: v } });

  return (
    <>
      <h3 className="section-heading">
        굴릴까
        {saving && <i className="cis-saving">저장 중…</i>}
        {saved && <i className="cis-saving positive">저장됨</i>}
      </h3>
      <div className="cis-switches">
        <label className="cis-switch">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => save({ enabled: e.target.checked })}
          />
          <span>
            <b>CIS 모드</b> — 끄면 시스가 아무것도 하지 않습니다
          </span>
        </label>
        <label className="cis-switch">
          <input
            type="checkbox"
            checked={draft.auto}
            onChange={(e) => save({ auto: e.target.checked })}
          />
          <span>
            <b>자동 실행</b> — 끄면 「오늘」에서 손으로 눌러야 씁니다
          </span>
        </label>
      </div>

      <h3 className="section-heading">언제 쓸까</h3>
      <div className="cis-times">
        {SLOTS.map((s) => (
          <label className="cis-time" key={s.key}>
            <i>
              {s.label} <span>{s.hint}</span>
            </i>
            <input
              type="time"
              className="ma-input"
              value={draft.times[s.key]}
              onChange={(e) => save({ times: { ...draft.times, [s.key]: e.target.value } })}
            />
          </label>
        ))}
      </div>
      <div className="table-note">
        정각에 딱 맞추는 게 아니라 <b>그 시각이 지났고 아직 안 썼으면</b> 씁니다 —
        미니PC가 늦게 켜져도 그날 일지가 남습니다.
      </div>

      <h3 className="section-heading">매매 규칙</h3>
      <div className="cis-rules">
        {(Object.keys(draft.rules) as (keyof CisRules)[]).map((k) => {
          const L = ruleLabels[k];
          if (!L) return null;
          return (
            <label className="cis-rule" key={k}>
              <i>
                {L.label}
                <span>{L.hint}</span>
              </i>
              <span className="cis-rule-in">
                <input
                  type="number"
                  className="ma-input short"
                  value={draft.rules[k]}
                  onChange={(e) =>
                    setDraft({ ...draft, rules: { ...draft.rules, [k]: Number(e.target.value) } })
                  }
                  onBlur={(e) => rule(k, Number(e.target.value))}
                />
                <em>{L.unit}</em>
              </span>
            </label>
          );
        })}
      </div>

      <h3 className="section-heading">AI 를 어디에 쓸까</h3>
      {!aiReady && (
        <div className="table-note negative">
          ANTHROPIC_API_KEY 가 없어 AI 는 쉽니다. 일지는 규칙이 만든 글로 그대로 남습니다.
        </div>
      )}
      <div className="cis-switches">
        <label className="cis-switch">
          <input
            type="checkbox"
            checked={draft.ai.narrate}
            onChange={(e) => save({ ai: { ...draft.ai, narrate: e.target.checked } })}
          />
          <span>
            <b>일지 문장 다듬기</b> — 규칙이 만든 뼈대를 시스의 목소리로. 판단과 무관합니다
          </span>
        </label>
        <label className="cis-switch">
          <input
            type="checkbox"
            checked={draft.ai.screen}
            onChange={(e) => save({ ai: { ...draft.ai, screen: e.target.checked } })}
          />
          <span>
            <b>후보 경고</b> — 숫자로 안 잡히는 것(급등 뒤 첫 음봉, 하루짜리 테마)을 짚습니다
          </span>
        </label>
        <label className="cis-switch">
          <input
            type="checkbox"
            checked={draft.ai.weekly}
            onChange={(e) => save({ ai: { ...draft.ai, weekly: e.target.checked } })}
          />
          <span>
            <b>주간 복기</b> — 며칠치를 놓고 어느 규칙이 나빴나
          </span>
        </label>
        <label className={`cis-switch ${draft.ai.screenVeto ? "cis-danger" : ""}`}>
          <input
            type="checkbox"
            checked={draft.ai.screenVeto}
            onChange={(e) => save({ ai: { ...draft.ai, screenVeto: e.target.checked } })}
          />
          <span>
            <b>AI 거부권</b> — 경고한 종목을 <b>실제로 안 삽니다</b>
            <i>
              ⚠️ 켜면 같은 날을 다시 돌려도 같은 답이 안 나옵니다. 성적이 나빠도 어느 규칙이
              나빴는지 짚을 수 없게 됩니다. 켜고 한 달, 끄고 한 달 돌려 비교해 보는 용도입니다.
            </i>
          </span>
        </label>
      </div>

      <h3 className="section-heading">목표</h3>
      <div className="cis-goals-edit">
        {draft.goals.map((g, i) => (
          <label className="cis-rule" key={i}>
            <i>{i + 1}차</i>
            <span className="cis-rule-in">
              <input
                type="number"
                className="ma-input"
                value={g}
                onChange={(e) => {
                  const next = [...draft.goals];
                  next[i] = Number(e.target.value);
                  setDraft({ ...draft, goals: next });
                }}
                onBlur={() => save({ goals: draft.goals })}
              />
              <em>{억(g)}</em>
            </span>
          </label>
        ))}
      </div>
      <div className="table-note">
        목표는 <b>화면과 글에만</b> 씁니다 — 목표에 쫓겨 비중을 키우는 것이 계좌를 죽이는
        가장 흔한 길이라, 매매 판단에는 넣지 않았습니다.
      </div>
    </>
  );
}
