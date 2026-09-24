import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCloses } from "./dailyCloses.js";
import { lastTradingDay } from "./tradingDay.js";

/**
 * **네이버 대조** — 마무리 회차(20:10)의 마지막 단계 (2026-09-24, 벤티지: "네이버에서 확인할 수 있는 모든 값과
 * 우리 값의 괴리를 찾아서 우리 로직이 진짜 맞는 데이터를 표시하고 있는지 확인해").
 *
 * 왜 서버가 스스로 하나: 우리 데이터는 미니PC 안에 있고 밖에서는 문단속 뒤라 못 읽는다. 맞대기는 데이터가
 * 있는 곳에서 해야 한다. 조회 0회(키움 안 씀) — 네이버 모바일 일별표·투자자 표만 읽는다.
 *
 * 무엇을 맞대나 (표본 300종목: 거래량 상위 200 + 무작위 100)
 *   · 오늘 일봉: 고가·저가·거래량 · **애프터 종가(`ca`, 없으면 `c`)** ↔ 네이버 일별표 그 날 행
 *     (네이버 행의 종가는 **애프터마켓 종가**다 — 9/23 행 286,500 인데 9/24 행의 전일은 276,500(정규장). 실측)
 *   · 어제 정규장 종가 `c` ↔ 네이버 **오늘 행의 기준가**(종가 − 전일대비) — 정규장 종가는 다음 날 행에서만 나온다
 *   · 오늘 수급: 외국인·기관·개인 순매수 **방향** ↔ 네이버 투자자 표 같은 날 (우리는 백만원, 네이버는 주 — 값은 못 맞댄다)
 * 결과는 `data/naverAudit/<day>.json` 에, 요약 한 줄은 마무리 회차 단계 노트에.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DIR = join(here, "..", "data", "naverAudit");
const LEDGER_DIR = join(here, "..", "data", "daily");
const UA = { "User-Agent": "Mozilla/5.0", Referer: "https://m.stock.naver.com/" };

const num = (v: unknown): number | null => {
  const s = String(v ?? "").replace(/[,+%\s]/g, "");
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

async function nj<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

type NaverRow = {
  localTradedAt: string;
  closePrice: string;
  compareToPreviousClosePrice: string;
  compareToPreviousPrice?: { code?: string };
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  accumulatedTradingVolume: number | string;
};
type NaverTrend = { bizdate: string; foreignerPureBuyQuant: string; organPureBuyQuant: string; individualPureBuyQuant: string; foreignerHoldRatio: string };

export interface NaverAuditResult {
  day: string;
  at: string;
  sample: number;
  /** 네이버에 그 날 행이 있어 실제로 맞댄 수 */
  compared: number;
  afterCloseOk: number;
  highLowOk: number;
  volumeOk: number;
  prevRegularOk: number;
  prevRegularCompared: number;
  flowOk: number;
  flowCompared: number;
  mismatches: { code: string; what: string; ours: string; naver: string }[];
}

/** 부호 있는 전일대비 — 네이버는 절대값 + code(2 상승·5 하락) 로 준다 */
function signedChange(r: NaverRow): number | null {
  const v = num(r.compareToPreviousClosePrice);
  if (v === null) return null;
  const code = String(r.compareToPreviousPrice?.code ?? "");
  return code === "4" || code === "5" ? -v : v;
}

