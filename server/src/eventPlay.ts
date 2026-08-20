import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";
import { listThemes } from "./customThemes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(__dirname, "..", "data", "eventPlays.json");

/**
 * 일정 매매 — **일정을 보고 미리 들어가서, 일정 즈음에 나온다.**
 *
 * ## 이게 왜 따로 있어야 하나
 *
 * 신호등도 주도주 탐색기도 **「지금 무엇이 강한가」**를 본다. 그런데 실제로 돈을 번 방식은
 * 그게 아니었다 —
 *
 *   원전주  ← 두산에너빌리티 체코 수주
 *   조선주  ← 트럼프 한국 방한
 *
 * **일정이 먼저 있고, 거기 반응할 섹터를 미리 고른 것**이다. 이건 「오늘 강한 것」을
 * 훑어서는 안 나온다. 이미 오르고 나서 걸리기 때문이다.
 *
 * ## 성적을 재는 축이 다르다
 *
 * 다른 추적기는 **편입일 이후** 1·5·20·60일을 센다. 여기서는 그러면 안 된다.
 * 물어야 하는 건 이것이다 —
 *
 *   **「소문에 사서 뉴스에 판다」가 내 종목에도 맞나?**
 *
 * 그러려면 **일정일(D0)을 0으로 놓고 앞뒤를** 봐야 한다. D-20 부터 올라와서 D0 에
 * 꺾이는 모양이 나오면 그게 그 격언이 내 시장에서도 사실이라는 증거다.
 * 반대로 D0 이후에 더 오른다면 나는 **너무 일찍 팔고 있었다**는 뜻이다.
 *
 * 그래서 편입가 대신 **D-1 종가를 기준(100)** 으로 놓고 상대값을 낸다.
 * 「일정 직전에 샀다면」이 가장 흔한 실제 행동이라 그게 읽기 쉽다.
 */

/** 일정일을 0으로 놓은 거래일 오프셋 */
export const OFFSETS = [-20, -10, -5, -1, 0, 1, 5, 10] as const;
export type Offset = (typeof OFFSETS)[number];

export interface EventPlay {
  id: string;
  /** 일정일 (YYYY-MM-DD) */
  date: string;
  title: string;
  /** 왜 이 일정이 이 테마에 닿는가 — 나중에 읽을 사람은 나다 */
  note: string;
  /** 내 테마 id 들. 「원전」·「조선」처럼 내가 정한 묶음이어야 뜻이 있다 */
  themeIds: string[];
  /** 캘린더 일정에서 만들었으면 그 id */
  calendarId?: string;
  createdAt: string;
}

interface Store {
  plays: EventPlay[];
}

async function load(): Promise<Store> {
  try {
    const raw = JSON.parse(await readFile(FILE, "utf-8")) as Partial<Store>;
    return { plays: Array.isArray(raw.plays) ? raw.plays : [] };
  } catch {
    return { plays: [] };
  }
}

async function save(s: Store): Promise<void> {
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(s, null, 2), "utf-8");
}

export async function listPlays(): Promise<EventPlay[]> {
  return (await load()).plays.sort((a, b) => b.date.localeCompare(a.date));
}

