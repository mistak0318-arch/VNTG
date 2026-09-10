/**
 * 조회순위 **누적** — 1분마다 받아 두고 「최근 N분 동안 목록에 올랐던 종목」을 센다 (2026-09-09 밤).
 *
 * 벤티지: "실시간 조회순위는 원래 20위까지만 나오는 건가? 한 50개 나오면 좋겠는데" →
 * 키움 ka00198 은 **20줄 고정, 연속조회 없음**(실측 `contYn: "N"`). 더 받을 길이 없다.
 * 대신 시간을 쌓는다 — 30초·1분 기준은 목록이 계속 뒤집히므로 1분마다 한 장씩 받아 두면
 * 30분에 40~60종목이 지나간다. 등장 횟수·최고 순위로 세우면 「지금 눈이 자주 가는 종목」이
 * 20개 밖에서도 보인다.
 *
 * 부담: 1분에 조회 1회(하루 ≤1,440). 07:00~24:00 KST 만 — 새벽엔 목록이 안 움직인다.
 * 메모리에 6시간을 들고 있다. 재시작하면 비지만 30분이면 다시 찬다 — 파일에 남길 값은 아니다.
 * 개발 PC(`REALTIME_ENABLED=0`)에선 안 돈다 — 같은 앱키로 두 곳이 받을 이유가 없다.
 */
import type { KiwoomClient } from "./kiwoomClient.js";
import { isTradingDay } from "./tradingDay.js";
import { bare, toNum } from "./rankExtras.js";

export interface InquirySample {
  at: number;
  rows: { code: string; name: string; rank: number; price: number | null; rate: number | null }[];
}

const KEEP_MS = 6 * 3600_000;
const EVERY_MS = 60_000;
const samples: InquirySample[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let lastError: string | null = null;

function kstHour(now = Date.now()): number {
  return new Date(now + 9 * 3600_000).getUTCHours();
}

async function takeSample(client: KiwoomClient): Promise<void> {
  const h = kstHour();
  if (h < 7) return; // 00~07시는 쉰다
  if (!isTradingDay()) return; // (2026-09-10 전수 점검) 휴장일엔 조회순위가 안 움직인다 — 1분마다 1,020회를 아낀다
  try {
    const res = await client.request<Record<string, unknown>>("/api/dostk/stkinfo", "ka00198", { qry_tp: "1" });
    const list = Array.isArray(res.data.item_inq_rank) ? (res.data.item_inq_rank as Record<string, unknown>[]) : [];
    if (list.length === 0) return;
    const rows = list.map((r, i) => ({
      code: bare(r.stk_cd),
      name: String(r.stk_nm ?? "").trim(),
      rank: toNum(r.bigd_rank) ?? i + 1,
      price: (() => {
        const n = toNum(r.past_curr_prc);
        return n === null ? null : Math.abs(n);
      })(),
      rate: toNum(r.base_comp_chgr),
    }));
    samples.push({ at: Date.now(), rows });
    const cutoff = Date.now() - KEEP_MS;
    while (samples.length > 0 && samples[0].at < cutoff) samples.shift();
    lastError = null;
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
  }
}

export function startInquirySampler(client: KiwoomClient): void {
  if (timer) return;
  if (process.env.REALTIME_ENABLED === "0" || process.env.INQUIRY_SAMPLER === "0") {
    console.log("[inquiry] 누적 표본 안 받음 (개발 PC 또는 INQUIRY_SAMPLER=0)");
    return;
  }
  setTimeout(() => void takeSample(client), 20_000);
  timer = setInterval(() => void takeSample(client), EVERY_MS);
}

/** 화면이 방금 받은 응답도 표본으로 쓴다 — 사람이 보고 있으면 그만큼 촘촘해진다 */
export function noteLiveSample(rows: InquirySample["rows"]): void {
  if (rows.length === 0) return;
  const last = samples[samples.length - 1];
  if (last && Date.now() - last.at < 30_000) return; // 30초 안에 하나면 충분하다
  samples.push({ at: Date.now(), rows });
}

export interface CumRow {
  code: string;
  name: string;
  /** 창 안에서 목록에 오른 횟수 */
  hits: number;
  /** 창 안 표본 수 — 「hits/총」이 곧 점유율이다 */
  of: number;
  bestRank: number;
  lastRank: number | null;
  firstAt: number;
  lastAt: number;
  price: number | null;
  rate: number | null;
}

/** 최근 `minutes` 분 누적. 등장 횟수 → 최고 순위 → 최근 등장 순 */
export function cumulative(minutes: number): { rows: CumRow[]; samples: number; oldestAt: number | null } {
  const cutoff = Date.now() - minutes * 60_000;
  const win = samples.filter((s) => s.at >= cutoff);
  const by = new Map<string, CumRow>();
  const latest = win[win.length - 1];
  for (const s of win) {
    for (const r of s.rows) {
      const cur = by.get(r.code);
      if (!cur) {
        by.set(r.code, {
          code: r.code,
          name: r.name,
          hits: 1,
          of: win.length,
          bestRank: r.rank,
          lastRank: null,
          firstAt: s.at,
          lastAt: s.at,
          price: r.price,
          rate: r.rate,
        });
      } else {
        cur.hits += 1;
        cur.bestRank = Math.min(cur.bestRank, r.rank);
        cur.lastAt = s.at;
        cur.price = r.price;
        cur.rate = r.rate;
        if (r.name) cur.name = r.name;
      }
    }
  }
  if (latest) for (const r of latest.rows) { const c = by.get(r.code); if (c) c.lastRank = r.rank; }
  const rows = [...by.values()].sort(
    (a, b) => b.hits - a.hits || a.bestRank - b.bestRank || b.lastAt - a.lastAt,
  );
  return { rows, samples: win.length, oldestAt: win[0]?.at ?? null };
}

export function samplerStatus(): { samples: number; lastAt: number | null; lastError: string | null } {
  return { samples: samples.length, lastAt: samples[samples.length - 1]?.at ?? null, lastError };
}
