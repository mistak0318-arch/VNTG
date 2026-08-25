import { recordApiCall } from "./apiUsage.js";

/**
 * 코스피200 선물 투자자별 수급 (2026-08-25 실측).
 *
 * 키움 REST 는 선물 투자자 수급을 안 준다(확인·포기했던 항목). 채널을 다시 뒤져
 * **네이버 금융**에서 찾았다 — HTS [0403]과 같은 내용이 무인증 HTML 로 열려 있다:
 *
 *   일별   finance.naver.com/sise/investorDealTrendDay.naver?bizdate=YYYYMMDD&sosok=03
 *   장중   …investorDealTrendTime.naver — 분 단위 누적 (같은 표 구조)
 *
 * 실측(2026-08-25): 개인 -1,080 · 외국인 -357 · 기관계 +1,476 계약, 연기금·투신
 * 세부까지. 단위는 **계약(순매수)** 이다.
 *
 * EUC-KR 인코딩이라 TextDecoder("euc-kr") 로 푼다(Node full-ICU 포함 확인).
 * HTML 표 파싱은 깨지기 쉬우니 — 숫자 셀 개수(10칸)를 검증하고, 안 맞으면
 * 그 줄만 버린다. 구조가 통째로 바뀌면 빈 배열 + 지난 캐시다.
 */

export interface FuturesFlowDay {
  /** YYYY-MM-DD */
  date: string;
  /** 순매수 계약 */
  individual: number;
  foreign: number;
  institution: number;
}

let cache: { at: number; days: FuturesFlowDay[] } = { at: 0, days: [] };
const TTL = 10 * 60_000;

function num(s: string): number {
  const n = Number(s.replace(/[,+\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

async function fetchPage(page: number): Promise<FuturesFlowDay[]> {
  const bizdate = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, "");
  const res = await fetch(
    `https://finance.naver.com/sise/investorDealTrendDay.naver?bizdate=${bizdate}&sosok=03&page=${page}`,
    { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = new TextDecoder("euc-kr").decode(await res.arrayBuffer());

  /*
   * 표의 한 줄: <td>26.08.25</td> 다음에 숫자 셀 열 개(개인·외국인·기관계·기관·
   * 기타법인·금융투자·보험·투신·은행·기타금융·연기금 — 실측 기준 머리 순서).
   * 날짜 셀을 닻으로 잡고 그 뒤 숫자들을 줍는다.
   */
  const out: FuturesFlowDay[] = [];
  const rowRe = /(\d{2}\.\d{2}\.\d{2})<\/td>([\s\S]*?)<\/tr>/g;
  for (const m of html.matchAll(rowRe)) {
    const nums = [...m[2].matchAll(/>\s*([+-]?[\d,]+)\s*</g)].map((x) => num(x[1]));
    if (nums.length < 3) continue;
    const [yy, mm, dd] = m[1].split(".");
    out.push({
      date: `20${yy}-${mm}-${dd}`,
      individual: nums[0],
      foreign: nums[1],
      institution: nums[2],
    });
  }
  return out;
}

/** 최근 N일 (기본 30) — 과거 → 최근 순으로 돌려준다 */
export async function futuresFlow(days = 30): Promise<FuturesFlowDay[]> {
  if (Date.now() - cache.at < TTL && cache.days.length >= days) return cache.days.slice(-days);
  try {
    const all: FuturesFlowDay[] = [];
    const seen = new Set<string>();
    // 한 쪽에 10일 — 30일이면 3쪽
    for (let page = 1; page <= Math.ceil(days / 10) && all.length < days; page += 1) {
      const rows = await fetchPage(page);
      if (rows.length === 0) break;
      for (const r of rows) {
        if (seen.has(r.date)) continue;
        seen.add(r.date);
        all.push(r);
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    all.sort((a, b) => a.date.localeCompare(b.date));
    if (all.length > 0) cache = { at: Date.now(), days: all };
    void recordApiCall("naver", "futuresFlow", "ok");
    return all.slice(-days);
  } catch (e) {
    void recordApiCall("naver", "futuresFlow", "failed");
    if (cache.days.length > 0) return cache.days.slice(-days);
    throw e;
  }
}
