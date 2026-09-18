import { recordApiCall } from "./apiUsage.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";
import { getSection, type MarketFlow } from "./marketOverview.js";
import { futuresFlow } from "./naverFuturesFlow.js";

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
let goneUntil = 0; // (2026-09-18 E1-b) 410 을 만난 뒤 한 시간은 안 두드린다

/*
 * **우리가 직접 찍는 표본** (2026-09-18 — 벤티지: "지수 클릭하면 당일 수급현황 그래프 보여줬던 거 왜 없앴어? 다시 살려").
 *
 * 네이버가 Time 표를 닫아(410) 곡선이 사라졌다. 같은 그림을 남의 표 없이 그린다 — 시황 「국내 지수」 카드가 이미
 * 받는 오늘 누적 수급(ka10051, flow 섹션·억원)을 **2분마다 한 점씩** 파일에 적어 두면 하루가 곧 누적 곡선이다.
 * 코스피(01)·코스닥(02)은 키움 flow 섹션, K200 선물(03)은 네이버 새 API(m.stock.naver.com/api/index/FUT/trend, 계약).
 * 파일은 data/intradayFlow/YYYY-MM-DD.json 하나에 두 시장. 재시작해도 이어 붙는다.
 */
const SAMPLE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "intradayFlow");
type SampleFile = Partial<Record<FlowMarket, IntraFlowPoint[]>>;
const sampleCache = new Map<string, SampleFile>();

async function loadSamples(date: string): Promise<SampleFile> {
  const hit = sampleCache.get(date);
  if (hit) return hit;
  let f: SampleFile = {};
  try {
    f = JSON.parse(await readFile(join(SAMPLE_DIR, `${date}.json`), "utf-8")) as SampleFile;
  } catch {
    f = {};
  }
  sampleCache.set(date, f);
  return f;
}

/** 시황 flow 섹션의 오늘 누적을 한 점 적는다 — 스케줄러가 장중 2분마다 부른다. 같은 분이면 안 적는다 */
export async function sampleIntradayFlow(client: KiwoomClient): Promise<void> {
  const d = new Date(Date.now() + 9 * 3600_000);
  const minute = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (minute < 9 * 60 || minute > 15 * 60 + 40) return;
  const flow = (await getSection("flow", client)).data as MarketFlow | null;
  if (!flow) return;
  const date = d.toISOString().slice(0, 10).replace(/-/g, "");
  const t = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  const f = await loadSamples(date);
  let changed = false;
  /* K200 선물(03)은 네이버 새 API(오늘 누적, 계약) — 같은 박자로 한 점 */
  const fut = await futuresFlow(1).catch(() => []);
  const futToday = fut.length > 0 && fut[fut.length - 1].date.replace(/-/g, "") === date ? fut[fut.length - 1] : null;
  const srcs: [FlowMarket, { individual: number; foreign: number; institution: number }][] = [["01", flow.kospi], ["02", flow.kosdaq]];
  if (futToday) srcs.push(["03", futToday]);
  for (const [m, src] of srcs) {
    const arr = f[m] ?? (f[m] = []);
    const last = arr[arr.length - 1];
    if (last && last.t === t) continue;
    /* 값이 하나도 안 바뀌었으면(섹션 캐시가 그대로) 점을 안 늘린다 — 곡선이 계단으로 굳지 않게 */
    if (last && last.individual === src.individual && last.foreign === src.foreign && last.institution === src.institution) continue;
    arr.push({ t, individual: src.individual, foreign: src.foreign, institution: src.institution });
    changed = true;
  }
  if (!changed) return;
  try {
    await mkdir(SAMPLE_DIR, { recursive: true });
    await writeFile(join(SAMPLE_DIR, `${date}.json`), JSON.stringify(f), "utf-8");
  } catch {
    /* 못 적어도 다음 2분에 다시 */
  }
}

/** 오늘(없으면 가장 최근 닷새 안) 표본 — 시간 오름차순 */
async function sampledFlow(sosok: FlowMarket): Promise<{ date: string; points: IntraFlowPoint[] }> {
  for (let back = 0; back < 5; back++) {
    const ymd = kstDate(back);
    const f = await loadSamples(ymd);
    const pts = f[sosok] ?? [];
    if (pts.length > 0) return { date: `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`, points: pts };
  }
  return { date: "", points: [] };
}

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
  /* 네이버가 닫혀 있으면 우리 표본으로 */
  if (Date.now() < goneUntil) return sampledFlow(sosok);
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
    /*
     * (2026-09-18 전수검증 E1-b) 네이버가 이 주소를 **닫았다**(HTTP 410 Gone, 어제 날짜로 물어도 410). 던지면 시트가
     * 열릴 때마다 500 + 스택이다. 「없음」으로 주고 한 시간 동안 다시 안 두드린다. 대체 출처는 따로 정할 일.
     */
    if (e instanceof Error && /HTTP 410/.test(e.message)) {
      goneUntil = Date.now() + 3600_000;
      return sampledFlow(sosok);
    }
    throw e;
  }
}
