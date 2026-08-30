import { mkdir, readdir, readFile, stat, statfs, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(here, "..", "data");
const CFG = join(DATA_DIR, "dataRetention.json");

/**
 * 쌓이는 데이터의 **보관 기간과 용량** (2026-08-31 요청 —
 * 「기간별로 드는 용량 표시해주고, 최종적으로 전체 용량도. 어차피 쌓는 데이터인데」).
 *
 * ## 왜 필요했나
 *
 * 실측해 보니 `server/data` 가 **221MB 인데 그중 214MB 가 실시간 로그 하나**였다.
 * 하루 61MB 씩 늘고 있었고 **지우는 코드가 아예 없었다** — 한 달이면 1.8GB,
 * 일 년이면 22GB 다. 아무도 안 보고 있었다는 게 문제의 전부다.
 *
 * ## 무엇을 자를 수 있고 무엇은 못 자르나
 *
 *   - `daily`  날짜 이름 파일(`2026-08-28.jsonl`). **날짜로 자를 수 있다.**
 *   - `append` 한 파일에 계속 덧붙이는 것. 자르려면 파일을 다시 써야 해서
 *              여기서는 **크기만 보여 준다.**
 *   - `single` 매번 덮어쓰는 것(일봉 캐시·테마 분류). 이력이 없으니 **자를 게 없다.**
 *
 * 자를 수 없는 것을 자를 수 있는 것처럼 보여 주지 않는다. 표에 종류를 같이 적는다.
 *
 * ⚠️ **되살릴 수 없는 것은 기본을 길게 잡는다.** 신호등 점수·복기·이벤트는 지난 날을
 * 다시 만들 수 없다(그때 시점에만 계산된다). 실시간 로그는 크고, 지나간 체결을
 * 다시 볼 일은 드물어 기본을 짧게 둔다.
 */

export type CatKind = "daily" | "append" | "single";

export interface DataCat {
  key: string;
  label: string;
  what: string;
  kind: CatKind;
  /** DATA_DIR 아래 폴더 이름 (daily/append) 또는 파일 이름 (single) */
  path: string;
  /** 날짜 파일 이름 규칙 — daily 만 */
  datePattern?: RegExp;
  /** 기본 보관일. null 이면 「안 지움」 */
  defaultKeep: number | null;
  /** 지워도 다시 만들 수 있나 — 화면이 경고를 띄울지 정한다 */
  rebuildable: boolean;
}

export const CATS: DataCat[] = [
  {
    key: "realtime",
    label: "실시간 체결·거래원·프로그램",
    what: "장중 웹소켓으로 받은 원본 프레임. 거래원·프로그램 매매 추이가 여기서 나온다",
    kind: "daily",
    path: "realtime",
    datePattern: /^(\d{4}-\d{2}-\d{2})\.(jsonl|json)$/,
    defaultKeep: 30,
    rebuildable: false,
  },
  {
    key: "newsKeywords",
    label: "뉴스 키워드",
    what: "네이버 금융 뉴스 제목에서 뽑은 낱말과 시각",
    kind: "daily",
    path: "newsKeywords",
    datePattern: /^(\d{4}-\d{2}-\d{2})\.json$/,
    defaultKeep: 60,
    rebuildable: false,
  },
  {
    key: "buzz",
    label: "텔레그램 버즈",
    what: "채널 언급 횟수와 원문 조각. 텍스트만이라 아주 작다",
    kind: "daily",
    path: "buzz",
    datePattern: /^(\d{4}-\d{2}-\d{2})\.json$/,
    defaultKeep: 180,
    rebuildable: false,
  },
  {
    key: "events",
    label: "이벤트 로그",
    what: "시그널·키워드·손절 판정이 일어난 자리에서 한 줄씩 적어 둔 것",
    kind: "daily",
    path: "events",
    datePattern: /^(\d{4}-\d{2}-\d{2})\.jsonl$/,
    defaultKeep: 365,
    rebuildable: false,
  },
  {
    key: "signalHistory",
    label: "신호등 점수 이력",
    what: "그날의 신호등 점수. 지나간 날은 다시 계산할 수 없다",
    kind: "daily",
    path: "signalHistory",
    datePattern: /^(\d{4}-\d{2}-\d{2})\.jsonl$/,
    defaultKeep: null,
    rebuildable: false,
  },
  {
    key: "reports",
    label: "발행한 리포트",
    what: "조간·석간 리포트 본문(AI 정리 포함)",
    kind: "daily",
    path: "reports",
    datePattern: /^(\d{4}-\d{2}-\d{2})_/,
    defaultKeep: null,
    rebuildable: false,
  },
  {
    key: "tgArchive",
    label: "텔레그램 방 아카이브",
    what: "우리가 보낸 알림들. 한 파일에 덧붙이는 구조라 날짜로 못 자른다",
    kind: "append",
    path: "tgArchive",
    defaultKeep: null,
    rebuildable: false,
  },
];

interface Cfg {
  keep: Record<string, number | null>;
}

let cache: Cfg | null = null;

async function load(): Promise<Cfg> {
  if (cache) return cache;
  try {
    const raw = JSON.parse(await readFile(CFG, "utf-8")) as Partial<Cfg>;
    cache = { keep: raw.keep ?? {} };
  } catch {
    cache = { keep: {} };
  }
  return cache;
}

async function persist(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(CFG, JSON.stringify(cache, null, 2), "utf-8");
}

/** 그 갈래의 지금 보관일. 사람이 안 정했으면 기본값 */
export async function keepDaysOf(key: string): Promise<number | null> {
  const c = await load();
  if (Object.prototype.hasOwnProperty.call(c.keep, key)) return c.keep[key];
  return CATS.find((x) => x.key === key)?.defaultKeep ?? null;
}

export async function setKeepDays(key: string, days: number | null): Promise<void> {
  const c = await load();
  c.keep[key] = days === null ? null : Math.max(1, Math.min(3650, Math.round(days)));
  await persist();
}

export interface CatStat {
  key: string;
  label: string;
  what: string;
  kind: CatKind;
  bytes: number;
  files: number;
  oldest: string | null;
  newest: string | null;
  keepDays: number | null;
  defaultKeep: number | null;
  /** 나이대별 용량 — 「30일로 줄이면 얼마가 빠지나」를 눈으로 보라고 */
  byAge: { d7: number; d30: number; d90: number; d365: number; older: number };
  /** 지금 설정대로 자르면 지워질 용량 */
  prunable: number;
  /** 하루에 얼마나 느는가 (날짜 파일 평균) */
  perDay: number;
}

function ymd(t: number): string {
  return new Date(t + 9 * 3600_000).toISOString().slice(0, 10);
}

async function dirFiles(dir: string): Promise<{ name: string; bytes: number; mtime: number }[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: { name: string; bytes: number; mtime: number }[] = [];
  for (const name of names) {
    const s = await stat(join(dir, name)).catch(() => null);
    if (s?.isFile()) out.push({ name, bytes: s.size, mtime: s.mtimeMs });
  }
  return out;
}

export async function scanCat(cat: DataCat): Promise<CatStat> {
  const dir = join(DATA_DIR, cat.path);
  const files = await dirFiles(dir);
  const keepDays = await keepDaysOf(cat.key);
  const today = ymd(Date.now());

  const byAge = { d7: 0, d30: 0, d90: 0, d365: 0, older: 0 };
  let bytes = 0;
  let oldest: string | null = null;
  let newest: string | null = null;
  let prunable = 0;
  let datedBytes = 0;
  const datedDays = new Set<string>();

  const cut = (n: number) => ymd(Date.now() - n * 86400_000);
  const c7 = cut(7);
  const c30 = cut(30);
  const c90 = cut(90);
  const c365 = cut(365);
  const cKeep = keepDays === null ? null : cut(keepDays);

  for (const f of files) {
    bytes += f.bytes;
    /*
     * 날짜는 **파일 이름에서** 읽는다. 수정 시각으로 세면 옮기거나 복사하는 순간
     * 전부 「오늘 것」이 되어 보관 기간이 통째로 헛돈다.
     */
    const m = cat.datePattern ? cat.datePattern.exec(f.name) : null;
    const day = m ? m[1] : null;
    if (!day) continue;
    datedBytes += f.bytes;
    datedDays.add(day);
    if (!oldest || day < oldest) oldest = day;
    if (!newest || day > newest) newest = day;
    if (day >= c7) byAge.d7 += f.bytes;
    else if (day >= c30) byAge.d30 += f.bytes;
    else if (day >= c90) byAge.d90 += f.bytes;
    else if (day >= c365) byAge.d365 += f.bytes;
    else byAge.older += f.bytes;
    if (cKeep && day < cKeep) prunable += f.bytes;
  }

  if (cat.kind !== "daily") {
    oldest = null;
    newest = null;
  } else if (!newest && files.length > 0) {
    newest = today;
  }

  return {
    key: cat.key,
    label: cat.label,
    what: cat.what,
    kind: cat.kind,
    bytes,
    files: files.length,
    oldest,
    newest,
    keepDays,
    defaultKeep: cat.defaultKeep,
    byAge,
    prunable,
    perDay: datedDays.size > 0 ? Math.round(datedBytes / datedDays.size) : 0,
  };
}

export interface DataReport {
  dir: string;
  cats: CatStat[];
  /** 위 갈래에 안 잡힌 나머지 (덮어쓰는 파일들) */
  otherBytes: number;
  totalBytes: number;
  /** 지금 설정대로 「지금 정리」를 누르면 빠질 용량 */
  prunableBytes: number;
  disk: { free: number; total: number } | null;
}

export async function dataReport(): Promise<DataReport> {
  const cats: CatStat[] = [];
  for (const c of CATS) cats.push(await scanCat(c));

  /* 갈래에 안 잡힌 나머지 — 매번 덮어쓰는 단일 파일들 */
  const known = new Set(CATS.map((c) => c.path));
  let otherBytes = 0;
  for (const name of await readdir(DATA_DIR).catch(() => [] as string[])) {
    if (known.has(name)) continue;
    const s = await stat(join(DATA_DIR, name)).catch(() => null);
    if (!s) continue;
    if (s.isFile()) otherBytes += s.size;
    else for (const f of await dirFiles(join(DATA_DIR, name))) otherBytes += f.bytes;
  }

  let disk: { free: number; total: number } | null = null;
  try {
    const s = await statfs(DATA_DIR);
    disk = { free: s.bsize * s.bavail, total: s.bsize * s.blocks };
  } catch {
    /* 이 플랫폼에서 못 재면 안 보여 준다 — 0 으로 적으면 거짓말이 된다 */
  }

  return {
    dir: DATA_DIR,
    cats,
    otherBytes,
    totalBytes: cats.reduce((a, c) => a + c.bytes, 0) + otherBytes,
    prunableBytes: cats.reduce((a, c) => a + c.prunable, 0),
    disk,
  };
}

/**
 * 보관 기간이 지난 날짜 파일을 지운다.
 *
 * ⚠️ `daily` 갈래만, **파일 이름의 날짜**로만 지운다. 이름에서 날짜를 못 읽은 파일은
 * 건드리지 않는다 — 규칙이 바뀌었을 때 엉뚱한 것을 지우느니 안 지우는 쪽이 낫다.
 */
export async function pruneData(): Promise<{ removed: number; bytes: number; per: Record<string, number> }> {
  let removed = 0;
  let bytes = 0;
  const per: Record<string, number> = {};
  for (const cat of CATS) {
    if (cat.kind !== "daily" || !cat.datePattern) continue;
    const keep = await keepDaysOf(cat.key);
    if (keep === null) continue;
    const cutoff = ymd(Date.now() - keep * 86400_000);
    const dir = join(DATA_DIR, cat.path);
    for (const f of await dirFiles(dir)) {
      const m = cat.datePattern.exec(f.name);
      if (!m || m[1] >= cutoff) continue;
      await unlink(join(dir, f.name)).catch(() => undefined);
      removed += 1;
      bytes += f.bytes;
      per[cat.key] = (per[cat.key] ?? 0) + f.bytes;
    }
  }
  return { removed, bytes, per };
}

let timer: NodeJS.Timeout | null = null;

/** 하루 한 번 정리. 기동 직후에도 한 번 — 이미 넘쳐 있을 수 있다 */
export function startRetentionScheduler(): void {
  if (timer) return;
  const tick = async () => {
    try {
      const r = await pruneData();
      if (r.removed > 0) {
        console.log(`[data] 오래된 파일 ${r.removed}개 정리 — ${(r.bytes / 1048576).toFixed(1)}MB`);
      }
    } catch (err) {
      console.error("[data] 정리 실패:", err instanceof Error ? err.message : err);
    }
  };
  setTimeout(() => void tick(), 60_000);
  timer = setInterval(() => void tick(), 6 * 3600_000);
  console.log("[data] 보관 기간 정리 시작 (6시간마다 확인)");
}
