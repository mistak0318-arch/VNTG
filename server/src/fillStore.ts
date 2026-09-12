/**
 * **체결 창고** — 내가 언제 얼마에 몇 주 사고팔았나, 날짜별로 (2026-09-10).
 *
 * 벤티지: "차트에 복기라는 버튼 만들 수 있어? 내가 이 종목을 사고 팔았을 때의 시점을 나타내는 …
 * 일봉, 주봉, 분봉 이런 데서 모두".
 *
 * 키움 `kt00007`(계좌별 주문체결내역상세)은 **날짜를 주면 그날 체결을 시각까지** 준다(실측 09-09:
 * `ord_tm 09:58:16 · cntr_qty · cntr_uv · io_tp_nm 현금매수`). 그런데 하루에 한 번 물어야 하므로
 * 종목을 열 때마다 120일을 훑을 수는 없다 — 그래서 **날짜별 파일로 쌓아 둔다**: 켜질 때 지난 90일을
 * 한 번 채우고(있는 날은 건너뜀), 장중엔 30분마다 오늘치를 다시 받는다. 화면은 파일만 읽는다.
 *
 * 우리 주문 로그(orderLog)에도 체결이 있지만 HTS·앱에서 직접 낸 주문은 거기 없다 — 키움 쪽이 전부다.
 * 모의투자 계좌면 모의 체결이 쌓인다(`mock` 표시).
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";
import { orderClient, orderIsMock } from "./orders.js";
import { isTradingDate, isTradingDay } from "./tradingDay.js";
import { afterMarketEra } from "./marketHours.js";

const here = dirname(fileURLToPath(import.meta.url));
const DIR = join(here, "..", "data", "fills");

export interface Fill {
  /** ISO (KST 로 만든 것) */
  at: string;
  code: string;
  name: string;
  side: "buy" | "sell";
  price: number;
  qty: number;
  ordNo: string;
  mock: boolean;
  /** 신용·현금 등 — io_tp_nm 그대로 */
  kind: string;
  /**
   * **체결 시각을 못 받았다** (2026-09-12). 옵션이라 옛 파일은 그대로 읽힌다.
   *
   * 참이면 `at` 의 **시·분·초는 뜻이 없다**(날짜만 믿을 수 있다). 차트 복기가 이 줄을
   * 분봉 위에 점으로 찍으면 안 된다 — 없던 자리에 있던 일로 그려진다.
   */
  timeUnknown?: boolean;
}

interface DayFile {
  day: string;
  syncedAt: string;
  fills: Fill[];
}