export async function savePlay(input: Partial<EventPlay>): Promise<EventPlay[]> {
  const store = await load();
  const id = input.id || `ep_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const play: EventPlay = {
    id,
    date: String(input.date ?? "").slice(0, 10),
    title: String(input.title ?? "").trim(),
    note: String(input.note ?? "").trim(),
    themeIds: Array.isArray(input.themeIds) ? input.themeIds.map(String) : [],
    calendarId: input.calendarId ? String(input.calendarId) : undefined,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(play.date) || !play.title) {
    throw new Error("날짜와 제목이 필요합니다");
  }
  const i = store.plays.findIndex((p) => p.id === id);
  if (i >= 0) store.plays[i] = play;
  else store.plays.push(play);
  await save(store);
  return store.plays;
}

export async function removePlay(id: string): Promise<EventPlay[]> {
  const store = await load();
  store.plays = store.plays.filter((p) => p.id !== id);
  await save(store);
  return store.plays;
}

/* ------------------------------------------------------------------ */
/* 추적                                                                */
/* ------------------------------------------------------------------ */

async function dailyCloses(
  client: KiwoomClient,
  code: string,
): Promise<{ date: string; close: number }[]> {
  const d = new Date();
  const base = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const res = await client.request<Record<string, unknown>>("/api/dostk/chart", "ka10081", {
    stk_cd: code,
    base_dt: base,
    upd_stkpc_tp: "1",
  });
  const rows = (res.data?.stk_dt_pole_chart_qry ?? []) as Record<string, unknown>[];
  return rows
    .map((r) => ({
      date: String(r.dt ?? ""),
      close: Math.abs(Number(String(r.cur_prc ?? "").replace(/[+,]/g, ""))),
    }))
    .filter((r) => /^\d{8}$/.test(r.date) && r.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

export interface PlayPoint {
  offset: Offset;
  /** D-1 종가를 100 으로 놓은 상대값 */
  index: number;
  /** D-1 대비 (%) */
  rate: number;
}

export interface ThemeCurve {
  themeId: string;
  themeName: string;
  members: number;
  points: PlayPoint[];
  /** 일정 **전** 최고 상승 (D-20~D-1 중) */
  runUp: number | null;
  /** 일정 **후** 변화 (D0~D+10 중 마지막) */
  after: number | null;
  /**
   * 일정 당일이 고점이었나.
   *
   * **「소문에 사서 뉴스에 판다」가 내 종목에도 맞는지**를 가르는 값이다.
   * true 면 D0 이후로 더 못 올랐다는 뜻이라, 그날 팔았어야 했다.
   */
  peakedAtEvent: boolean | null;
}

export interface PlayResult extends EventPlay {
  themes: ThemeCurve[];
  /** 아직 일정이 안 지났으면 뒷쪽 점이 비어 있다 */
  upcoming: boolean;
  error?: string;
}

/**
 * 테마 하나의 곡선.
 *
 * **구성종목 단순평균**이다. 시총 가중이 아닌 이유는, 우리가 보려는 게
 * 「이 테마가 함께 움직였나」이지 「테마의 시가총액이 얼마나 늘었나」가 아니기 때문이다.
 * 대형주 하나가 묶음 전체를 대표하면 그건 테마가 아니라 그 종목 얘기다.
 */
function curve(
  charts: Map<string, { date: string; close: number }[]>,
  codes: string[],
  eventYmd: string,
): { points: PlayPoint[]; members: number } {
  const series: number[][] = [];
  for (const code of codes) {
    const rows = charts.get(code);
    if (!rows) continue;
    /*
     * 일정일 자리를 찾는다. 일정이 휴장일이면 **그 다음 거래일**을 D0 으로 본다 —
     * 발표가 주말이면 시장은 월요일에 반응하기 때문이다.
     */
    let d0 = rows.findIndex((r) => r.date >= eventYmd);
    if (d0 < 0) d0 = rows.length - 1;
    const baseIdx = d0 - 1;
    const base = rows[baseIdx]?.close;
    if (!base) continue;

    const vals: number[] = [];
    for (const off of OFFSETS) {
      const row = rows[baseIdx + 1 + off];
      vals.push(row ? (row.close / base) * 100 : NaN);
    }
    series.push(vals);
  }

  const points: PlayPoint[] = OFFSETS.map((off, i) => {
    const xs = series.map((s) => s[i]).filter((x) => Number.isFinite(x));
    const index = xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
    return { offset: off, index, rate: index - 100 };
  }).filter((p) => Number.isFinite(p.index));

  return { points, members: series.length };
}

export async function trackPlays(client: KiwoomClient): Promise<PlayResult[]> {
  const [plays, themes] = await Promise.all([listPlays(), listThemes()]);
  const byId = new Map(themes.map((t) => [t.id, t]));

  // 필요한 종목만 한 번씩 받는다 — 같은 테마가 여러 일정에 걸릴 수 있다
  const codes = new Set<string>();
  for (const p of plays) {
    for (const tid of p.themeIds) for (const c of byId.get(tid)?.codes ?? []) codes.add(c);
  }
  const charts = new Map<string, { date: string; close: number }[]>();
  for (const code of codes) {
    const rows = await dailyCloses(client, code).catch(() => []);
    if (rows.length > 0) charts.set(code, rows);
    // 키움은 TR 당 초당 5건 — 다른 스캐너와 같은 간격
    await new Promise((r) => setTimeout(r, 260));
  }

  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  return plays.map((p) => {
    const eventYmd = p.date.replace(/-/g, "");
    const curves: ThemeCurve[] = [];
    for (const tid of p.themeIds) {
      const t = byId.get(tid);
      if (!t) continue;
      const { points, members } = curve(charts, t.codes, eventYmd);
      const before = points.filter((x) => x.offset < 0).map((x) => x.rate);
      const afterPts = points.filter((x) => x.offset >= 0);
      const atEvent = points.find((x) => x.offset === 0)?.rate ?? null;
      const maxAfter = afterPts.length > 0 ? Math.max(...afterPts.map((x) => x.rate)) : null;
      curves.push({
        themeId: tid,
        themeName: t.name,
        members,
        points,
        runUp: before.length > 0 ? Math.max(...before) : null,
        after: afterPts.length > 0 ? afterPts[afterPts.length - 1].rate : null,
        // 일정 당일이 그 뒤 구간의 고점이었나 — 그날 팔았어야 했다는 뜻
        peakedAtEvent:
          atEvent !== null && maxAfter !== null ? Math.abs(maxAfter - atEvent) < 0.01 : null,
      });
    }
    return { ...p, themes: curves, upcoming: p.date > today };
  });
}
