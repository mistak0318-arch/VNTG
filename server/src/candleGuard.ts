/**
 * 유령 봉 걸러내기 (2026-08-31).
 *
 * ## 무엇이 문제였나
 *
 * 키움 일봉(`ka10081` 종목 · `ka20006` 지수)은 **장이 열리기 전에도 오늘 봉을 준다.**
 * 실측(2026-08-31 07:30, 장 전):
 *
 * ```
 * 삼성전자  20260831 종가 257000 거래량 0 거래대금 0   ← 유령
 *          20260828 종가 257000 거래량 15,106,746
 * 코스피    20260831 시고저종이 전부 6788.88, 거래대금 0  ← 유령
 * ```
 *
 * 종가 자리에 **전일 종가가 그대로** 들어 있어서 값만 보면 멀쩡해 보인다. 그래서
 * 여기저기서 조용히 틀렸다:
 *
 *   · 리포트 상단 — 「8/31(월) 종가 기준 · 코스피 0.00% · 거래대금 0억」
 *   · 복기 채점 — 기준일과 채점일이 다른데 등락 0% → 「부분 적중」이 무더기로
 *   · 신호등 — 이동평균이 **한 칸씩 밀린다.** 전일 종가가 두 번 세어지고 가장
 *     오래된 하루가 빠진다. 매일 아침 조금씩 다른 값을 내다가 15:30 뒤에 제자리로
 *     돌아오니 **눈치채기가 아주 어렵다.**
 *
 * ## 오늘 봉만 본다
 *
 * 「거래량 0인 봉을 전부 버린다」로 하면 거래정지·아주 오래된 종목의 과거 봉까지
 * 사라져 이동평균 구간이 실제보다 길어진다. 문제는 **오늘 봉 하나**이므로 오늘만
 * 검사한다 — 부작용이 없는 쪽으로.
 */

/** KST 오늘 (YYYYMMDD) — 일봉이 주는 형식 */
function kstToday(): string {
  const d = new Date(Date.now() + 9 * 3600_000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`;
}

function num(v: unknown): number {
  const n = Number(String(v ?? "").replace(/[+,%\s]/g, ""));
  return Number.isFinite(n) ? Math.abs(n) : 0;
}

/**
 * 오늘 봉이 **거래 없는 껍데기면 뺀다.**
 *
 * 최신순·오래된순 어느 쪽으로 정렬돼 있어도 된다 — 날짜로 찾아서 그 한 줄만 뺀다.
 *
 * @param rows 키움 일봉 원본 행들
 * @param dateKey 날짜 필드 이름 (기본 `dt`)
 */
export function dropPhantomToday<T extends Record<string, unknown>>(
  rows: T[],
  dateKey = "dt",
): T[] {
  const today = kstToday();
  return rows.filter((r) => {
    if (String(r[dateKey] ?? "") !== today) return true;
    /* 거래량·거래대금이 **둘 다** 0 이면 아직 안 열렸거나 안 끝난 날이다 */
    const traded = num(r.trde_qty) > 0 || num(r.trde_prica) > 0;
    return traded;
  });
}
