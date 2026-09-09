import type { TrackedStock } from "../api";

/**
 * 판정 칩 「정 캔 공 대 목 의」 — 관심종목(VNTG) 표와 현미경 표가 같은 것을 그린다
 * (2026-09-09 밤 — 벤티지 "이거 판정카드 현미경 표 메모 앞에 붙여줘").
 *
 * 초록 = 조건 충족, 파랑 = 미달, 회색 = 판단 불가(데이터 없음). 뜻은 글자에 마우스를 올리면.
 * 영업이익·업종 강세는 뺐다 — 신호등에서 그 두 기준이 꺼져 있어 늘 「모름」이었다.
 */
export type JudgeSource = Pick<
  TrackedStock,
  "trendPass" | "above5" | "above20" | "shortTrend" | "lendingTrend" | "upside" | "opinionMove"
>;

export function judgeItems(r: JudgeSource): { l: string; ok: boolean | null; hint: string }[] {
  return [
    { l: "정", ok: r.trendPass, hint: "정배열 — 현재가 ≥ 5일 ≥ 20일 ≥ 60일 ≥ 120일선" },
    {
      l: "캔",
      ok: r.above5 === null && r.above20 === null ? null : Boolean(r.above5 || r.above20),
      hint: "종가가 5일선 또는 20일선 위",
    },
    { l: "공", ok: r.shortTrend == null ? null : r.shortTrend < 0, hint: "공매도 수량 3일 감소 — 줄어야 초록" },
    { l: "대", ok: r.lendingTrend == null ? null : r.lendingTrend < 0, hint: "대차잔고 3일 감소 — 줄어야 초록" },
    { l: "목", ok: r.upside == null ? null : r.upside >= 10, hint: "증권사 목표가까지 10% 이상 남음" },
    { l: "의", ok: r.opinionMove == null ? null : r.opinionMove >= 0, hint: "최근 60일 투자의견 하향 없음(상향이면 가점)" },
  ];
}

export function JudgeChips({ r }: { r: JudgeSource }) {
  return (
    <span className="wl-judge">
      {judgeItems(r).map(({ l, ok, hint }) => (
        <em key={l} className={ok === null || ok === undefined ? "na" : ok ? "ok" : "bad"} title={hint}>
          {l}
        </em>
      ))}
    </span>
  );
}

/** 표 아래 설명 — 색 뜻과 글자 뜻. 두 표가 같은 문장을 쓴다 */
export function JudgeLegend() {
  return (
    <>
      <b>판정 칸</b> — <em className="wl-judge-legend ok">초록</em> 조건 충족 ·{" "}
      <em className="wl-judge-legend bad">파랑</em> 미달 · <em className="wl-judge-legend na">회색</em> 판단 불가(데이터 없음).{" "}
      <b>정</b> 정배열(현재가≥5일≥20일≥60일≥120일선) · <b>캔</b> 종가가 5일선 또는 20일선 위 ·{" "}
      <b>공</b> 공매도 수량 3일 감소 · <b>대</b> 대차잔고 3일 감소 (둘 다 <b>줄어야</b> 초록) ·{" "}
      <b>목</b> 목표가까지 10% 이상 남음 · <b>의</b> 최근 60일 투자의견 하향 없음
    </>
  );
}
