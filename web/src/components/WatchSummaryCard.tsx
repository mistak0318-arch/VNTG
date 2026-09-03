import { useMemo, useState } from "react";
import { fmtNum, signClass, type TrackedStock, type WatchStatus } from "../api";

/**
 * **관심종목 요약 카드** (2026-09-03 개편).
 *
 * 벤티지: "관심종목 요약 카드 접을 수 있게 해주고 기본 설정이 접음으로 가게 하고. 거기서
 * 숫자 보여주잖아 그거 더 구체화해서 보여주고 각 숫자들 클릭하면 종목 나열되게 해줘.
 * 숫자 종류도 잘 생각해서 보면 좋을만 한거 해주고."
 *
 * 예전엔 넷(수익 중·정배열·외인 5일·기관 5일)이 늘 펼쳐져 있었고 숫자는 그냥 숫자였다 —
 * 「수익 중 12」를 보고 **어느 열둘인지**는 표를 다시 훑어야 했다.
 *
 * 지금은:
 *   · 접힌 채로 시작(기기마다 기억). 접혀 있어도 머리에 한 줄 — ▲오름 ▼내림 · 수익 n/m · 쌍끌이 n.
 *   · 숫자는 일곱 묶음 — 오늘 · 수익 · 추세 · 수급 · 판정 · 목표가 · 상태.
 *   · 숫자를 누르면 그 종목들이 카드 안에 나열된다(당일 등락·수익률 붙여서). 이름을 누르면 종목으로.
 *   · 셈은 **지금 보고 있는 그룹·상태 필터 안에서**다 — 「반도체 그룹에서 오늘 내린 것」이 자연스러운 질문이다.
 *
 * 값은 표와 같은 것을 쓴다 — 실시간이 있으면 당일·수익률은 실시간(1.5초)이 먼저다.
 */

export interface SummaryRow {
  r: TrackedStock;
  /** 당일 등락률 — 실시간이 있으면 그것 */
  rate: number;
  /** 편입가 대비 수익률 — 실시간이 있으면 그것 */
  ret: number | null;
  /** 편입 후 며칠 */
  held: number;
}

type Tone = "up" | "down" | "warn" | "";

interface Stat {
  key: string;
  label: string;
  hint: string;
  tone: Tone;
  pick: (x: SummaryRow) => boolean;
}

interface StatGroup {
  title: string;
  stats: Stat[];
}

const COLLAPSE_KEY = "vntg.watch.summary.collapsed";
function readCollapsed(): boolean {
  try {
    const v = localStorage.getItem(COLLAPSE_KEY);
    return v === null ? true : v === "1";
  } catch {
    return true;
  }
}

