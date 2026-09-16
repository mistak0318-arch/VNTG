import { useEffect, useRef, useState } from "react";
import { useLockPaused } from "./lockPause";
import { useMarketOpen } from "./useLive";
import { useTabActive } from "./tabActive";

/**
 * **지금 VI 걸린 종목** — 여러 화면이 같은 값을 보게 (2026-09-14).
 *
 * 벤티지: "시세분석이나 이런 데서 전체를 보고 있거나 아니면 각 종목에 호가창 들어가면은
 * 얘가 vi다 아니다라고 표시해 줬으면 좋겠어".
 *
 * ## 왜 훅 하나로 모으나
 *
 * VI 는 **종목과 무관한 시장 전체 정보**다(`1h` 는 한 번 걸면 전 종목이 온다). 화면마다 따로
 * 받으면 같은 종목이 시세분석에서는 VI 인데 호가창에서는 아닌 순간이 생긴다 — 한 화면 안에서
 * 숫자가 갈리면 둘 다 못 믿는다는 이 저장소의 규칙이 표식에도 그대로 걸린다.
 * 모듈 하나가 받아 **구독자에게 나눠 준다.** 화면이 몇 개든 조회는 5초에 한 번이다.
 *
 * ## 「지금 걸려 있다」의 정의
 *
 * 해제 시각(`clearedAt`)이 비어 있으면 걸린 것이다. 다만 **해제 줄을 놓칠 수 있다** —
 * 소켓이 잠깐 끊기면 발동만 받고 해제를 못 받는다. 그러면 그 종목이 영영 VI 로 남는다.
 * VI 단일가는 **2분**이므로, 발동 후 3분이 지났는데 해제 줄이 없으면 **끝난 것으로 본다**
 * (여유 1분은 해제 줄이 늦게 오는 경우를 위한 것이다). 「모르면 걸린 것으로」 두는 쪽이
 * 안전해 보이지만, 그러면 화면이 하루 종일 거짓 VI 딱지를 달고 있게 된다.
 */
export interface ViNow {
  code: string;
  name: string;
  /** 정적/동적 — 서버가 준 말 그대로 */
  apply: string;
  /** 발동가 */
  price: number;
  /** 기준가 */
  base: number;
  /** HHmmss */
  firedAt: string;
  /** 발동가가 기준가보다 위면 상방(급등), 아래면 하방(급락). 모르면 null */
  dir: "up" | "down" | null;
  gap: number | null;
  /** 발동 뒤 몇 초 지났나 — 화면이 「1:12 남음」을 적을 수 있게 */
  agoSec: number;
}

/** VI 단일가 길이(초). 이 시간이 지나면 곧 풀린다 */
export const VI_HOLD_SEC = 120;
/** 해제 줄을 놓쳤을 때 스스로 지우는 시한 */
const STALE_SEC = 180;

interface Raw {
  code: string;
  name: string;
  apply: string;
  price: number;
  base: number;
  gapPct?: number | null;
  firedAt: string;
  clearedAt: string;
}

let subs = new Set<(m: Map<string, ViNow>) => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let cache = new Map<string, ViNow>();

/** HHmmss 를 오늘의 초로 — 화면이 「몇 초 지났나」를 알아야 카운트다운을 그린다 */
function secOfDay(t: string): number | null {
  if (!/^\d{6}$/.test(t)) return null;
  return Number(t.slice(0, 2)) * 3600 + Number(t.slice(2, 4)) * 60 + Number(t.slice(4, 6));
}

function nowSecKst(): number {
  const k = new Date(Date.now() + 9 * 3600_000);
  return k.getUTCHours() * 3600 + k.getUTCMinutes() * 60 + k.getUTCSeconds();
}

