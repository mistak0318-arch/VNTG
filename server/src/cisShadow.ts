import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLiveFeats } from "./signalSamples.js";
import { passesSieve, rankBundle, rankMomentum, type BundlePick } from "./cisBundleScore.js";
import { loadCloses } from "./dailyCloses.js";

/**
 * **나란히 재 본다** (2026-11-17) — 새 꾸러미를 실계좌에 물리기 전에.
 *
 * 벤티지가 고른 길이다: "먼저 나란히 재 본다". 실측은 분명했지만(꾸러미 +3.2/61% vs
 * 신호등 +0.6/53%) **표본 130일이 전부 약세장**이라, 저변동 비중이 한 계절에 맞춰진
 * 것일 수 있다. 그걸 확인할 길은 **앞으로 쌓는 것**뿐이다.
 *
 * ## 무엇을 남기나 — **두 줄이다**
 *
 * 거래일마다 두 묶음. 같은 날·같은 체·같은 자로 잰다. 사지는 않는다 — **고른 것만** 적는다.
 *
 *   `picks`  꾸러미 상위 다섯 (섹터상대·20일추세·저변동·이격, 적당한 쪽)
 *   `base`   **대조군** — 20일 상승폭 상위 다섯 (실측 -3.5/41%/블록 0/4)
 *
 * ⚠️ **처음 계획은 「꾸러미 vs 실계좌」였고 그건 안 된다** (11/17 밤에 알았다). 실계좌는
 * 거의 안 산다 — 그날 항해일지는 스캔 55번이 전부 시장문에서 막혀 0건이었고, 그 문이
 * 열리기를 기다리는 할 일은 9/15 부터 열려 있다. 3주 뒤에 「5/일 vs 0건」이 남으면
 * 비교가 아니다. 그래서 상대를 **이 파일 안에서** 만든다 — 꾸러미가 좋은지 나쁜지는
 * 같은 자로 잰 다른 고르기와 맞대야만 말할 수 있다.
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
  /**
   * 대조군 — 20일 상승폭 상위. 11/17 밤에 붙였으므로 **그 전 줄에는 없다**(옛 줄은
   * 빈 배열로 읽힌다). 화면이 「대조군 없음」과 「대조군 0승」을 가를 수 있어야 한다.
   */
  base?: ShadowPick[];
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
  const blank = (p: BundlePick): ShadowPick => ({
    ...p,
    entry: null,
    d1: null,
    d5: null,
    d10: null,
    d20: null,
    mfe20: null,
    mae20: null,
  });
  const pool = live.rows.filter(passesSieve);
  const ranked = rankBundle(pool).slice(0, PICK_N);
  const base = rankMomentum(pool).slice(0, PICK_N);

  /*
   * 이미 고른 날이면 **꾸러미는 손대지 않는다** — 다시 고르면 그날 적어 둔 것이 바뀌어
   * 기록이 아니게 된다. 다만 대조군이 비어 있으면(11/17 밤 전에 적힌 줄) 그것만 채운다.
   */
  const had = file.days.find((d) => d.date === live.date);
  if (had) {
    if (had.base && had.base.length > 0) {
      return { date: live.date, picked: 0, note: "그날은 이미 골랐다" };
    }
    had.base = base.map(blank);
    file.updatedAt = new Date().toISOString();
    await save(file);
    return { date: live.date, picked: 0, note: `대조군만 채움 ${base.length}` };
  }

  file.days.push({
    date: live.date,
    pickedAt: new Date().toISOString(),
    pool: pool.length,
    picks: ranked.map(blank),
    base: base.map(blank),
  });
  file.days.sort((a, b) => a.date.localeCompare(b.date));
  file.updatedAt = new Date().toISOString();
  await save(file);
  return {
    date: live.date,
    picked: ranked.length,
    note: `체 통과 ${pool.length} 중 꾸러미 ${ranked.length} · 대조군 ${base.length}`,
  };
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
    /* 꾸러미와 대조군을 **같은 손으로** 센다 — 자가 갈라지면 비교가 무너진다 */
    for (const p of [...day.picks, ...(day.base ?? [])]) {
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
