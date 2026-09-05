import { yahooBars } from "./yahooChart.js";

/**
 * 미국 **프리장 봉** — 하루에 한 점 (2026-09-05).
 *
 * 벤티지: "마이크론, 엔비디아 프리장 값이 양봉인지 음봉인지까지 넣어보자."
 *
 * ## 프리장은 일봉에 없다
 *
 * 야후 일봉은 **정규장만** 담는다. 그래서 프리장을 재려면 분봉을 `includePrePost` 로
 * 받아 직접 하루치로 접어야 한다. 그런데 분봉은 **60일까지만** 준다 — 다른 변수들이
 * 2년인 것과 달리 이 둘은 두 달이다. 이건 야후의 벽이고 우리가 못 넘는다.
 *
 * ⚠️ **못 넘는다는 사실을 숨기지 않는다.** 시뮬레이터는 「못 잰 조건」을 「안 맞은 조건」
 * 으로 세므로, 250일 백테스트에서 이 변수를 쓰면 **앞의 190일은 조용히 거래가 없다.**
 * 그게 규칙이 나빠서인지 자료가 없어서인지 화면에서 구분이 안 되면 이 도구는 거짓말을
 * 하는 것이다. 그래서 `simEngine.backtest` 가 구간이 모자라면 결과에 그 줄을 적는다.
 *
 * ## 두 가지로 잰다 — 「봉」과 「갭」
 *
 * 벤티지가 물은 것은 **봉**(프리장 시가 → 프리장 종가)이다. 그런데 프리장 시가는
 * 뉴욕 새벽 4시 첫 체결이라 **한 건에 흔들린다** — 단주 하나가 그날 봉의 색을 정해
 * 버리는 날이 있다. 그래서 **갭**(전일 정규장 종가 → 프리장 종가)도 같이 낸다.
 * 「간밤에 어디까지 갔나」는 이쪽이 훨씬 덜 흔들린다.
 *
 * 둘을 골라 쓰라고 남겨 둔다. 하나로 뭉뚱그리면 흔들리는 값을 안 흔들리는 값인 척
 * 쓰게 된다.
 *
 * ## 날짜를 뉴욕 날짜로 적는 이유
 *
 * 뉴욕 04:00~09:30 은 한국시간으로 **같은 날** 저녁 17~23시다(서머타임이면 한 시간
 * 앞). 즉 뉴욕 날짜 D 의 프리장은 한국 날짜 D 저녁에 일어난다 — **한국 장이 끝난
 * 뒤**다. 그래서 한국 종가로 판정하는 이 엔진에서 D 일에 쓸 수 있는 프리장은 D-1
 * 것이 마지막이고, `simSeries` 가 바깥 변수를 「그날 **이전**의 마지막 값」으로
 * 읽어 그 한 칸을 지킨다.
 */

/** 프리장 04:00~09:30, 정규장 09:30~16:00 (뉴욕 시각, 분) */
const PRE_FROM = 4 * 60;
const PRE_TO = 9 * 60 + 30;
const REG_TO = 16 * 60;

/** 분봉으로 뒤로 갈 수 있는 한계 — 야후가 5분봉을 60일까지만 준다(**달력 날짜**다) */
export const PREMARKET_MAX_DAYS = 59;

/**
 * 화면에 적을 길이.
 *
 * 달력 59일은 **거래일로 40일쯤**이다(2026-09-05 실측: NVDA·MU 모두 43일).
 * 「59일」이라고만 적으면 250일 백테스트에서 5분의 1은 덮는다고 읽히는데 실제로는
 * 6분의 1이다. 세는 단위가 다르면 적을 때 맞춰 적는다.
 */
export const PREMARKET_SPAN = "약 40거래일";

/**
 * 프리장 봉 하나를 인정하는 최소 개수.
 *
 * 5분봉 한 칸짜리 「봉」은 체결 한 건일 수 있다. 두 칸이면 적어도 시각이 다른 두 값이
 * 있다 — 그래도 얇은 것은 얇지만, 한 건짜리를 봉이라 부르지는 않는다.
 */
const MIN_BARS = 2;

const ET_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** 유닉스 초 → 뉴욕 벽시계. **서머타임은 `Intl` 이 안다** — 우리가 계산하면 봄가을에 틀린다 */
function et(ts: number): { day: string; min: number } {
  const parts = ET_FMT.formatToParts(new Date(ts * 1000));
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    day: `${g("year")}${g("month")}${g("day")}`,
    min: Number(g("hour")) * 60 + Number(g("minute")),
  };
}

export interface PremarketDay {
  /** 뉴욕 날짜 `YYYYMMDD` */
  d: string;
  /** 프리장 시가 → 종가 (%). 양수면 **양봉** */
  body: number;
  /** 전일 정규장 종가 → 프리장 종가 (%). 없으면 null */
  gap: number | null;
  bars: number;
}

const cache = new Map<string, { at: number; rows: PremarketDay[] }>();
const TTL_MS = 30 * 60_000;

/**
 * 심볼 하나의 프리장 이력 — 옛날→최신.
 *
 * 실패하면 **빈 배열**이다. 빈 배열은 「조건이 영영 안 맞는다」로 이어지는데,
 * 그 사실은 백테스트 결과가 적어 준다. 여기서 0 이나 옛 값으로 메우지 않는다 —
 * 메우면 없는 자료로 낸 성적이 진짜인 척한다.
 */
export async function premarketDays(symbol: string): Promise<PremarketDay[]> {
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rows;

  const now = Math.floor(Date.now() / 1000);
  const { bars } = await yahooBars(symbol, {
    period1: now - PREMARKET_MAX_DAYS * 86_400,
    period2: now,
    interval: "5m",
    prepost: true,
  });

  /* 하루씩 접는다 — 프리장 봉들과, 그날 정규장 마지막 종가 */
  const byDay = new Map<string, { pre: { open: number; close: number }[]; regClose: number | null }>();
  for (const b of bars) {
    const { day, min } = et(b.ts);
    let slot = byDay.get(day);
    if (!slot) {
      slot = { pre: [], regClose: null };
      byDay.set(day, slot);
    }
    if (min >= PRE_FROM && min < PRE_TO) slot.pre.push({ open: b.open, close: b.close });
    else if (min >= PRE_TO && min < REG_TO) slot.regClose = b.close;
  }

  const days = [...byDay.keys()].sort();
  const rows: PremarketDay[] = [];
  let prevReg: number | null = null;
  for (const d of days) {
    const slot = byDay.get(d) as { pre: { open: number; close: number }[]; regClose: number | null };
    const pre = slot.pre;
    if (pre.length >= MIN_BARS && pre[0].open > 0) {
      const first = pre[0].open;
      const last = pre[pre.length - 1].close;
      rows.push({
        d,
        body: ((last - first) / first) * 100,
        /* 갭은 **직전 정규장 종가** 기준. 그게 없는 첫날은 null — 0 으로 메우면 「보합」이라는 거짓이 된다 */
        gap: prevReg !== null && prevReg > 0 ? ((last - prevReg) / prevReg) * 100 : null,
        bars: pre.length,
      });
    }
    if (slot.regClose !== null) prevReg = slot.regClose;
  }

  cache.set(symbol, { at: Date.now(), rows });
  return rows;
}
