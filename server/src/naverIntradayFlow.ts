import { recordApiCall } from "./apiUsage.js";

/**
 * 장중 투자자별 **누적 순매수** (2026-08-26 실측 — 「차트 밑에 장중 수급 변화 찍어줘」).
 *
 * 네이버 금융 investorDealTrendTime.naver — 일별(Day)과 같은 표를 **2분 간격**으로
 * 준다. `bizdate=YYYYMMDD&sosok=` 01 코스피 · 02 코스닥 · 03 K200 선물.
 *
 *   행 = <td class="date2">HH:MM</td> + 숫자 10칸(개인·외국인·기관계·기관 세부 6·기타)
 *   단위 = 코스피/코스닥 **억원**, 선물 **계약** (머리글 실측)
 *   한 쪽 10행, 하루 37쪽쯤(09:00~18:06) — 쪽수는 Nnavi 의 최댓값
 *
 * 하루치 = 쪽 수만큼의 요청이다. **시트를 열 때만** 부르고, 오늘은 10분·지난 날짜는
 * 하루 캐시한다. 값이 누적이라 곡선 자체가 「장중 수급 변화」다.
 */

export interface IntraFlowPoint {
  /** HH:MM */
  t: string;
  individual: number;
  foreign: number;
  institution: number;
}

export type FlowMarket = "01" | "02" | "03";

const cache = new Map<string, { at: number; date: string; points: IntraFlowPoint[] }>();

function num(s: string): number {
  const n = Number(s.replace(/[,+\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function kstDate(back: number): string {
  return new Date(Date.now() + 9 * 3600_000 - back * 86_400_000)
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, "");
}

async function fetchPage(
  sosok: FlowMarket,
  bizdate: string,
  page: number,
): Promise<{ points: IntraFlowPoint[]; maxPage: number }> {
  const res = await fetch(
    `https://finance.naver.com/sise/investorDealTrendTime.naver?bizdate=${bizdate}&sosok=${sosok}&page=${page}`,
    { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = new TextDecoder("euc-kr").decode(await res.arrayBuffer());

  const points: IntraFlowPoint[] = [];
  const rowRe = /<td class="date2">(\d{2}:\d{2})<\/td>([\s\S]*?)<\/tr>/g;
  for (const m of html.matchAll(rowRe)) {
    const nums = [...m[2].matchAll(/>\s*([+-]?[\d,]+)\s*</g)].map((x) => num(x[1]));
    if (nums.length < 3) continue;
    points.push({ t: m[1], individual: nums[0], foreign: nums[1], institution: nums[2] });
  }

  // 그 날짜의 총 쪽수 — 링크가 &amp;page= 로 이스케이프라 앞걸이 없이 page= 만 본다
  let maxPage = 1;
  const navAt = html.indexOf('class="Nnavi"');
  if (navAt >= 0) {
    const nav = html.slice(navAt, html.indexOf("</table>", navAt) + 8);
    for (const m of nav.matchAll(/page=(\d+)/g)) maxPage = Math.max(maxPage, Number(m[1]));
  }
  return { points, maxPage };
}

/** 하루치 장중 누적 곡선 — 시간 오름차순 */
export async function intradayFlow(
  sosok: FlowMarket,
): Promise<{ date: string; points: IntraFlowPoint[] }> {
  const hit = cache.get(sosok);
  if (hit) {
    const past = hit.date !== kstDate(0);
    if (Date.now() - hit.at < (past ? 24 * 3600_000 : 10 * 60_000)) {
      return { date: hit.date, points: hit.points };
    }
  }

  try {
    // 오늘이 휴장이면 표가 빈다 — 값이 나오는 날까지 최대 닷새 물러난다
    for (let back = 0; back < 5; back++) {
      const bizdate = kstDate(back);
      const first = await fetchPage(sosok, bizdate, 1);
      if (first.points.length === 0) continue;

      const maxPage = Math.min(first.maxPage, 40);
      const all = [...first.points];
      // 4개씩 묶어서 — 37쪽을 줄줄이 기다리면 시트가 10초를 넘긴다
      for (let p = 2; p <= maxPage; p += 4) {
        const batch = await Promise.all(
          [p, p + 1, p + 2, p + 3]
            .filter((x) => x <= maxPage)
            .map((x) => fetchPage(sosok, bizdate, x).catch(() => ({ points: [], maxPage: 0 }))),
        );
        for (const b of batch) all.push(...b.points);
      }

      const seen = new Set<string>();
      const points = all
        .filter((x) => (seen.has(x.t) ? false : (seen.add(x.t), true)))
        .sort((a, b) => a.t.localeCompare(b.t));
      const date = `${bizdate.slice(0, 4)}-${bizdate.slice(4, 6)}-${bizdate.slice(6, 8)}`;
      cache.set(sosok, { at: Date.now(), date, points });
      void recordApiCall("naver", `intraFlow:${sosok}`, "ok");
      return { date, points };
    }
    return { date: "", points: [] };
  } catch (e) {
    void recordApiCall("naver", `intraFlow:${sosok}`, "failed");
    if (hit) return { date: hit.date, points: hit.points };
    throw e;
  }
}