async function pull(): Promise<void> {
  try {
    const r = await fetch("/api/realtime/vi?limit=300");
    const j = (await r.json()) as { events?: Raw[] };
    const now = nowSecKst();
    const next = new Map<string, ViNow>();
    for (const e of j.events ?? []) {
      if (e.clearedAt) continue; // 해제된 것
      const fired = secOfDay(e.firedAt);
      const ago = fired === null ? 0 : Math.max(0, now - fired);
      /* 해제 줄을 놓쳤다 — 3분이 지나면 스스로 지운다(위 주석) */
      if (fired !== null && ago > STALE_SEC) continue;
      const gap =
        e.price > 0 && e.base > 0
          ? Math.round(((e.price - e.base) / e.base) * 1000) / 10
          : e.gapPct != null && Number.isFinite(e.gapPct)
            ? Math.round(e.gapPct * 10) / 10
            : null;
      next.set(e.code, {
        code: e.code,
        name: e.name,
        apply: e.apply,
        price: e.price,
        base: e.base,
        firedAt: e.firedAt,
        dir: gap === null || gap === 0 ? null : gap > 0 ? "up" : "down",
        gap,
        agoSec: ago,
      });
    }
    cache = next;
    for (const fn of subs) fn(cache);
  } catch {
    /* 못 받으면 직전 값을 그대로 둔다 — 표식이 깜빡이는 것보다 낫다 */
  }
}

/**
 * **오늘 VI 걸렸던 종목** — 풀렸어도 하루 남는 표식 (2026-09-17, 벤티지: "VI 걸렸는데 시세분석 표에 안 보인다").
 * 위 `useViNow` 는 걸린 2분 동안만이라, 보고 있을 때 마침 걸려 있지 않으면 표에 아무것도 없었다.
 * 재료는 키움 ka10054(서버 60초 캐시) — 실시간과 무관하니 실시간을 꺼도 뜬다. 1분에 한 번.
 */
export interface ViToday {
  code: string;
  name: string;
  count: number;
  releaseTime: string;
  openChangeRate: number;
  motionPrice: number;
}
let todaySubs = new Set<(m: Map<string, ViToday>) => void>();
let todayTimer: ReturnType<typeof setInterval> | null = null;
let todayCache = new Map<string, ViToday>();
async function pullToday(): Promise<void> {
  try {
    const r = await fetch("/api/market/vi-today");
    const j = (await r.json()) as { ok?: boolean; rows?: Record<string, ViToday> };
    if (!j.ok) return; // 못 받았으면 직전 값 — 「없다」가 아니다
    todayCache = new Map(Object.entries(j.rows ?? {}));
    for (const fn of todaySubs) fn(todayCache);
  } catch {
    /* 직전 값 유지 */
  }
}
export function useViToday(): Map<string, ViToday> {
  const [map, setMap] = useState<Map<string, ViToday>>(todayCache);
  const tabActive = useTabActive();
  const lockPaused = useLockPaused();
  const run = tabActive && !lockPaused;
  const ref = useRef<(m: Map<string, ViToday>) => void>(setMap);
  ref.current = setMap;
  useEffect(() => {
    if (!run) return;
    const fn = (m: Map<string, ViToday>) => ref.current(new Map(m));
    todaySubs.add(fn);
    if (!todayTimer) {
      void pullToday();
      todayTimer = setInterval(() => void pullToday(), 60_000);
    }
    return () => {
      todaySubs.delete(fn);
      if (todaySubs.size === 0 && todayTimer) {
        clearInterval(todayTimer);
        todayTimer = null;
      }
    };
  }, [run]);
  return map;
}

/**
 * @param on 꺼 두면 구독하지 않는다 — 화면이 실시간을 끈 상태면 조회할 이유가 없다.
 */
export function useViNow(on = true): Map<string, ViNow> {
  const [map, setMap] = useState<Map<string, ViNow>>(cache);
  const live = useMarketOpen();
  const tabActive = useTabActive();
  const lockPaused = useLockPaused();
  const run = on && live && tabActive && !lockPaused;
  const ref = useRef<(m: Map<string, ViNow>) => void>(setMap);
  ref.current = setMap;
  useEffect(() => {
    if (!run) return;
    const fn = (m: Map<string, ViNow>) => ref.current(new Map(m));
    subs.add(fn);
    if (!timer) {
      void pull();
      timer = setInterval(() => void pull(), 5000);
    }
    return () => {
      subs.delete(fn);
      if (subs.size === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, [run]);
  return run ? map : new Map();
}