function fmtPct(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "-";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

/**
 * 숫자 묶음. 「보면 좋을 것」의 기준 — 이 화면에서 **다음 행동**이 갈리는 것들:
 *   오늘 급락은 손절 점검, 손실 -10% 는 시나리오 재검, 석 달 묵음은 정리 후보,
 *   쌍끌이는 진입 후보, 동반 순매도·20일선 아래는 경계, 의견 하향은 목표가 다시 보기.
 */
function buildGroups(statuses: { key: WatchStatus; label: string }[]): StatGroup[] {
  const g: StatGroup[] = [
    {
      title: "오늘",
      stats: [
        { key: "up", label: "상승", hint: "당일 등락률 > 0", tone: "up", pick: (x) => x.rate > 0 },
        { key: "down", label: "하락", hint: "당일 등락률 < 0", tone: "down", pick: (x) => x.rate < 0 },
        { key: "surge", label: "+3% 이상", hint: "오늘 3% 넘게 올랐다 — 쫓아 살 자리는 아닌지", tone: "up", pick: (x) => x.rate >= 3 },
        { key: "plunge", label: "-3% 이하", hint: "오늘 3% 넘게 빠졌다 — 손절선 점검", tone: "warn", pick: (x) => x.rate <= -3 },
      ],
    },
    {
      title: "수익 (편입가 대비)",
      stats: [
        { key: "profit", label: "수익 중", hint: "편입가보다 위", tone: "up", pick: (x) => (x.ret ?? 0) > 0 },
        { key: "loss", label: "손실 중", hint: "편입가보다 아래", tone: "down", pick: (x) => (x.ret ?? 0) < 0 },
        { key: "profit10", label: "+10% 이상", hint: "익절·추적 손절 검토 구간", tone: "up", pick: (x) => (x.ret ?? 0) >= 10 },
        { key: "loss10", label: "-10% 이하", hint: "시나리오가 깨졌는지 다시 볼 자리", tone: "warn", pick: (x) => (x.ret ?? 0) <= -10 },
        { key: "stale", label: "석 달 넘게", hint: "편입 91일 이상 — 오래 들고 있는데 안 가는 것부터 정리", tone: "warn", pick: (x) => x.held >= 91 },
      ],
    },
    {
      title: "추세",
      stats: [
        { key: "trend", label: "정배열", hint: "5 > 20 > 60 > 120일선", tone: "up", pick: (x) => x.r.trendPass === true },
        { key: "above5", label: "5일선 위", hint: "종가가 5일선 위", tone: "up", pick: (x) => x.r.above5 === true },
        { key: "above20", label: "20일선 위", hint: "종가가 20일선 위 — 스윙 기준선", tone: "up", pick: (x) => x.r.above20 === true },
        { key: "below20", label: "20일선 아래", hint: "스윙 기준선 아래 — 추세가 꺾였을 수 있다", tone: "warn", pick: (x) => x.r.above20 === false },
      ],
    },
    {
      title: "수급 (순매수)",
      stats: [
        { key: "fgn5", label: "외인 5일", hint: "외국인 5일 순매수 > 0", tone: "up", pick: (x) => x.r.foreign5 > 0 },
        { key: "fgn20", label: "외인 20일", hint: "외국인 20일 순매수 > 0", tone: "up", pick: (x) => x.r.foreign20 > 0 },
        { key: "inst5", label: "기관 5일", hint: "기관 5일 순매수 > 0", tone: "up", pick: (x) => x.r.inst5 > 0 },
        { key: "inst20", label: "기관 20일", hint: "기관 20일 순매수 > 0", tone: "up", pick: (x) => x.r.inst20 > 0 },
        { key: "both5", label: "쌍끌이 5일", hint: "외국인·기관 둘 다 5일 순매수", tone: "up", pick: (x) => x.r.foreign5 > 0 && x.r.inst5 > 0 },
        { key: "sell5", label: "동반 순매도 5일", hint: "외국인·기관 둘 다 5일 순매도 — 경계", tone: "warn", pick: (x) => x.r.foreign5 < 0 && x.r.inst5 < 0 },
      ],
    },
    {
      title: "판정",
      stats: [
        { key: "short", label: "공매도 감소", hint: "최근 3일 공매도 줄어듦", tone: "up", pick: (x) => x.r.shortTrend != null && x.r.shortTrend < 0 },
        { key: "lend", label: "대차 감소", hint: "최근 3일 대차잔고 줄어듦", tone: "up", pick: (x) => x.r.lendingTrend != null && x.r.lendingTrend < 0 },
        { key: "profitUp", label: "영업이익 증가", hint: "최근 분기 영업이익 증가", tone: "up", pick: (x) => x.r.profitUp === true },
        { key: "sector", label: "섹터 강세", hint: "업종이 시장보다 강하다", tone: "up", pick: (x) => x.r.sectorStrong === true },
        { key: "pass70", label: "충족 70%↑", hint: "판정 항목 중 70% 이상 통과", tone: "up", pick: (x) => x.r.passTotal > 0 && x.r.passCount / x.r.passTotal >= 0.7 },
        { key: "pass40", label: "충족 40%↓", hint: "판정 항목 중 40% 미만 통과", tone: "warn", pick: (x) => x.r.passTotal > 0 && x.r.passCount / x.r.passTotal < 0.4 },
      ],
    },
    {
      title: "목표가 (증권사)",
      stats: [
        { key: "upside20", label: "여력 +20%↑", hint: "컨센서스 목표가까지 20% 넘게 남음", tone: "up", pick: (x) => (x.r.upside ?? -999) >= 20 },
        { key: "upsideNeg", label: "목표가 넘음", hint: "현재가가 목표가 위 — 상향이 따라오는지", tone: "warn", pick: (x) => x.r.upside != null && x.r.upside < 0 },
        { key: "opUp", label: "의견 상향", hint: "최근 60일 목표가·의견 상향", tone: "up", pick: (x) => (x.r.opinionMove ?? 0) > 0 },
        { key: "opDown", label: "의견 하향", hint: "최근 60일 목표가·의견 하향", tone: "warn", pick: (x) => (x.r.opinionMove ?? 0) < 0 },
      ],
    },
    {
      title: "상태",
      stats: [
        ...statuses.map<Stat>((s) => ({
          key: `st-${s.key}`,
          label: s.label,
          hint: `상태 「${s.label}」`,
          tone: s.key === "holding" ? "up" : "",
          pick: (x) => (x.r.status ?? "watching") === s.key,
        })),
        { key: "err", label: "조회 오류", hint: "시세·수급을 못 받은 종목 — 상장폐지·코드 변경일 수 있다", tone: "warn", pick: (x) => Boolean(x.r.error) },
      ],
    },
  ];
  return g;
}

export function WatchSummaryCard({
  rows,
  scopeLabel,
  statuses,
  onSelectStock,
}: {
  rows: SummaryRow[];
  /** 「전체」 또는 그룹 이름 — 어느 범위를 센 것인지 */
  scopeLabel: string;
  statuses: { key: WatchStatus; label: string }[];
  onSelectStock: (code: string, name: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed);
  const [picked, setPicked] = useState<string | null>(null);
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
    } catch {
      /* 저장 못 해도 이번 화면은 동작한다 */
    }
  };

  const groups = useMemo(() => buildGroups(statuses), [statuses]);
  const counts = useMemo(() => {
    const m = new Map<string, SummaryRow[]>();
    for (const g of groups) for (const s of g.stats) m.set(s.key, rows.filter(s.pick));
    return m;
  }, [groups, rows]);
  const n = (k: string) => counts.get(k)?.length ?? 0;
  const pickedStat = groups.flatMap((g) => g.stats).find((s) => s.key === picked) ?? null;
  const pickedRows = pickedStat ? (counts.get(pickedStat.key) ?? []) : [];

  return (
    <section className={`card collapsible wl-sum${collapsed ? "" : " open"}`}>
      <button type="button" className="collapsible-head" onClick={toggle} aria-expanded={!collapsed}>
        <span className={`collapsible-caret${collapsed ? "" : " open"}`}>▶</span>
        <h2>
          관심종목 요약 <small className="wl-sum-scope">{scopeLabel} · {rows.length}</small>
        </h2>
        {/* 접혀 있어도 오늘의 형편은 한 줄로 보인다 */}
        <span className="wl-sum-brief">
          <b className="positive">▲{n("up")}</b> <b className="negative">▼{n("down")}</b>
          <i>·</i> 수익 {n("profit")}/{rows.length}
          <i>·</i> 쌍끌이 {n("both5")}
          {n("plunge") > 0 && (
            <>
              <i>·</i> <b className="wl-sum-warn">-3%↓ {n("plunge")}</b>
            </>
          )}
        </span>
      </button>
      {!collapsed && (
        <div className="collapsible-body">
          <div className="wl-sum-groups">
            {groups.map((g) => (
              <div key={g.title} className="wl-sum-group">
                <div className="wl-sum-title">{g.title}</div>
                <div className="wl-sum-stats">
                  {g.stats.map((s) => {
                    const c = n(s.key);
                    const on = picked === s.key;
                    return (
                      <button
                        key={s.key}
                        type="button"
                        className={`wl-sum-stat tone-${s.tone || "none"}${on ? " on" : ""}${c === 0 ? " zero" : ""}`}
                        title={s.hint}
                        disabled={c === 0}
                        onClick={() => setPicked(on ? null : s.key)}
                      >
                        <span className="label">{s.label}</span>
                        <span className="value">{c}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          {pickedStat && (
            <div className="wl-sum-list">
              <div className="wl-sum-list-head">
                <b>{pickedStat.label}</b> {pickedRows.length}종목 <em>— {pickedStat.hint}</em>
                <span className="wl-sum-cols">당일 · 편입가 대비</span>
                <button type="button" className="wl-sum-close" onClick={() => setPicked(null)} title="목록 닫기">
                  ✕
                </button>
              </div>
              <div className="wl-sum-items">
                {pickedRows.map((x) => (
                  <button
                    key={x.r.code}
                    type="button"
                    className="wl-sum-item"
                    onClick={() => onSelectStock(x.r.code, x.r.name)}
                    title={`${x.r.code} · 편입가 ${fmtNum(x.r.addedPrice)} · ${x.held}일 경과`}
                  >
                    <span className="nm">{x.r.name}</span>
                    <span className={`d ${signClass(x.rate)}`}>{fmtPct(x.rate)}</span>
                    <span className={`d ${signClass(x.ret)}`}>{fmtPct(x.ret)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
