import type { CalendarEvent, EventKind } from "./calendar.js";
import { replaceBySource } from "./calendar.js";

/**
 * 경제 캘린더 (내장 시드).
 *
 * 무료로 쓸 수 있는 경제 캘린더 API가 없다 — Investing.com 등은 크롤링 금지다.
 * 그래서 시장이 실제로 반응하는 일정만 직접 넣고 연 1회 갱신한다.
 *
 * **여기 날짜는 전부 공식 출처에서 확인한 값이다.** (2026-08-14 확인)
 *   FOMC   federalreserve.gov/monetarypolicy/fomccalendars.htm
 *   US CPI usinflationcalculator.com (BLS 공식 스케줄 미러 — bls.gov는 봇 차단)
 *   금통위  bok.or.kr 통화정책방향 결정회의 일정
 *
 * 기억으로 날짜를 적지 않는다. 틀린 날짜가 캘린더에 박히면 그게 제일 나쁘다 —
 * 사용자가 그 날짜를 믿고 준비하기 때문이다.
 * 갱신할 때도 반드시 위 출처를 다시 열어 확인할 것.
 */

export const ECONOMIC_SOURCE = "economic:2026";

/** 확인일 — 화면에 같이 띄워서 언제 기준인지 알 수 있게 한다 */
export const VERIFIED_AT = "2026-08-14";

interface SeedEvent {
  date: string;
  title: string;
  kind: EventKind;
  time?: string;
  memo?: string;
}

/**
 * FOMC — 이틀 회의라 **결과가 나오는 둘째 날**을 넣는다.
 * 한국 시각으로는 다음 날 새벽 3~4시에 발표된다.
 * `*` 표시가 붙은 회의는 점도표(SEP)가 함께 공개돼 시장 반응이 더 크다.
 */
const FOMC: SeedEvent[] = [
  { date: "2026-01-28", title: "FOMC 결과 발표", kind: "market" },
  { date: "2026-03-18", title: "FOMC 결과 발표 (점도표 공개)", kind: "market" },
  { date: "2026-04-29", title: "FOMC 결과 발표", kind: "market" },
  { date: "2026-06-17", title: "FOMC 결과 발표 (점도표 공개)", kind: "market" },
  { date: "2026-07-29", title: "FOMC 결과 발표", kind: "market" },
  { date: "2026-09-16", title: "FOMC 결과 발표 (점도표 공개)", kind: "market" },
  { date: "2026-10-28", title: "FOMC 결과 발표", kind: "market" },
  { date: "2026-12-09", title: "FOMC 결과 발표 (점도표 공개)", kind: "market" },
];

/** 미국 CPI — 미 동부 08:30 발표. 한국 시각으로는 같은 날 밤 21:30(서머타임 22:30) */
const US_CPI: SeedEvent[] = [
  { date: "2026-01-13", title: "미국 CPI (12월분)", kind: "market" },
  { date: "2026-02-13", title: "미국 CPI (1월분)", kind: "market" },
  { date: "2026-03-11", title: "미국 CPI (2월분)", kind: "market" },
  { date: "2026-04-10", title: "미국 CPI (3월분)", kind: "market" },
  { date: "2026-05-12", title: "미국 CPI (4월분)", kind: "market" },
  { date: "2026-06-10", title: "미국 CPI (5월분)", kind: "market" },
  { date: "2026-07-14", title: "미국 CPI (6월분)", kind: "market" },
  { date: "2026-08-12", title: "미국 CPI (7월분)", kind: "market" },
  { date: "2026-09-11", title: "미국 CPI (8월분)", kind: "market" },
  { date: "2026-10-14", title: "미국 CPI (9월분)", kind: "market" },
  { date: "2026-11-10", title: "미국 CPI (10월분)", kind: "market" },
  { date: "2026-12-10", title: "미국 CPI (11월분)", kind: "market" },
];

/** 한국은행 금통위 — 통화정책방향 결정회의. 09:00 회의, 오전 중 결과 발표 */
const BOK: SeedEvent[] = [
  { date: "2026-01-15", title: "한국은행 금통위 (기준금리)", kind: "market" },
  { date: "2026-02-26", title: "한국은행 금통위 (기준금리)", kind: "market" },
  { date: "2026-04-10", title: "한국은행 금통위 (기준금리)", kind: "market" },
  { date: "2026-05-28", title: "한국은행 금통위 (기준금리)", kind: "market" },
  { date: "2026-07-16", title: "한국은행 금통위 (기준금리)", kind: "market" },
  { date: "2026-08-27", title: "한국은행 금통위 (기준금리)", kind: "market" },
  { date: "2026-10-22", title: "한국은행 금통위 (기준금리)", kind: "market" },
  { date: "2026-11-26", title: "한국은행 금통위 (기준금리)", kind: "market" },
];

/**
 * 옵션 만기일 — 규칙으로 계산한다 (매월 두 번째 목요일).
 * 3·6·9·12월은 선물까지 같이 만기라 변동성이 크다 (네 마녀의 날).
 *
 * 규칙 기반이라 목록으로 적지 않고 계산한다 — 손으로 적으면 틀린다.
 * 공휴일이 겹치면 실제 만기는 앞당겨지므로, 그건 각자 확인해야 한다.
 */
function optionExpiries(year: number): SeedEvent[] {
  const out: SeedEvent[] = [];
  for (let m = 0; m < 12; m += 1) {
    // 그 달 1일의 요일에서 첫 목요일까지 며칠인지 구한 뒤 7일을 더한다
    const first = new Date(Date.UTC(year, m, 1));
    const toThu = (4 - first.getUTCDay() + 7) % 7; // 목요일 = 4
    const day = 1 + toThu + 7;
    const d = new Date(Date.UTC(year, m, day));
    const quad = [2, 5, 8, 11].includes(m); // 3·6·9·12월
    out.push({
      date: d.toISOString().slice(0, 10),
      title: quad ? "선물·옵션 동시만기 (네 마녀의 날)" : "옵션 만기일",
      kind: "market",
      memo: quad
        ? "지수선물·지수옵션·개별주식선물·개별주식옵션 동시 만기. 만기 전후 프로그램 매매 급증"
        : "월물 옵션 만기. 만기일 전후 프로그램 매매 확인",
    });
  }
  return out;
}

export function economicEvents(): SeedEvent[] {
  return [...FOMC, ...US_CPI, ...BOK, ...optionExpiries(2026)].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
}

export interface InstallResult {
  added: number;
  replaced: number;
  verifiedAt: string;
  events: CalendarEvent[];
}

/**
 * 캘린더에 넣는다.
 *
 * `replaceBySource` 를 쓰므로 여러 번 눌러도 중복이 안 쌓이고,
 * 직접 입력한 일정은 건드리지 않는다.
 */
export async function installEconomicCalendar(): Promise<InstallResult> {
  const seeds = economicEvents();
  const events = seeds.map((e) => ({
    date: e.date,
    title: e.title,
    kind: e.kind,
    source: ECONOMIC_SOURCE,
    ...(e.time ? { time: e.time } : {}),
    ...(e.memo ? { memo: e.memo } : {}),
  }));

  const r = await replaceBySource(ECONOMIC_SOURCE, events);
  return {
    added: r.added,
    replaced: r.removed,
    verifiedAt: VERIFIED_AT,
    events: r.events,
  };
}