export async function runNaverAudit(day: string): Promise<NaverAuditResult> {
  const store = await loadCloses();
  const bars = store.bars ?? {};
  const ymd = day.replace(/-/g, "");
  const prevDay = lastTradingDay(new Date(`${day}T12:00:00+09:00`)).replace(/-/g, "");

  /* 표본 — 오늘 봉이 있는 종목 중 거래량 상위 200 + 무작위 100 */
  const withToday = Object.entries(bars)
    .map(([code, arr]) => ({ code, bar: arr[arr.length - 1] }))
    .filter((x) => x.bar && x.bar.d === ymd);
  withToday.sort((a, b) => (b.bar.v ?? 0) - (a.bar.v ?? 0));
  const picked = new Map(withToday.slice(0, 200).map((x) => [x.code, x.bar]));
  const rest = withToday.slice(200);
  while (picked.size < Math.min(300, withToday.length) && rest.length > 0) {
    const i = Math.floor(Math.random() * rest.length);
    const [x] = rest.splice(i, 1);
    picked.set(x.code, x.bar);
  }

  const out: NaverAuditResult = {
    day,
    at: new Date().toISOString(),
    sample: picked.size,
    compared: 0,
    afterCloseOk: 0,
    highLowOk: 0,
    volumeOk: 0,
    prevRegularOk: 0,
    prevRegularCompared: 0,
    flowOk: 0,
    flowCompared: 0,
    mismatches: [],
  };
  const miss = (code: string, what: string, ours: string, naver: string) => {
    if (out.mismatches.length < 80) out.mismatches.push({ code, what, ours, naver });
  };

  /* 네이버에 예의 — 다섯씩, 묶음 사이 150ms */
  const codes = [...picked.keys()];
  for (let i = 0; i < codes.length; i += 5) {
    await Promise.all(
      codes.slice(i, i + 5).map(async (code) => {
        const bar = picked.get(code)!;
        const rows = await nj<NaverRow[]>(`https://m.stock.naver.com/api/stock/${code}/price?pageSize=4`);
        const today = rows?.find((r) => r.localTradedAt.replace(/-/g, "") === ymd);
        if (today) {
          out.compared += 1;
          const ourClose = bar.ca ?? bar.c;
          const nClose = num(today.closePrice);
          if (nClose !== null && ourClose === nClose) out.afterCloseOk += 1;
          else miss(code, bar.ca !== undefined ? "애프터 종가" : "종가(ca 없음)", String(ourClose), String(nClose));
          const nh = num(today.highPrice);
          const nl = num(today.lowPrice);
          if (nh === bar.h && nl === bar.l) out.highLowOk += 1;
          else miss(code, "고저", `h${bar.h} l${bar.l}`, `h${nh} l${nl}`);
          const nv = num(today.accumulatedTradingVolume);
          /* 거래량은 통합(NXT 포함) 여부로 갈릴 수 있어 2% 안이면 같은 것으로 */
          if (nv !== null && bar.v > 0 && Math.abs(nv - bar.v) / bar.v <= 0.02) out.volumeOk += 1;
          else miss(code, "거래량", String(bar.v), String(nv));
          /* 어제 정규장 종가 = 오늘 행의 기준가 */
          const ch = signedChange(today);
          const arr = bars[code] ?? [];
          const yb = arr.find((b) => b.d === prevDay);
          if (yb && nClose !== null && ch !== null) {
            out.prevRegularCompared += 1;
            const base = nClose - ch;
            if (base === yb.c) out.prevRegularOk += 1;
            else miss(code, `정규장 종가(${prevDay})`, String(yb.c), String(base));
          }
        }
        /* 수급 — 우리 원장 파일 vs 네이버 투자자 표 */
        try {
          const led = JSON.parse(await readFile(join(LEDGER_DIR, `${code}.json`), "utf8")) as { flow?: { d: string; ind: number; fgn: number; org: number }[] };
          const f = led.flow?.find((x) => x.d === ymd);
          if (f) {
            const tr = await nj<NaverTrend[]>(`https://m.stock.naver.com/api/stock/${code}/trend?pageSize=3`);
            const n = tr?.find((x) => x.bizdate === ymd);
            if (n) {
              /*
               * 우리 원장은 **금액(백만원)**, 네이버 투자자 표는 **주(수량)** — 값은 못 맞대고 **방향(부호)** 만 맞댄다.
               * 순매수 금액과 순매수 수량은 같은 날엔 거의 늘 같은 부호다(장중 가격 변동으로 갈리는 극단만 예외).
               * 아주 작은 값(|금액| < 5백만원 또는 |주| < 500)은 「보합」으로 쳐서 어느 쪽과도 맞는 것으로.
               */
              const sg = (amt: number, qty: number | null): boolean => {
                if (qty === null) return true;
                if (Math.abs(amt) < 5 || Math.abs(qty) < 500) return true;
                return Math.sign(amt) === Math.sign(qty);
              };
              out.flowCompared += 1;
              const same = sg(f.fgn, num(n.foreignerPureBuyQuant)) && sg(f.org, num(n.organPureBuyQuant)) && sg(f.ind, num(n.individualPureBuyQuant));
              if (same) out.flowOk += 1;
              else miss(code, "수급 방향(외/기/개, 우리=백만원 네이버=주)", `${f.fgn}/${f.org}/${f.ind}`, `${n.foreignerPureBuyQuant}/${n.organPureBuyQuant}/${n.individualPureBuyQuant}`);
            }
          }
        } catch {
          /* 원장 없는 종목 — 수급은 안 맞댄다 */
        }
      }),
    );
    await new Promise((r) => setTimeout(r, 150));
  }

  await mkdir(DIR, { recursive: true });
  await writeFile(join(DIR, `${day}.json`), JSON.stringify(out, null, 1), "utf8");
  return out;
}

/** 단계 노트 한 줄 */
export function auditNote(r: NaverAuditResult): string {
  if (r.compared === 0) return `표본 ${r.sample} · 네이버에 오늘 행 없음(휴장?)`;
  const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : "-");
  return (
    `표본 ${r.compared} · 애프터종가 ${pct(r.afterCloseOk, r.compared)} · 고저 ${pct(r.highLowOk, r.compared)} · 거래량 ${pct(r.volumeOk, r.compared)}` +
    ` · 어제 정규장종가 ${pct(r.prevRegularOk, r.prevRegularCompared)} · 수급 ${pct(r.flowOk, r.flowCompared)}` +
    (r.mismatches.length ? ` · 어긋남 ${r.mismatches.length}건(파일)` : "")
  );
}
