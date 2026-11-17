import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLiveFeats } from "./signalSamples.js";
import { passesSieve, rankBundle, type BundlePick } from "./cisBundleScore.js";
import { loadCloses } from "./dailyCloses.js";

/**
 * **나란히 재 본다** (2026-11-17) — 새 꾸러미를 실계좌에 물리기 전에.
 *
 * 벤티지가 고른 길이다: "먼저 나란히 재 본다". 실측은 분명했지만(꾸러미 +3.2/61% vs
 * 신호등 +0.6/53%) **표본 130일이 전부 약세장**이라, 저변동 비중이 한 계절에 맞춰진
 * 것일 수 있다. 그걸 확인할 길은 **앞으로 쌓는 것**뿐이다.
 *
 * ## 무엇을 남기나
 *
 * 거래일마다 한 줄. 꾸러미가 그날 고른 상위 다섯과, 그때 시세. 사지는 않는다 —
 * **고른 것만** 적는다. 항해일지가 실제로 산 것은 이미 항해일지 원장에 있으므로,
 * 2~3주 뒤에 둘을 맞대면 「누가 더 잘 골랐나」가 나온다.
 *
 * ## ⚠️ 성적은 **다음 날 시가**부터 센다
 *
 * 오늘 종가를 보고 고른 것을 오늘 종가에 살 수는 없다. 표본이 그렇게 재고 있으므로
 * (`samplesFromLedger` 의 「다음 날 시가에 산다」) 여기도 똑같이 센다 — **규칙이 갈라지면
 * 같은 이름의 숫자가 다른 뜻이 된다.**
 *
 * ## 조회 0회
 *
 * 고를 때는 `signalSamplesLive.json`(마감 뒤 정리가 표본과 같은 손으로 만든 오늘치 재료),
 * 성적을 채울 때는 일봉 캐시만 본다. 키움을 한 번도 안 부른다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const FILE = join(here, "..", "data", "cisShadow.json");

export interface ShadowPick extends BundlePick {
  /** 다음 날 시가 — 여기서부터 센다. 아직 모르면 null */
  entry: number | null;
  /** 진입 뒤 n거래일 수익률 % */
  d1: number | null;
  d5: number | null;
  d10: number | null;
  d20: number | null;
  /** 보유 중 최고·최저 (20일) — 손절에 닿았는지 보려면 이게 있어야 한다 */
  mfe20: number | null;
  mae20: number | null;
}

export interface ShadowDay {
  /** 고른 날 (그날 종가 기준) */
  date: string;
  pickedAt: string;
  /** 체를 지난 종목 수 — 풀이 얼마나 넓었나 */
  pool: number;
  picks: ShadowPick[];
}

export interface ShadowFile {
  updatedAt: string;
  days: ShadowDay[];
}

const EMPTY: ShadowFile = { updatedAt: "", days: [] };

async function load(): Promise<ShadowFile> {
  try {
    return JSON.parse(await readFile(FILE, "utf-8")) as ShadowFile;
  } catch {
    return { ...EMPTY, days: [] };
  }
}

async function save(f: ShadowFile): Promise<void> {
  await mkdir(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(f), "utf-8");
  await rename(tmp, FILE);
}

/** 하루에 몇 개를 고르나 — 실측에서 4/4 블록을 버틴 자리가 5 다 */
const PICK_N = 5;

/**
 * 오늘치 재료로 꾸러미가 고른다. 같은 날짜를 두 번 적지 않는다.
 *
 * 신호등 빨강 거르기는 **여기서 안 한다** — 오늘치 재료에는 등급 칸이 없고, 등급을 다시
 * 매기려면 종목마다 조회가 나간다. 실측에서 빨강을 빼도 +3.5 → +3.2 로 오히려 조금
 * 낮았으니(둘 다 4/4) 없이 간다. 체 셋만으로도 같은 자리다.
 */
export async function runShadowPick(): Promise<{ date: string; picked: number; note: string }> {
  const live = await loadLiveFeats();
  if (!live || live.rows.length === 0) {
    return { date: "", picked: 0, note: "오늘치 재료가 없다 — 마감 뒤 정리가 아직 안 돌았다" };
  }
  const file = await load();
  if (file.days.some((d) => d.date === live.date)) {
    return { date: live.date, picked: 0, note: "그날은 이미 골랐다" };
  }
  const pool = live.rows.filter(passesSieve);
  const ranked = rankBundle(pool).slice(0, PICK_N);
  file.days.push({
    date: live.date,
    pickedAt: new Date().toISOString(),
    pool: pool.length,
    picks: ranked.map((p) => ({
      ...p,
      entry: null,
      d1: null,
      d5: null,
      d10: null,
      d20: null,
      mfe20: null,
      mae20: null,
    })),
  });
  file.days.sort((a, b) => a.date.localeCompare(b.date));
  file.updatedAt = new Date().toISOString();
  await save(file);
  return { date: live.date, picked: ranked.length, note: `체 통과 ${pool.length} 중 ${ranked.length}` };
}

/**
 * 쌓인 줄의 성적을 일봉으로 채운다 — 날이 갈수록 한 칸씩 찬다.
 *
 * 이미 찬 칸은 다시 안 센다. 일봉이 아직 안 자랐으면 그대로 null 로 둔다 —
 * **못 잰 것을 0 으로 적으면 「본전」으로 읽힌다.**
 */
export async function fillShadowOutcomes(): Promise<{ filled: number; pending: number }> {
  const file = await load();
  if (file.days.length === 0) return { filled: 0, pending: 0 };
  const { bars } = await loadCloses();
  const barsOf = bars ?? {};
  let filled = 0;
  let pending = 0;

  for (const day of file.days) {
    for (const p of day.picks) {
      if (p.d20 !== null) continue;
      const bs = barsOf[p.code] ?? [];
      const i = bs.findIndex((b) => b.d === day.date);
      /* 고른 날 다음 봉의 **시가**가 진입가다 — 표본과 같은 규칙 */
      const e = i >= 0 ? bs[i + 1] : undefined;
      if (!e || !(e.o > 0)) {
        pending += 1;
        continue;
      }
      const entry = e.o;
      p.entry = entry;
      const at = (k: number) => {
        const b = bs[i + k];
        return b && b.c > 0 ? Math.round(((b.c - entry) / entry) * 10000) / 100 : null;
      };
      const before = p.d20;
      p.d1 = at(1);
      p.d5 = at(5);
      p.d10 = at(10);
      p.d20 = at(20);
      let up: number | null = null;
      let dn: number | null = null;
      for (let k = 1; k <= 20; k += 1) {
        const b = bs[i + k];
        if (!b) break;
        const hi = ((b.h - entry) / entry) * 100;
        const lo = ((b.l - entry) / entry) * 100;
        if (up === null || hi > up) up = hi;
        if (dn === null || lo < dn) dn = lo;
      }
      p.mfe20 = up === null ? null : Math.round(up * 100) / 100;
      p.mae20 = dn === null ? null : Math.round(dn * 100) / 100;
      if (p.d20 !== before) filled += 1;
      if (p.d20 === null) pending += 1;
    }
  }
  file.updatedAt = new Date().toISOString();
  await save(file);
  return { filled, pending };
}

/** 화면이 읽는다 */
export async function shadowLedger(): Promise<ShadowFile> {
  return load();
}
