import { recordApiCall } from "./apiUsage.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  /** 순매수 **억원** — 2026-09-18 부터. 옛 표는 계약이었는데 새 API 는 키움 앱과 같은 억원(실측: 외국인 15,451 vs 키움 15,789) */
  individual: number;
  foreign: number;
  institution: number;
}

/*
 * **2026-09-18 — 옛 표(investorDealTrendDay)는 HTTP 410 으로 닫혔다.** 벤티지: "네이버는 새로운 사이트에서 보여지는 거 아냐?
 * 다시 검색해봐" → 맞았다. 새 모바일 API 가 **오늘 값**을 준다(과거 표는 없다):
 *
 *   https://m.stock.naver.com/api/index/FUT/trend
 *   → {"bizdate":"20260918","personalValue":"+411","foreignValue":"+14,006","institutionalValue":"-14,343"}
 *   단위는 **억원**이다 — 벤티지가 13:35 키움 앱과 나란히 찍어 줬다: 키움 외국인 15,789·기관 15,706 억원, 네이버 15,451·15,423.
 *   처음엔 옛 표처럼 계약으로 읽어 「계약 × 지수 × 25만원」 환산이 붙어 4만 2천억으로 부풀었다.
 *
 * 하루치만 오니 **우리가 날마다 적어 둔다** (data/futuresFlowDays.json). 30일 그래프는 오늘부터 쌓이는 만큼만 보인다.
 * 같은 API 가 KOSPI·KOSDAQ·KPI200 도 준다(억원) — 그쪽은 키움 ka10051 이 있어 안 쓴다.
 */
const STORE = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "futuresFlowDays.json");
let cache: { at: number; days: FuturesFlowDay[] } = { at: 0, days: [] };
let loaded = false;
const TTL = 2 * 60_000; // 장중 곡선 표본(2분)과 같은 박자 — 응답이 100바이트라 부담이 없다

function num(s: unknown): number {
  const n = Number(String(s ?? "").replace(/[,+\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

async function loadStore(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(await readFile(STORE, "utf-8")) as FuturesFlowDay[];
    if (Array.isArray(raw)) cache.days = raw.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date));
  } catch {
    /* 아직 없다 — 오늘부터 */
  }
}

async function fetchToday(): Promise<FuturesFlowDay | null> {
  const res = await fetch("https://m.stock.naver.com/api/index/FUT/trend", {
    headers: { "user-agent": "Mozilla/5.0 (Linux; Android 12) Chrome/120 Mobile Safari/537.36", accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = (await res.json()) as Record<string, unknown>;
  const b = String(j.bizdate ?? "");
  if (!/^\d{8}$/.test(b)) return null;
  return {
    date: `${b.slice(0, 4)}-${b.slice(4, 6)}-${b.slice(6, 8)}`,
    individual: num(j.personalValue),
    foreign: num(j.foreignValue),
    institution: num(j.institutionalValue),
  };
}

/** 최근 N일 (기본 30) — 과거 → 최근 순. 오늘 값은 장중이면 누적 진행값 */
export async function futuresFlow(days = 30): Promise<FuturesFlowDay[]> {
  await loadStore();
  if (Date.now() - cache.at < TTL) return cache.days.slice(-days);
  try {
    const today = await fetchToday();
    if (today) {
      const rest = cache.days.filter((d) => d.date !== today.date);
      rest.push(today);
      rest.sort((a, b) => a.date.localeCompare(b.date));
      cache = { at: Date.now(), days: rest.slice(-400) };
      try {
        await mkdir(dirname(STORE), { recursive: true });
        await writeFile(STORE, JSON.stringify(cache.days), "utf-8");
      } catch {
        /* 못 적어도 다음에 */
      }
    } else {
      cache.at = Date.now();
    }
    void recordApiCall("naver", "futuresFlow", "ok");
    return cache.days.slice(-days);
  } catch (e) {
    void recordApiCall("naver", "futuresFlow", "failed");
    cache.at = Date.now() - TTL + 30_000; // 30초 뒤에 다시
    if (cache.days.length > 0) return cache.days.slice(-days);
    throw e;
  }
}