const kstYmd = (o = 0) => new Date(Date.now() + 9 * 3600_000 - o * 86400_000).toISOString().slice(0, 10);
const num = (v: unknown) => {
  const n = Number(String(v ?? "").replace(/[,+]/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const fileOf = (day: string) => join(DIR, `${day}.json`);

async function fetchDay(client: KiwoomClient, day: string): Promise<Fill[]> {
  const oc = orderClient() ?? client;
  const out: Fill[] = [];
  let contYn = "N";
  let nextKey = "";
  for (let page = 0; page < 10; page += 1) {
    const r = await oc.request<Record<string, unknown>>(
      "/api/dostk/acnt",
      "kt00007",
      { ord_dt: day.replace(/-/g, ""), qry_tp: "1", stk_bond_tp: "0", sell_tp: "0", stk_cd: "", fr_ord_no: "", dmst_stex_tp: "%" },
      page === 0 ? {} : { contYn, nextKey },
    );
    const rows = Array.isArray(r.data.acnt_ord_cntr_prps_dtl) ? (r.data.acnt_ord_cntr_prps_dtl as Record<string, unknown>[]) : [];
    for (const x of rows) {
      const qty = num(x.cntr_qty);
      if (qty <= 0) continue;
      const io = String(x.io_tp_nm ?? "");
      const side: Fill["side"] | null = /매수/.test(io) ? "buy" : /매도/.test(io) ? "sell" : null;
      if (!side) continue;
      /*
       * ## **시각이 없으면 지어내지 않는다** (2026-09-12, KRX 애프터마켓 개편)
       *
       * 여태 `ord_tm`·`cnfm_tm` 이 둘 다 비면 **"15:30:00"(정규장 마감)으로 박았다.**
       * 9/13 까지는 체결이 사실상 정규장 안에서만 났으니 틀려도 그날 안이었다.
       *
       * 9/14 부터 16:00~20:00 이 실거래가 된다. 그러면 애프터 체결이 차트 복기에서
       * **네 시간 반 앞**인 15:30 자리에 찍힌다 — 「그 자리에서 내가 샀나」를 보려고 만든
       * 화면인데 거기에 없던 일이 그려진다. 그 체결이 어느 세션이었는지 응답만으로는 알
       * 방법이 없으므로 **박지 않고 표시한다**(`timeUnknown`). 줄 자체는 남긴다 — 날짜와
       * 가격·수량은 진짜라 일봉 복기에는 그대로 쓸모가 있다.
       *
       * ⚠️ 09/13 까지는 예전 그대로 15:30 이다. 옛 파일과 눈금이 갈리면 안 된다.
       */
      const raw = String(x.ord_tm ?? "").trim() || String(x.cnfm_tm ?? "").trim();
      const known = /^\d{2}:\d{2}:\d{2}$/.test(raw);
      const unknownAfterEra = !known && afterMarketEra(day);
      const hhmmss = known ? raw : unknownAfterEra ? "00:00:00" : "15:30:00";
      out.push({
        at: new Date(`${day}T${hhmmss}+09:00`).toISOString(),
        ...(unknownAfterEra ? { timeUnknown: true as const } : {}),
        code: String(x.stk_cd ?? "").replace(/^\*?A/, "").slice(0, 6),
        name: String(x.stk_nm ?? "").trim(),
        side,
        price: Math.abs(num(x.cntr_uv)),
        qty,
        ordNo: String(x.ord_no ?? "").trim(),
        mock: orderIsMock(),
        kind: io,
      });
    }
    contYn = r.contYn;
    nextKey = r.nextKey;
    if (contYn !== "Y" || !nextKey) break;
  }
  /* 같은 주문번호가 여러 줄(부분 체결) — 그대로 둔다. 시각순 */
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

export async function syncDay(client: KiwoomClient, day: string): Promise<number> {
  const fills = await fetchDay(client, day);
  await mkdir(DIR, { recursive: true });
  const f: DayFile = { day, syncedAt: new Date().toISOString(), fills };
  await writeFile(fileOf(day), JSON.stringify(f), "utf-8");
  return fills.length;
}

let lastSync: { at: string; day: string; count: number; error?: string } | null = null;
export function fillSyncStatus(): typeof lastSync {
  return lastSync;
}

/** 한 종목의 체결 — 최근 `days` 일, 시각순. 파일만 읽는다 */
export async function tradesOf(code: string, days = 365): Promise<{ trades: Fill[]; from: string | null; to: string | null; days: number }> {
  const cut = kstYmd(days);
  let names: string[] = [];
  try {
    names = (await readdir(DIR)).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n) && n.slice(0, 10) >= cut).sort();
  } catch {
    return { trades: [], from: null, to: null, days: 0 };
  }
  const trades: Fill[] = [];
  for (const n of names) {
    try {
      const f = JSON.parse(await readFile(join(DIR, n), "utf-8")) as DayFile;
      for (const t of f.fills) if (t.code === code) trades.push(t);
    } catch {
      /* 깨진 날은 건너뛴다 */
    }
  }
  return { trades, from: names[0]?.slice(0, 10) ?? null, to: names[names.length - 1]?.slice(0, 10) ?? null, days: names.length };
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/**
 * 켜질 때 지난 90일 채우기(있는 날은 건너뜀, 주말 건너뜀) → 장중 30분마다 오늘치.
 * 한 날에 한 호출이라 90일 채우기는 넉넉히 300ms 간격 — 키움 초당 제한을 안 건드린다.
 */
export function startFillStore(client: KiwoomClient): void {
  if (timer) return;
  const backfill = async () => {
    if (running) return;
    running = true;
    try {
      await mkdir(DIR, { recursive: true });
      const have = new Set((await readdir(DIR).catch(() => [] as string[])).map((n) => n.slice(0, 10)));
      for (let i = 90; i >= 0; i -= 1) {
        const day = kstYmd(i);
        if (!isTradingDate(day)) continue; // (2026-09-10 전수 점검) 주말만 걸렀다 — 휴장일도 건너뛴다
        if (i > 0 && have.has(day)) continue;
        try {
          const n = await syncDay(client, day);
          lastSync = { at: new Date().toISOString(), day, count: n };
        } catch (e) {
          lastSync = { at: new Date().toISOString(), day, count: 0, error: e instanceof Error ? e.message : String(e) };
          if (/토큰|인증|401|403/.test(lastSync.error ?? "")) break; // 키가 없으면 90번 두드리지 않는다
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    } finally {
      running = false;
    }
  };
  const tickToday = async () => {
    const h = Number(new Date(Date.now() + 9 * 3600_000).toISOString().slice(11, 13));
    if (h < 8 || h > 20) return;
    if (!isTradingDay()) return; // (2026-09-10 전수 점검) 휴장일엔 오늘치 체결이 없다
    try {
      const n = await syncDay(client, kstYmd(0));
      lastSync = { at: new Date().toISOString(), day: kstYmd(0), count: n };
    } catch (e) {
      lastSync = { at: new Date().toISOString(), day: kstYmd(0), count: 0, error: e instanceof Error ? e.message : String(e) };
    }
  };
  setTimeout(() => void backfill(), 45_000);
  timer = setInterval(() => void tickToday(), 30 * 60_000);
  console.log("[fills] 체결 창고 시작 — 지난 90일 채우고 장중 30분마다 오늘치");
}

/** 손으로 「지금 받기」 — 오늘 + 최근 N일 */
export async function syncRecent(client: KiwoomClient, days = 3): Promise<number> {
  let total = 0;
  for (let i = days; i >= 0; i -= 1) {
    const day = kstYmd(i);
    const dow = new Date(`${day}T00:00:00+09:00`).getDay();
    if (dow === 0 || dow === 6) continue;
    total += await syncDay(client, day);
    await new Promise((r) => setTimeout(r, 250));
  }
  return total;
}
