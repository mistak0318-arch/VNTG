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
    /* `.gz` 도 같은 날짜 파일이다 — 압축했다고 보관 기간에서 빠지면 안 된다 */
    datePattern: /^(\d{4}-\d{2}-\d{2})\.(jsonl|json)(\.gz)?$/,
    /*
     * ## 30 → 1300 (2026-09-01) — **압축을 넣었으니 길게 둔다**
     *
     * 벤티지: "최대 5년치 약 100기가 정도로 두고 5년 지나면 앞에것부터 지워나가는
     * 로직으로 해도 되겠다."
     *
     * 압축률을 실측했다: 64.5MB → 15.2MB, **4.2:1**. 하루 70MB 짜리가 17MB 가
     * 되므로 5년치(1,250거래일)가 **88GB → 21GB** 다. 미니PC 여유가 200GB 니
     * 5년을 통째로 들고 있어도 된다.
     *
     * ⚠️ 이건 **다시 못 만드는 데이터**다 — 키움이 지나간 실시간을 안 준다.
     * 30일로 두면 「한 달 전 그 급등날 창구가 어땠나」를 영영 못 본다.
     */
    defaultKeep: 1300,
    rebuildable: false,
  },
  {
    key: "daily",
    label: "종목별 일별 원장",
    what: "전종목 투자자별 수급 13주체 · 공매도 · 대차잔고 · 외국인 지분율 · 프로그램. 매일 마감 뒤 한 바퀴 돈다",
    kind: "append",
    path: "daily",
    /*
     * ⚠️ `append` 다 — 종목별 파일이라 **날짜로 못 자른다.** 파일 하나에 그 종목의
     * 2년치가 들어 있고, 자르려면 파일을 열어 다시 써야 한다. 그 정리는
     * `dailyStore.keepDays()` 가 수집할 때 같이 한다(`VNTG_DAILY_KEEP`).
     * 여기서는 **크기만 보여 준다** — 자를 수 없는 것을 자를 수 있는 것처럼
     * 보여 주지 않는다.
     */
    defaultKeep: null,
    rebuildable: false,
  },
  {
    key: "newsKeywords",
    label: "뉴스 키워드",
    what: "네이버 금융 뉴스 제목에서 뽑은 낱말과 시각",
    kind: "daily",
    path: "newsKeywords",
    datePattern: /^(\d{4}-\d{2}-\d{2})\.json(\.gz)?$/,
    /* 60 → 365 (2026-09-10 벤티지: "텔레그램이랑 뉴스 계속해서 일년치 수집하기로 했잖아") */
    defaultKeep: 365,
    rebuildable: false,
  },
  {
    /*
     * **텔레그램 창고** (2026-09-10) — 채널 글 원문(날짜별 JSONL). 시세분석의 📰✈ 수, 동향·검색,
     * 버즈 상세가 전부 여기서 나온다. 여태 channelStore.ts 안의 상수(31일)로만 잘려 이 표에
     * 없었다 — 「일년치 수집」인데 한 달만 남는 상태였다. 이제 여기 기간이 창고를 다스린다.
     */
    key: "channelStore",
    label: "텔레그램 채널 창고",
    what: "채널 글 원문(날짜별). 시세분석 📰✈ 수 · 동향 · 검색 · 버즈 상세가 여기서 나온다",
    kind: "daily",
    path: "channelStore",
    datePattern: /^(\d{4}-\d{2}-\d{2})\.jsonl(\.gz)?$/,
    defaultKeep: 365,
    rebuildable: false,
  },
  {
    key: "krxNotices",
    label: "KIND 공시 (시장조치 포함)",
    what: "거래소 공시 목록 날짜별 — 공매도 과열·투자경고·단기과열 배너와 공시 탭이 읽는다",
    kind: "daily",
    path: "krxNotices",
    datePattern: /^(\d{4}-\d{2}-\d{2})\.json(\.gz)?$/,
    defaultKeep: 365,
    rebuildable: true,
  },
  {
    key: "buzz",
    label: "텔레그램 버즈",
    what: "채널 언급 횟수와 원문 조각. 텍스트만이라 아주 작다",
    kind: "daily",
    path: "buzz",
    datePattern: /^(\d{4}-\d{2}-\d{2})\.json(\.gz)?$/,
    defaultKeep: 365,
    rebuildable: false,
  },
  {
    key: "events",
    label: "이벤트 로그",
    what: "시그널·키워드·손절 판정이 일어난 자리에서 한 줄씩 적어 둔 것",
    kind: "daily",
    path: "events",
    datePattern: /^(\d{4}-\d{2}-\d{2})\.jsonl(\.gz)?$/,
    defaultKeep: 365,
    rebuildable: false,
  },
  {
    key: "signalHistory",
    label: "신호등 점수 이력",
    what: "그날의 신호등 점수. 지나간 날은 다시 계산할 수 없다",
    kind: "daily",
    path: "signalHistory",
    datePattern: /^(\d{4}-\d{2}-\d{2})\.jsonl(\.gz)?$/,
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
  /*
   * **덮어쓰는 큰 파일들** (2026-09-10) — 여태 「그 밖」 한 줄에 뭉쳐 160MB 로만 보였다.
   * 무엇이 큰지 보여야 「지울 수 있나」를 판단한다. 전부 매번 다시 만드는 것이라 자를 건 없다.
   */
  {
    key: "dailyCloses",
    label: "일봉 캐시 (전종목)",
    what: "마감 뒤 정리 ①이 만드는 전종목 일봉. 매일 통째로 다시 쓴다 — 지워도 다음 마감에 다시 생긴다",
    kind: "single",
    path: "dailyCloses.json",
    defaultKeep: null,
    rebuildable: true,
  },
  {
    key: "signalSamples",
    label: "신호등 검증 표본",
    what: "과거 시세로 만든 검증 표본. 마감 뒤 정리 ⑨가 덧쓴다",
    kind: "single",
    path: "signalSamples.json",
    defaultKeep: null,
    rebuildable: true,
  },
  {
    key: "companyBriefs",
    label: "회사설명 3,900",
    what: "전 종목 회사설명(seed·본문·백업). 세션이 쓴 글이라 지우면 다시 못 만든다",
    kind: "single",
    path: "companyBriefs.json",
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
/**
 * 다른 모듈의 자체 정리가 **이 표를 따르게** (2026-09-10). 이벤트 로그(90)·버즈(30)·뉴스 키워드(14)가
 * 저마다 상수를 갖고 있어, 표에서 1년으로 둬도 그쪽이 먼저 지웠다. 「안 지움」이면 아주 크게.
 */
export async function keepDaysOr(key: string, fallback: number): Promise<number> {
  try {
    const k = await keepDaysOf(key);
    if (k === null) return 3650;
    return Number.isFinite(k) && k > 0 ? k : fallback;
  } catch {
    return fallback;
  }
}

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
  /** 하루에 얼마나 느는가 (날짜 파일 평균 · 덧붙는 갈래는 나이로 어림) */
  perDay: number;
  perDayEstimated: boolean;
  /** 이 속도·이 보관 기간이면 1년 뒤 얼마인가 */
  afterYear: number;
  rebuildable: boolean;
}

function ymd(t: number): string {
  return new Date(t + 9 * 3600_000).toISOString().slice(0, 10);
}

async function dirFiles(dir: string): Promise<{ name: string; bytes: number; mtime: number; birth: number }[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: { name: string; bytes: number; mtime: number; birth: number }[] = [];
  for (const name of names) {
    const s = await stat(join(dir, name)).catch(() => null);
    if (s?.isFile()) out.push({ name, bytes: s.size, mtime: s.mtimeMs, birth: s.birthtimeMs });
  }
  return out;
}

export async function scanCat(cat: DataCat): Promise<CatStat> {
  const dir = join(DATA_DIR, cat.path);
  /* single 은 파일 하나(같은 이름의 백업·seed 도 같이) — 폴더가 아니라 dirFiles 가 못 본다 */
  const files =
    cat.kind === "single"
      ? (await dirFiles(DATA_DIR)).filter((f) => f.name === cat.path || f.name.startsWith(cat.path.replace(/\.json$/, "") + "."))
      : await dirFiles(dir);
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

  /*
   * 하루치와 **1년 뒤** (2026-09-10 — 벤티지: "지금 680메가로 되어 있거든. 이 상태로 일년치일 때 어떨지").
   * - daily: 날짜 파일 평균 × (보관일 ≤ 365 면 보관일, 아니면 지금 + 365일치)
   * - append: 파일 나이(가장 오래된 만든 날)로 하루치를 어림한다 — 정확하진 않아 「≈」
   * - single: 안 자란다(덮어쓴다)
   */
  let perDay = datedDays.size > 0 ? Math.round(datedBytes / datedDays.size) : 0;
  let perDayEstimated = false;
  if (cat.kind === "append" && files.length > 0) {
    if (cat.key === "daily") {
      /* 원장은 첫날 100거래일치를 한꺼번에 받으므로 파일 나이로 재면 열 배 부풀린다 — 담긴 거래일 수로 */
      try {
        const { ledgerStatus } = await import("./dailyStore.js");
        const st = await ledgerStatus();
        perDay = st.maxDays > 0 ? Math.round(bytes / st.maxDays) : 0;
      } catch {
        perDay = 0;
      }
    } else {
      const first = Math.min(...files.map((f) => f.birth || f.mtime));
      const age = Math.max(1, (Date.now() - first) / 86400_000);
      perDay = Math.round(bytes / age);
    }
    perDayEstimated = true;
  }
  const afterYear =
    cat.kind === "single"
      ? bytes
      : cat.kind === "daily" && keepDays !== null && keepDays <= 365
        ? perDay * keepDays
        : bytes + perDay * 365;

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
    rebuildable: cat.rebuildable,
    byAge,
    prunable,
    perDay,
    perDayEstimated,
    afterYear,
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
  /** 하루 증가 합 · 1년 뒤 예상 합 (갈래 합 + 그 밖) */
  perDayBytes: number;
  afterYearBytes: number;
  disk: { free: number; total: number } | null;
}

export async function dataReport(): Promise<DataReport> {
  const cats: CatStat[] = [];
  for (const c of CATS) cats.push(await scanCat(c));

  /* 갈래에 안 잡힌 나머지 — 매번 덮어쓰는 단일 파일들 */
  const known = new Set(CATS.map((c) => c.path));
  const singleStems = CATS.filter((c) => c.kind === "single").map((c) => c.path.replace(/\.json$/, "") + ".");
  let otherBytes = 0;
  for (const name of await readdir(DATA_DIR).catch(() => [] as string[])) {
    if (known.has(name) || singleStems.some((st) => name.startsWith(st))) continue;
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
    perDayBytes: cats.reduce((a, c) => a + c.perDay, 0),
    afterYearBytes: cats.reduce((a, c) => a + c.afterYear, 0) + otherBytes,
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

/* ------------------------------------------------------------------ */
/* 압축 — 지난 날 파일을 gzip 으로                                       */
/* ------------------------------------------------------------------ */

/**
 * **지난 날의 큰 로그를 압축한다** (2026-09-01).
 *
 * 벤티지: "최대 5년치 약 100기가 정도로 두고 5년 지나면 앞에것부터 지워나가는
 * 로직으로 해도 되겠다."
 *
 * 지우기 전에 할 것이 하나 더 있었다. 실시간 로그는 **같은 JSON 키가 40만 번**
 * 반복되는 파일이라 압축이 아주 잘 듣는다. 실측: 64.5MB → 15.2MB, **4.2:1**.
 *
 * 그래서 5년치가 88GB 가 아니라 **21GB** 다. 미니PC 여유가 200GB 니 5년을
 * 통째로 들고 있어도 된다 — **지울 이유 자체가 줄어든다.** 이 데이터는 다시
 * 못 받으므로(키움이 지나간 실시간을 안 준다) 그게 훨씬 낫다.
 *
 * ## 오늘 것은 안 건드린다
 *
 * 장중에는 계속 덧붙는 중이다. 압축해 버리면 그 뒤에 오는 줄을 못 쓴다.
 * **어제 이전**만 압축한다.
 *
 * ## 원본은 압축이 끝난 뒤에 지운다
 *
 * 순서를 바꾸면 중간에 프로세스가 죽었을 때 **원본도 없고 압축본도 반쪽**인
 * 상태가 남는다. 쓰기가 끝나고 크기를 확인한 뒤에 지운다.
 */
export async function compressOldLogs(): Promise<{ done: number; saved: number }> {
  const { createReadStream, createWriteStream } = await import("node:fs");
  const { createGzip } = await import("node:zlib");
  const { pipeline } = await import("node:stream/promises");

  let done = 0;
  let saved = 0;
  const today = ymd(Date.now());
  const yesterday = ymd(Date.now() - 86400_000);

  for (const cat of CATS) {
    if (cat.kind !== "daily" || !cat.datePattern) continue;
    /*
     * ⚠️ **실시간 로그만 누른다** (2026-09-10 저녁 전수 점검 P0). 창고(channelStore)·뉴스 키워드는 읽는 쪽이
     * `${day}.jsonl` 이름을 그대로 열어서 .gz 로 바꾸면 그날치가 통째로 안 보인다 — 실제로 newsKeywords/2026-09-08
     * 이 gz 로 눌려 안 읽히고 있었고, 오늘 창고를 표에 넣으면서 창고까지 눌릴 뻔했다.
     */
    if (cat.key !== "realtime") continue;
    const dir = join(DATA_DIR, cat.path);
    for (const f of await dirFiles(dir)) {
      if (f.name.endsWith(".gz")) continue;
      const m = cat.datePattern.exec(f.name);
      if (!m) continue;
      /* 오늘·어제는 아직 덧붙는 중일 수 있다 */
      if (m[1] >= yesterday || m[1] === today) continue;
      /* 작은 파일은 압축해 봐야 얻는 게 없다 */
      if (f.bytes < 1_000_000) continue;

      const src = join(dir, f.name);
      const dst = `${src}.gz`;
      try {
        await pipeline(createReadStream(src), createGzip({ level: 6 }), createWriteStream(dst));
        const gz = await stat(dst);
        /* 압축본이 멀쩡할 때만 원본을 지운다 */
        if (gz.size > 0 && gz.size < f.bytes) {
          await unlink(src);
          done += 1;
          saved += f.bytes - gz.size;
        } else {
          await unlink(dst).catch(() => undefined);
        }
      } catch {
        /* 하나 실패해도 나머지는 압축한다. 반쪽 파일은 지운다 */
        await unlink(dst).catch(() => undefined);
      }
    }
  }
  return { done, saved };
}

/**
 * 잘못 눌린 파일 되돌리기 (2026-09-10) — 실시간 로그가 아닌 갈래에 남은 `.gz` 를 원래 이름으로 풀어 둔다.
 * 원본이 이미 있으면(그 뒤에 새로 적힌 것) 이어 붙이지 않고 gz 는 `.gz.bak` 로 옆에 둔다 — 지우지 않는다.
 */
export async function restoreCompressed(): Promise<{ restored: number; kept: number }> {
  const { createReadStream, createWriteStream } = await import("node:fs");
  const { createGunzip } = await import("node:zlib");
  const { pipeline } = await import("node:stream/promises");
  const { rename } = await import("node:fs/promises");
  let restored = 0;
  let kept = 0;
  for (const cat of CATS) {
    if (cat.kind !== "daily" || cat.key === "realtime") continue;
    const dir = join(DATA_DIR, cat.path);
    for (const f of await dirFiles(dir)) {
      if (!f.name.endsWith(".gz")) continue;
      const src = join(dir, f.name);
      const dst = src.slice(0, -3);
      const exists = await stat(dst).then(() => true).catch(() => false);
      if (exists) {
        await rename(src, `${src}.bak`).catch(() => undefined);
        kept += 1;
        continue;
      }
      try {
        await pipeline(createReadStream(src), createGunzip(), createWriteStream(dst));
        await unlink(src);
        restored += 1;
      } catch {
        await unlink(dst).catch(() => undefined);
      }
    }
  }
  if (restored + kept > 0) console.log(`[data] 잘못 눌린 파일 되돌림 ${restored}개 (원본 있어 둔 것 ${kept}개)`);
  return { restored, kept };
}

let timer: NodeJS.Timeout | null = null;

/** 하루 한 번 정리. 기동 직후에도 한 번 — 이미 넘쳐 있을 수 있다 */
export function startRetentionScheduler(): void {
  if (timer) return;
  const tick = async () => {
    try {
      /*
       * **압축이 먼저다.** 지우기 전에 줄일 수 있으면 줄인다 — 이 데이터는 다시
       * 못 받으므로 「작게 오래 두기」가 「크게 짧게 두기」보다 낫다.
       */
      await restoreCompressed();
      const z = await compressOldLogs();
      if (z.done > 0) {
        console.log(`[data] 지난 로그 ${z.done}개 압축 — ${(z.saved / 1048576).toFixed(1)}MB 절약`);
      }
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
