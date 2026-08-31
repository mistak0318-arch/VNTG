import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(__dirname, "..", "data", "stockFlowIntraday.json");

/**
 * 종목별 **장중** 투자자 수급 (2026-08-31 — "당일도 가능해? 시간순으로").
 *
 * ## 키움은 시간대별을 안 준다. 우리가 쌓는다
 *
 * `ka10059`(일별 투자자)의 오늘 줄은 **지금까지의 누적**이다. 시간대별을 주는 TR 은
 * 확인된 것이 없다 — 거래원(`brokerFlow`)이 같은 처지라 같은 방식을 쓴다.
 * 「누적만 주므로 시계열은 이렇게밖에 못 만든다.」
 *
 * ## 조회가 늘지 않는다
 *
 * `stockSummary` 가 **이미 `ka10059` 를 부르고 있다** — 종목 화면이 30초마다 폴링한다.
 * 그 응답에 오늘 누적이 들어 있으므로 **그때마다 한 점씩 찍어 두면** 곡선이 된다.
 * 따로 스케줄러를 돌리거나 조회를 더 쓸 이유가 없다.
 *
 * ## ⚠️ 한계 — 화면에 그대로 적는다
 *
 * **보고 있는 동안만 쌓인다.** 종목 화면을 안 열어 둔 시간은 빈다. 그래서
 * 「09:00부터의 완전한 흐름」이 아니라 **「내가 본 구간의 흐름」**이다.
 * 그리고 **과거로 소급할 수 없다** — 오늘 처음 열었으면 그 시각부터다.
 *
 * 지수의 장중 수급(네이버)은 09:00부터 전부 있지만 그건 **시장 단위**다.
 * 종목 단위로는 이 방법뿐이다.
 */

/** 한 점 — 그 시각까지의 **누적** 순매수(백만원) */
export interface StockFlowPoint {
  /** HH:MM (한국시간) */
  t: string;
  ind: number;
  frgn: number;
  orgn: number;
  etc: number;
  /* 기관 안쪽 */
  fnnc: number;
  invt: number;
  penf: number;
  samo: number;
  insr: number;
  bank: number;
  etcf: number;
}

interface Store {
  /** YYYY-MM-DD — 날이 바뀌면 통째로 비운다 */
  date: string;
  byCode: Record<string, StockFlowPoint[]>;
}

/**
 * 한 종목이 하루에 가질 수 있는 점 수.
 *
 * 30초 폴링이라 한 시간에 120점이 될 수 있는데, 그렇게 촘촘하면 곡선이 톱니가 되고
 * 파일만 커진다. **1분에 한 점**으로 접으므로(같은 분이면 덮어쓴다) 장중 6시간 반이면
 * 400점 안쪽이다. 넉넉히 잡아 둔다.
 */
const MAX_POINTS = 500;

let cache: Store | null = null;
let dirty = false;

const todayKst = (): string =>
  new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

const nowHm = (): string =>
  new Date(Date.now() + 9 * 3600_000).toISOString().slice(11, 16);

async function load(): Promise<Store> {
  if (cache) {
    /* 날이 바뀌면 비운다 — 어제 곡선에 오늘 점이 이어지면 통째로 거짓이 된다 */
    if (cache.date !== todayKst()) cache = { date: todayKst(), byCode: {} };
    return cache;
  }
  try {
    const raw = JSON.parse(await readFile(FILE, "utf-8")) as Store;
    cache = raw.date === todayKst() ? raw : { date: todayKst(), byCode: {} };
  } catch {
    cache = { date: todayKst(), byCode: {} };
  }
  return cache;
}

/**
 * 장중인가 — 이 시간 밖에서는 안 쌓는다.
 *
 * 장이 끝나면 `ka10059` 의 오늘 줄은 안 변한다. 그때도 찍으면 **평평한 꼬리**가
 * 몇 시간씩 붙어 곡선의 가로축을 다 먹는다. 08:50 은 장 전 동시호가, 16:00 은
 * 시간외 단일가 전까지다.
 */
function inSession(): boolean {
  const hm = nowHm();
  const d = new Date(Date.now() + 9 * 3600_000).getUTCDay();
  if (d === 0 || d === 6) return false;
  return hm >= "08:50" && hm <= "16:00";
}

function num(v: unknown): number {
  const x = Number(String(v ?? "").replace(/[+,\s]/g, ""));
  return Number.isFinite(x) ? x : 0;
}

/**
 * 오늘 줄을 한 점으로 찍는다 — **`stockSummary` 가 부른다.**
 *
 * 같은 분이면 **덮어쓴다.** 30초 폴링이라 한 분에 두 번 들어오는데, 두 점을 남기면
 * 톱니만 생긴다. 나중 값이 더 최신이므로 그쪽을 남긴다.
 */
export async function recordStockFlow(
  code: string,
  row: Record<string, unknown> | null,
): Promise<void> {
  if (!row || !inSession()) return;
  const st = await load();
  const list = (st.byCode[code] ??= []);
  const p: StockFlowPoint = {
    t: nowHm(),
    ind: num(row.ind_invsr),
    frgn: num(row.frgnr_invsr),
    orgn: num(row.orgn),
    etc: num(row.etc_corp),
    fnnc: num(row.fnnc_invt),
    invt: num(row.invtrt),
    penf: num(row.penfnd_etc),
    samo: num(row.samo_fund),
    insr: num(row.insrnc),
    bank: num(row.bank),
    etcf: num(row.etc_fnnc),
  };
  if (list.length > 0 && list[list.length - 1].t === p.t) list[list.length - 1] = p;
  else list.push(p);
  if (list.length > MAX_POINTS) list.splice(0, list.length - MAX_POINTS);
  dirty = true;
}

/** 이 종목의 오늘 곡선 — 없으면 빈 배열 */
export async function stockFlowToday(code: string): Promise<StockFlowPoint[]> {
  const st = await load();
  return st.byCode[code] ?? [];
}

/*
 * 파일 쓰기는 **모아서** 한다. 종목 화면이 30초마다 폴링하는데 그때마다 디스크에
 * 쓰면 아무 값어치 없이 I/O 만 는다. 1분에 한 번, 바뀐 것이 있을 때만.
 */
setInterval(() => {
  if (!dirty || !cache) return;
  dirty = false;
  void mkdir(dirname(FILE), { recursive: true })
    .then(() => writeFile(FILE, JSON.stringify(cache), "utf-8"))
    .catch(() => undefined);
}, 60_000).unref();
