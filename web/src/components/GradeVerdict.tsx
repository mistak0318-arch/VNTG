/**
 * **성적표 결론 카드** (2026-09-16 밤 — 벤티지: "내가 인사이트를 얻을 수 있는 데이터를 어떻게 봐야 하는 거야?
 * 눈에 확 들어오지를 않아서").
 *
 * 슈퍼신호등 채점표와 신호등 분석 「편입 후 성적」이 같은 자(편입일 종가 대비)라 결론도 같은 부품으로 낸다.
 * 표는 숫자 60개인데 사람이 실제로 묻는 건 셋이다:
 *
 *   ① 이 표를 **읽어도 되나** — 표본이 30 넘는 줄이 몇 개고, 지수 대비 20일이 찼나
 *   ② **전체보다 나은 줄**은 무엇인가 — 절대 수익률이 아니라 전체 대비 %p
 *   ③ 지금 **하지 말아야 할 판단**은 무엇인가 — 표본 부족·지수 대비 없음이면 매매 기준을 바꾸지 마라
 *
 * 그리고 표 쪽엔 두 가지 강조만 남긴다: 표본 30 미만은 흐리게(읽지 마라), 전체 대비 +1%p 넘으면 굵게.
 * 색을 더 칠하지 않는다 — 다 칠하면 아무것도 안 보인다.
 */

export interface VerdictRow {
  label: string;
  /** 「전체」 줄인가 — 견주는 기준 */
  base?: boolean;
  /** 고른 구간의 표본 수·평균(%) */
  n: number;
  avg: number | null;
  /** 승률(%) — 있으면 평균 옆에 적는다 */
  win?: number | null;
}

export interface Verdict {
  horizon: string;
  /** 읽을 수 있는 줄(표본 ≥ minN, 전체 제외) */
  readable: number;
  total: number;
  base: VerdictRow | null;
  /** 전체보다 나은 줄 — diff 내림차순 */
  better: { row: VerdictRow; diff: number }[];
  worse: { row: VerdictRow; diff: number }[];
  /** 줄마다 강조 — 표가 쓴다 */
  emphasis: Record<string, "thin" | "strong" | "">;
}

export const MIN_N = 30;

export function verdictOf(rows: VerdictRow[], horizon: string, minN = MIN_N): Verdict {
  const base = rows.find((r) => r.base) ?? null;
  const others = rows.filter((r) => !r.base);
  const scored = others
    .filter((r) => r.n >= minN && r.avg !== null && base?.avg !== null && base !== null)
    .map((r) => ({ row: r, diff: Math.round(((r.avg as number) - (base!.avg as number)) * 10) / 10 }));
  const better = scored.filter((s) => s.diff >= 1).sort((a, b) => b.diff - a.diff);
  const worse = scored.filter((s) => s.diff <= -1).sort((a, b) => a.diff - b.diff);
  const emphasis: Record<string, "thin" | "strong" | ""> = {};
  for (const r of others) emphasis[r.label] = r.n < minN ? "thin" : better.some((b) => b.row.label === r.label) ? "strong" : "";
  return { horizon, readable: others.filter((r) => r.n >= minN).length, total: others.length, base, better, worse, emphasis };
}

const pct = (v: number | null) => (v === null ? "-" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`);
const pp = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)}%p`;

export function GradeVerdict({
  v,
  hasExcess,
  what,
}: {
  v: Verdict;
  /** 지수 대비 열이 찼나 — 안 찼으면 절대 수익률뿐이라 착시 경고 */
  hasExcess: boolean;
  /** 「슈퍼신호등」·「신호등 분석」 */
  what: string;
}) {
  const b = v.base;
  const readableOk = v.readable >= 3;
  const line1 = b
    ? `${v.horizon} 기준 전체 ${pct(b.avg)} (${b.n}건${b.win != null ? ` · 승률 ${Math.round(b.win)}%` : ""}) · 읽을 수 있는 줄 ${v.readable}/${v.total}개(표본 ${MIN_N}↑)`
    : "전체 줄이 아직 없습니다";
  const line2 =
    v.better.length > 0
      ? `전체보다 나은 줄: ${v.better
          .slice(0, 3)
          .map((s) => `${s.row.label} ${pp(s.diff)} (${s.row.n})`)
          .join(" · ")}`
      : readableOk
        ? "전체보다 +1%p 넘게 나은 줄이 아직 없습니다 — 지금은 「목록별 차이 없음」이 결론입니다"
        : "전체보다 나은 줄을 가릴 만큼 표본이 안 찼습니다";
  const line2b = v.worse.length > 0 ? `전체보다 못한 줄: ${v.worse.slice(0, 2).map((s) => `${s.row.label} ${pp(s.diff)} (${s.row.n})`).join(" · ")}` : null;
  const warn: string[] = [];
  if (!hasExcess) warn.push("지수 대비 열이 아직 비어 있어 **절대 수익률**입니다 — 이 기간 시장이 올랐으면 그만큼 부풀려진 값");
  if (!readableOk) warn.push(`표본 ${MIN_N}건 넘는 줄이 ${v.readable}개뿐 — 한 종목이 평균을 끌 수 있습니다`);
  if (v.horizon.startsWith("1일") || v.horizon.startsWith("5일")) warn.push("20일 뒤가 차야 뜻이 있습니다(신호등 검증은 20일 자)");
  return (
    <div className={`gv${readableOk && hasExcess ? " gv-ok" : ""}`}>
      <div className="gv-l1">
        <b>{what} · 지금 읽히는 것</b> {line1}
      </div>
      <div className="gv-l2">{line2}{line2b ? <span className="gv-worse"> · {line2b}</span> : null}</div>
      {warn.length > 0 && (
        <div className="gv-warn">
          {warn.map((w, i) => (
            <span key={i} dangerouslySetInnerHTML={{ __html: `⚠ ${w.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")}` }} />
          ))}
          <span className="gv-rule">이 상태에서는 매매 기준을 바꾸지 마세요 — 12월 동결 해제 때 표본으로 답합니다.</span>
        </div>
      )}
      <div className="gv-key">표: 표본 {MIN_N} 미만 줄은 흐리게(읽지 마세요) · 전체보다 +1%p 넘는 줄만 굵게</div>
    </div>
  );
}
