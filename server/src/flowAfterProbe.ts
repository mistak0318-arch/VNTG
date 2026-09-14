import type { KiwoomClient } from "./kiwoomClient.js";
import { afterMarketEra } from "./marketHours.js";
import { isTradingDay } from "./tradingDay.js";

/**
 * **투자자 수급에 애프터 체결이 들어가나** (2026-09-15 — 벤티지가 선택지에서 「오늘 밤 재서 표기」를 고름).
 *
 * `ka10060`(종목별 투자자) 의 오늘 줄이 16:00~20:00 KRX 애프터 체결까지 담는지 모른다. 담으면 화면의
 * 「오늘 외인·기관」은 하루 전체이고, 안 담으면 정규장 수급이다 — 표기가 달라져야 한다.
 *
 * ## 어떻게 가르나
 *
 * 한 번만 견주면 못 가른다 — 키움 수급은 장 끝나고 **잠정치가 확정치로 한 번 바뀐다.** 그래서 네 번 찍는다:
 * 15:45(공백) · 17:00 · 18:30 · 20:05. 앞 회차와 달라진 종목 수를 회차마다 센다.
 *   · 17:00·18:30·20:05 **매번** 달라지면 → 애프터 체결이 계속 들어간다(하루 전체)
 *   · **한 번만** 뛰고 멈추면 → 확정치 반영이다(정규장 수급)
 *   · 한 번도 안 바뀌면 → 정규장 수급, 잠정치도 없다
 *
 * 대형주 셋(거래가 늘 있다)만. 조회 열두 번. health.json 에는 **개수만** — 종목·금액은 싣지 않는다.
 */

const CODES = ["005930", "000660", "005380"];
const SLOTS = ["15:45", "17:00", "18:30", "20:05"] as const;
type Slot = (typeof SLOTS)[number];

interface Snap {
  fgn: number;
  org: number;
  ind: number;
}

let day = "";
const taken = new Map<Slot, Map<string, Snap>>();
const errors: string[] = [];

function kst(): { date: string; hm: string } {
  const iso = new Date(Date.now() + 9 * 3600_000).toISOString();
  return { date: iso.slice(0, 10), hm: iso.slice(11, 16) };
}

const num = (v: unknown): number => {
  const n = Number(String(v ?? "").replace(/[+,]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

async function snapOne(client: KiwoomClient, code: string, ymd: string): Promise<Snap | null> {
  const res = await client.request<Record<string, unknown>>("/api/dostk/chart", "ka10060", {
    stk_cd: code,
    dt: ymd,
    amt_qty_tp: "2", // 수량 — 금액은 가격이 섞여 움직임을 흐린다
    trde_tp: "0",
    unit_tp: "1",
  });
  const rows = (res.data?.stk_invsr_orgn_chart ?? []) as Record<string, unknown>[];
  const r = rows.find((x) => String(x.dt ?? "").replace(/-/g, "") === ymd);
  return r ? { fgn: num(r.frgnr_invsr), org: num(r.orgn), ind: num(r.ind_invsr) } : null;
}

async function tick(client: KiwoomClient): Promise<void> {
  const t = kst();
  if (!afterMarketEra(t.date) || !isTradingDay()) return;
  if (t.date !== day) {
    day = t.date;
    taken.clear();
    errors.length = 0;
  }
  /* 지난 회차 중 아직 안 찍은 가장 늦은 것 — 서버가 잠깐 꺼져 있었으면 그 회차만 건너뛴다 */
  const due = [...SLOTS].reverse().find((s) => t.hm >= s);
  if (!due || taken.has(due)) return;
  const ymd = t.date.replace(/-/g, "");
  const got = new Map<string, Snap>();
  for (const code of CODES) {
    try {
      const s = await snapOne(client, code, ymd);
      if (s) got.set(code, s);
    } catch (e) {
      if (errors.length < 5) errors.push(`${due} ${e instanceof Error ? e.message : String(e)}`.slice(0, 120));
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  taken.set(due, got);
}

/** health.json 한 칸 — 회차마다 앞 회차와 달라진 종목 수. 종목·금액은 없다 */
export function flowAfterSnapshot(): Record<string, unknown> {
  const out: Record<string, unknown> = { day };
  let prev: Map<string, Snap> | null = null;
  for (const s of SLOTS) {
    const cur = taken.get(s);
    if (!cur) {
      out[s] = "안 찍음";
      continue;
    }
    if (!prev) {
      out[s] = `${cur.size}/${CODES.length}종목 받음 (기준)`;
    } else {
      let f = 0, o = 0, i = 0;
      for (const [code, v] of cur) {
        const p = prev.get(code);
        if (!p) continue;
        if (v.fgn !== p.fgn) f += 1;
        if (v.org !== p.org) o += 1;
        if (v.ind !== p.ind) i += 1;
      }
      out[s] = `${cur.size}/${CODES.length}종목 · 앞 회차와 달라짐 외인 ${f} · 기관 ${o} · 개인 ${i}`;
    }
    prev = cur;
  }
  if (errors.length > 0) out.오류 = errors;
  return out;
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startFlowAfterProbe(client: KiwoomClient): void {
  if (timer) return;
  timer = setInterval(() => void tick(client).catch(() => undefined), 60_000);
  timer.unref?.();
}
