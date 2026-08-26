import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";
import { getMarketSnapshot } from "./marketSnapshot.js";
import { evaluateMarket } from "./marketSignal.js";
import { getSectorMood } from "./sectorMood.js";
import { evaluateSignal } from "./signalLight.js";
import { fetchUniverse, SCREEN_UNIVERSES, type Candidate } from "./signalScreen.js";
import {
  hasDedicatedChannel,
  isTelegramConfigured,
  sendTelegram,
  stockNameHtml,
  type TelegramChannel,
} from "./telegram.js";
import {
  ensureInGroup,
  listWatchlist,
  removeWatchItem,
  SUPER_GROUP,
  updateWatchItem,
} from "./watchlist.js";

/**
 * 슈퍼신호등 — **여러 목록에 동시에 걸린 초록** (2026-08-25).
 *
 * 신호등 찾기의 모집단이 일곱 가지가 되면서 자연스러운 다음 물음이 생겼다:
 * 「거래대금도 몰리고, 등락률도 상위고, 외국인도 연속으로 사는 종목」 — 목록
 * **하나**에 걸린 초록보다 **여럿**에 걸린 초록이 진짜 아닐까. 그 교집합을
 * 매일 장 마감 뒤 자동으로 뽑아 며칠이고 따라가 보는 자리다. 추적기의 상위판이다.
 *
 * ## 규칙
 *
 *   모집단   일곱 목록 전부, 각 300개 기준 (짧은 목록은 주는 만큼 — ka10062 등은
 *            100건 안팎이 상한이다. 그건 그 목록의 사정이지 우리가 부풀릴 일이 아니다)
 *   교집합   **3개 목록 이상**에 등장. 7개 전부는 사실상 공집합이고, 2개는 거래대금·
 *            등락률처럼 서로 붙어 다니는 짝이 많아 흔하다. 셋부터 이야기가 된다
 *   문턱     신호등 **초록**만. 슈퍼라는 말에 노랑이 섞이면 이름이 거짓말이 된다
 *   시각     평일 15:45 — 추적기(15:40)가 같은 종목들의 신호등을 먼저 평가해
 *            15분 캐시를 데워 두므로, 5분 뒤에 돌면 대부분 캐시로 끝난다
 *
 * ## 무엇을 기록하나
 *
 * 편입일·편입가(그날 종가)·걸린 목록들·점수. 그리고 **며칠째 다시 걸리는지**
 * (`seenCount`) — 하루 반짝 교집합과 사흘째 계속 걸리는 종목은 다른 이야기다.
 * 수익률은 화면에서 지금 스냅샷과 견줘 계산한다(편입가 대비) — 추적기처럼
 * 지평별(1/5/20일) 통계까지는 표본이 쌓인 뒤의 일이다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const FILE = join(here, "..", "data", "superSignal.json");

/** 교집합 문턱 — 몇 개 목록에 걸려야 「슈퍼」인가 */
const MIN_LISTS = 3;
/** 하루에 평가할 교집합 상한 — 종목당 조회 여러 번이라 폭주를 막는다 */
const MAX_EVAL = 40;

/**
 * 하루 한 줄 — 편입 후 이 종목이 **어떻게 흘러갔는지**의 원장 (2026-08-26).
 * 점수는 과거로 되짚어 잴 수 없으므로(신호등은 그날 데이터로만 평가된다)
 * 매일 장 마감 뒤 적어 두는 이 기록이 점수 흐름의 유일한 소스다.
 */
export interface SuperDaily {
  date: string;
  close: number;
  score: number;
  level: string;
}

/** 이탈 기록 — 언제·얼마에·몇 점으로 떨어졌고, 그날 시장은 어땠나 */
export interface SuperExit {
  date: string;
  price: number | null;
  score: number | null;
  /** 이탈 시점의 시장 신호등 — 「내가 죽었나, 장이 죽었나」를 가른다 */
  marketLevel: string | null;
  marketScore: number | null;
  note: string;
  /** true = 신호등이 초록에서 떨어져 자동 이탈, false = 손으로 이탈 처리 */
  auto: boolean;
}

export interface SuperEntry {
  code: string;
  name: string;
  /** 편입일 (YYYY-MM-DD) */
  addedDate: string;
  /** 편입일 가격 — 그날 모집단 조회가 준 값 */
  addedPrice: number;
  /** 편입 당시 신호등 점수 */
  score: number;
  /** 걸린 목록 (SCREEN_UNIVERSES key) — 마지막으로 걸린 날 기준 */
  lists: string[];
  /** 며칠째 교집합에 걸렸나 — 지속성이 곧 신호다 */
  seenCount: number;
  lastSeenDate: string;
  /**
   * 편입 후 N거래일 뒤 종가의 편입가 대비 (%) — 채점의 재료 (2026-08-25).
   * 봉이 아직 안 쌓였으면 null. d20 까지 차면 더 안 잰다(끝난 성적표다).
   */
  returns?: { d1: number | null; d5: number | null; d20: number | null };
  /** 추적 중인가 — 이탈하면 false. 교집합에 다시 걸리면 되살아난다 */
  active?: boolean;
  /** 편입 후 일별 기록 (종가·점수) — 대시보드의 점수/주가 흐름이 이걸 읽는다 */
  daily?: SuperDaily[];
  /** 이탈 이력 — 재편입돼도 지우지 않는다. 이탈→복귀 자체가 정보다 */
  exits?: SuperExit[];
  /** 자유 메모 — 복기용 */
  note?: string;
}

interface Store {
  entries: SuperEntry[];
  lastRunDate: string | null;
}

const EMPTY: Store = { entries: [], lastRunDate: null };

async function load(): Promise<Store> {
  try {
    const raw = JSON.parse(await readFile(FILE, "utf-8")) as Partial<Store>;
    const entries = (Array.isArray(raw.entries) ? raw.entries : []).map((e) => ({
      ...e,
      // 대시보드 필드가 생기기 전(2026-08-26 이전) 저장분 — 전부 추적 중으로 본다
      active: e.active !== false,
      daily: Array.isArray(e.daily) ? e.daily : [],
      exits: Array.isArray(e.exits) ? e.exits : [],
    }));
    return {
      entries,
      lastRunDate: typeof raw.lastRunDate === "string" ? raw.lastRunDate : null,
    };
  } catch {
    return { ...EMPTY };
  }
}

async function save(s: Store): Promise<void> {
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(s, null, 2), "utf-8");
}

function todayStr(d = new Date()): string {
  const k = new Date(d.getTime() + 9 * 3600_000);
  return k.toISOString().slice(0, 10);
}

/**
 * 편입 후 성적 매기기 — 매일 실행 끝에 돌린다.
 *
 * 종목당 일봉 한 번(ka10081)으로 편입일 이후 1/5/20거래일 종가를 찾아
 * 편입가 대비 %를 적어 둔다. d20 까지 찬 종목은 성적표가 끝났으니 다시
 * 조회하지 않는다 — 그래서 호출량은 「아직 성적이 진행 중인 종목 수」만큼이다.
 */
async function gradeEntries(client: KiwoomClient, store: Store): Promise<number> {
  const pending = store.entries.filter((e) => e.returns?.d20 == null && e.addedPrice > 0);
  let graded = 0;
  for (const e of pending) {
    try {
      const d = new Date(Date.now() + 9 * 3600_000);
      const base = d.toISOString().slice(0, 10).replace(/-/g, "");
      const res = await client.request<Record<string, unknown>>("/api/dostk/chart", "ka10081", {
        stk_cd: e.code,
        base_dt: base,
        upd_stkpc_tp: "1",
      });
      const rows = ((res.data?.stk_dt_pole_chart_qry ?? []) as Record<string, unknown>[])
        .map((r) => ({
          date: String(r.dt ?? ""),
          close: Math.abs(Number(String(r.cur_prc ?? "").replace(/[+,]/g, ""))),
        }))
        .filter((r) => /^\d{8}$/.test(r.date) && r.close > 0)
        .sort((a, b) => a.date.localeCompare(b.date));
      const addedYmd = e.addedDate.replace(/-/g, "");
      const idx = rows.findIndex((r) => r.date === addedYmd);
      if (idx < 0) continue; // 편입일 봉이 아직 없다(장중 실행 등) — 다음에
      const pct = (n: number): number | null => {
        const bar = rows[idx + n];
        return bar ? ((bar.close - e.addedPrice) / e.addedPrice) * 100 : null;
      };
      e.returns = { d1: pct(1), d5: pct(5), d20: pct(20) };
      graded += 1;
    } catch {
      /* 한 종목 실패는 넘어간다 — 다음 실행에 다시 잰다 */
    }
    await new Promise((r) => setTimeout(r, 260));
  }
  return graded;
}

/**
 * 일별 기록 + 자동 이탈 판정 (2026-08-26) — 매일 실행 끝에 돈다.
 *
 * 추적 중(active) 종목마다 오늘의 종가·신호등 점수를 한 줄 적는다. 점수는
 * 과거로 못 되짚으므로 이 기록이 곧 「편입 후 점수가 어떻게 흘러갔나」다.
 *
 * ## 자동 이탈
 *
 * 슈퍼신호등의 정의가 「초록」이므로, 초록에서 떨어진 게 이탈이다. 다만 노랑을
 * 하루 스치고 돌아오는 종목이 흔해서 **이틀 연속** 초록 미만일 때만 이탈로 적는다.
 * 이탈 시점의 시장 신호등을 같이 적는다 — 종목이 죽은 건지 장이 꺾인 건지는
 * 나중에 복기할 때 가장 먼저 묻게 되는 것이다.
 *
 * 조회 비용: 15:45 실행 직전에 추적기·교집합 평가가 신호등 캐시(15분)를 데워
 * 두므로 대부분 캐시로 끝난다. 그래도 상한(60종목)을 둔다.
 */
async function recordSuperDaily(client: KiwoomClient, store: Store): Promise<SuperEntry[]> {
  const today = todayStr();
  const exited: SuperEntry[] = [];
  const active = store.entries.filter((e) => e.active !== false).slice(0, 60);
  if (active.length === 0) return exited;

  const snap = await getMarketSnapshot(client).catch(() => null);
  /* 시장 신호등은 이탈이 실제로 생겼을 때 한 번만 받는다 */
  let market: { level: string; score: number } | null | undefined;

  for (const e of active) {
    try {
      const sig = await evaluateSignal(client, e.code);
      const close = snap?.byCode.get(e.code)?.price ?? 0;
      const daily = (e.daily ??= []);
      const row: SuperDaily = { date: today, close, score: sig.score, level: sig.level };
      const last = daily[daily.length - 1];
      if (last?.date === today) daily[daily.length - 1] = row;
      else daily.push(row);
      if (daily.length > 120) daily.splice(0, daily.length - 120); // 넉 달이면 충분하다

      // 이틀 연속 초록 미만 → 자동 이탈
      const n = daily.length;
      if (n >= 2 && daily[n - 1].level !== "green" && daily[n - 2].level !== "green") {
        if (market === undefined) {
          market = await evaluateMarket(client)
            .then((m) => ({ level: m.level, score: m.score }))
            .catch(() => null);
        }
        e.active = false;
        (e.exits ??= []).push({
          date: today,
          price: close > 0 ? close : null,
          score: sig.score,
          marketLevel: market?.level ?? null,
          marketScore: market?.score ?? null,
          note: "신호등 초록 이탈 (이틀 연속)",
          auto: true,
        });
        exited.push(e);
      }
    } catch {
      /* 한 종목 실패는 다음 날 다시 */
    }
    await new Promise((r) => setTimeout(r, 220));
  }
  return exited;
}

// ---------------------------------------------------------------- 텔레그램 (전용 방)

/**
 * 슈퍼신호등 전용 방 (2026-08-26).
 *
 * `.env` 에 `TELEGRAM_CHAT_ID_SUPER` 를 넣으면 그 방이 **슈퍼 종목의 이벤트 허브**가
 * 된다 — 편입·이탈은 여기서 직접 보내고, 시그널·공시·키워드 알림은 각자의 발송
 * 지점이 `superRoute()` 로 물어서 슈퍼 종목 건만 이 방으로 돌린다.
 * 전용 방이 없으면 아무것도 안 바뀐다 — 전부 원래 갈래로 간다.
 */

/** 추적 중인 슈퍼 종목 — 라우팅용. 발송 지점들이 1분마다 물어봐서 캐시를 둔다 */
let activeCache: { at: number; list: { code: string; name: string }[] } | null = null;

export async function getActiveSuper(): Promise<{ code: string; name: string }[]> {
  if (activeCache && Date.now() - activeCache.at < 60_000) return activeCache.list;
  const store = await load();
  const list = store.entries
    .filter((e) => e.active !== false)
    .map((e) => ({ code: e.code, name: e.name }));
  activeCache = { at: Date.now(), list };
  return list;
}

/**
 * 이 종목의 알림을 어느 방으로 보낼까 — 슈퍼 전용 방이 있고 슈퍼 종목이면 "super",
 * 아니면 원래 갈래. 발송 지점이 한 줄로 쓰라고 만든 헬퍼다.
 */
export async function superRoute(
  code: string,
  fallback: TelegramChannel,
): Promise<TelegramChannel> {
  if (!hasDedicatedChannel("super")) return fallback;
  const list = await getActiveSuper().catch(() => [] as { code: string }[]);
  return list.some((s) => s.code === code) ? "super" : fallback;
}

const UNIVERSE_LABEL = new Map(SCREEN_UNIVERSES.map((u) => [u.key, u.label]));

function fmtWon(n: number): string {
  return Math.round(n).toLocaleString("ko-KR");
}

/** 편입·부활·이탈을 한 통으로 — 하루 한 번 15:45 실행이 보낸다 */
function formatSuperRun(
  added: SuperEntry[],
  revived: SuperEntry[],
  exited: SuperEntry[],
): string {
  const parts: string[] = [];
  const listNames = (e: SuperEntry) =>
    e.lists.map((k) => UNIVERSE_LABEL.get(k) ?? k).join(" · ");

  if (added.length > 0) {
    parts.push(
      `🌟 <b>슈퍼신호등 편입 ${added.length}건</b>\n` +
        added
          .map(
            (e) =>
              `• ${stockNameHtml(e.code, e.name)}  ${fmtWon(e.addedPrice)}  ${e.score}점\n` +
              `  목록 ${e.lists.length}곳 — ${listNames(e)}`,
          )
          .join("\n"),
    );
  }
  if (revived.length > 0) {
    parts.push(
      `♻️ <b>다시 걸림 ${revived.length}건</b> (이탈했다가 교집합 복귀)\n` +
        revived
          .map((e) => `• ${stockNameHtml(e.code, e.name)} — ${e.seenCount}일째 · 목록 ${e.lists.length}곳`)
          .join("\n"),
    );
  }
  if (exited.length > 0) {
    parts.push(
      `⛔ <b>이탈 ${exited.length}건</b> (신호등 초록에서 이틀 연속 미달)\n` +
        exited
          .map((e) => {
            const ex = e.exits?.[e.exits.length - 1];
            const ret =
              ex?.price && e.addedPrice > 0
                ? ` · 편입 대비 ${(((ex.price - e.addedPrice) / e.addedPrice) * 100).toFixed(1)}%`
                : "";
            const mkt = ex?.marketLevel ? ` · 시장 ${ex.marketLevel} ${ex.marketScore ?? ""}점` : "";
            return `• ${stockNameHtml(e.code, e.name)} — ${e.addedDate} 편입${ret}${mkt}`;
          })
          .join("\n"),
    );
  }
  return parts.join("\n\n");
}

async function notifySuperRun(
  added: SuperEntry[],
  revived: SuperEntry[],
  exited: SuperEntry[],
): Promise<void> {
  if (added.length + revived.length + exited.length === 0) return;
  /* 전용 방이 있으면 거기로, 없으면 시그널 방으로 — 어쨌든 이 소식은 봐야 한다 */
  const ch: TelegramChannel = hasDedicatedChannel("super") ? "super" : "signal";
  if (!isTelegramConfigured(ch)) return;
  await sendTelegram(formatSuperRun(added, revived, exited), ch).catch(() => undefined);
}

/** 진행 상황 — 화면 진행바용. 하나만 돈다 */
export interface SuperJob {
  status: "idle" | "running" | "done" | "error";
  /** 지금 무엇을 하고 있나 */
  step: string;
  done: number;
  total: number;
  /** 이번 실행에서 새로 담은 수 */
  added: number;
  error?: string;
  at: string;
}

let job: SuperJob = { status: "idle", step: "", done: 0, total: 0, added: 0, at: "" };

export function superJob(): SuperJob {
  return job;
}

/**
 * 교집합을 뽑아 담는다. 하루 한 번이 원칙이지만 `force` 로 다시 돌 수 있다
 * (그날 이미 담은 종목은 중복으로 안 담기므로 다시 돌아도 해가 없다).
 */
export async function runSuperSignal(client: KiwoomClient, force = false): Promise<Store> {
  const store = await load();
  const today = todayStr();
  if (!force && store.lastRunDate === today) return store;
  if (job.status === "running") return store;

  job = { status: "running", step: "목록 받는 중", done: 0, total: SCREEN_UNIVERSES.length, added: 0, at: new Date().toISOString() };

  try {
    /*
     * 일곱 목록을 **차례로** 받는다. 병렬로 쏘면 초당 5회 제한에 걸린다.
     * 각 목록 안의 연속조회 간격은 fetchUniverse 가 이미 지킨다.
     */
    const byCode = new Map<string, { c: Candidate; lists: string[] }>();
    for (const u of SCREEN_UNIVERSES) {
      job.step = `${u.label} 받는 중`;
      const rows = await fetchUniverse(client, u.key, "000", 300).catch(() => [] as Candidate[]);
      for (const c of rows) {
        const hit = byCode.get(c.code);
        if (hit) {
          hit.lists.push(u.key);
          // 가격은 값이 있는 쪽을 남긴다 (몇 목록은 현재가를 안 준다)
          if (hit.c.price === 0 && c.price > 0) hit.c = c;
        } else {
          byCode.set(c.code, { c, lists: [u.key] });
        }
      }
      job.done += 1;
      await new Promise((r) => setTimeout(r, 400));
    }

    const inter = [...byCode.values()]
      .filter((x) => x.lists.length >= MIN_LISTS)
      .sort((a, b) => b.lists.length - a.lists.length)
      .slice(0, MAX_EVAL);

    job.step = "신호등 평가 중";
    job.total = inter.length;
    job.done = 0;

    const have = new Map(store.entries.map((e) => [e.code, e]));
    let added = 0;
    /* 텔레그램에 보낼 것들 — 신규 편입과, 이탈했다 다시 걸린 부활 */
    const addedEntries: SuperEntry[] = [];
    const revivedEntries: SuperEntry[] = [];
    for (const x of inter) {
      try {
        const sig = await evaluateSignal(client, x.c.code);
        if (sig.level === "green") {
          const prev = have.get(x.c.code);
          if (prev) {
            // 이미 추적 중 — 오늘 또 걸렸다는 사실이 정보다
            if (prev.lastSeenDate !== today) prev.seenCount += 1;
            prev.lastSeenDate = today;
            prev.lists = x.lists;
            // 이탈했던 종목이 다시 걸렸다 — 되살린다. 이탈 이력은 그대로 남는다
            if (prev.active === false) revivedEntries.push(prev);
            prev.active = true;
            // 그룹에서 빠져 있으면 다시 담는다(기능 추가 전 편입분도 이 길로 들어온다)
            await ensureInGroup(
              { code: prev.code, name: prev.name, addedPrice: prev.addedPrice },
              SUPER_GROUP,
            ).catch(() => undefined);
          } else {
            const entry: SuperEntry = {
              code: x.c.code,
              name: x.c.name,
              addedDate: today,
              addedPrice: x.c.price,
              score: sig.score,
              lists: x.lists,
              seenCount: 1,
              lastSeenDate: today,
            };
            store.entries.push(entry);
            have.set(entry.code, entry);
            added += 1;
            addedEntries.push(entry);
            /*
             * 관심종목 「슈퍼신호등」 그룹에도 담는다 (사용자 요청) — 관심종목이
             * 실시간·손절감시·뉴스 검색의 축이라, 거기 있어야 나머지가 따라붙는다.
             * 이미 다른 그룹에 담긴 종목이면 그룹만 더한다(편입가·메모는 그대로).
             */
            await ensureInGroup(
              {
                code: entry.code,
                name: entry.name,
                addedPrice: entry.addedPrice,
                memo: `슈퍼신호등 자동 편입 (${today} · 목록 ${entry.lists.length}곳 · ${entry.score}점)`,
              },
              SUPER_GROUP,
            ).catch(() => undefined);
          }
        }
      } catch {
        /* 한 종목 실패가 전체를 막지 않게 */
      }
      job.done += 1;
      job.added = added;
      await new Promise((r) => setTimeout(r, 260));
    }

    // 오래된 것부터 정리 — 관찰 목록이지 박물관이 아니다
    store.entries.sort((a, b) => b.addedDate.localeCompare(a.addedDate));
    store.entries = store.entries.slice(0, 200);

    // 편입 후 성적 채점 — 어제까지 담은 종목들의 1/5/20일 수익률을 갱신
    job.step = "성과 채점 중";
    await gradeEntries(client, store).catch(() => undefined);

    // 오늘의 종가·점수를 원장에 한 줄 — 대시보드의 흐름 그래프가 이걸 먹는다
    job.step = "일별 기록 중";
    const exitedEntries = await recordSuperDaily(client, store).catch(() => [] as SuperEntry[]);

    // 편입·부활·이탈을 전용 방으로 (없으면 시그널 방)
    activeCache = null; // 오늘 결과가 라우팅에 바로 반영되게
    await notifySuperRun(addedEntries, revivedEntries, exitedEntries).catch(() => undefined);

    store.lastRunDate = today;
    await save(store);
    job = { ...job, status: "done", step: "완료" };
  } catch (err) {
    job = { ...job, status: "error", error: err instanceof Error ? err.message : "실패" };
  }
  return store;
}

/** 그룹 하나의 지평별 평균 — avg 는 표본 0이면 null */
export interface GradeRow {
  label: string;
  d1: { avg: number | null; n: number };
  d5: { avg: number | null; n: number };
  d20: { avg: number | null; n: number };
}

function gradeRow(label: string, entries: SuperEntry[]): GradeRow {
  const agg = (pick: (r: NonNullable<SuperEntry["returns"]>) => number | null) => {
    const vals = entries
      .map((e) => (e.returns ? pick(e.returns) : null))
      .filter((v): v is number => v !== null);
    return {
      avg: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null,
      n: vals.length,
    };
  };
  return { label, d1: agg((r) => r.d1), d5: agg((r) => r.d5), d20: agg((r) => r.d20) };
}

/** 지평 하나의 승률 — 「편입하고 N일 뒤 플러스였나」 */
function winRate(entries: SuperEntry[], pick: (r: NonNullable<SuperEntry["returns"]>) => number | null) {
  const vals = entries
    .map((e) => (e.returns ? pick(e.returns) : null))
    .filter((v): v is number => v !== null);
  return {
    rate: vals.length ? (vals.filter((v) => v > 0).length / vals.length) * 100 : null,
    n: vals.length,
  };
}

/** 대시보드 요약 통계 — 체계 자체를 검증하는 숫자들 */
export interface SuperStats {
  activeCount: number;
  exitedCount: number;
  todayAdded: number;
  win: {
    d1: { rate: number | null; n: number };
    d5: { rate: number | null; n: number };
    d20: { rate: number | null; n: number };
  };
  best: { name: string; v: number } | null;
  worst: { name: string; v: number } | null;
}

/** 화면용 — 지금 가격을 스냅샷에서 붙여 편입가 대비를 낸다 */
export async function listSuperSignal(client: KiwoomClient): Promise<{
  entries: (SuperEntry & { price: number | null; changeRate: number | null; sinceAdded: number | null })[];
  lastRunDate: string | null;
  minLists: number;
  grade: GradeRow[];
  stats: SuperStats;
}> {
  const store = await load();
  const snap = await getMarketSnapshot(client).catch(() => null);
  const entries = store.entries.map((e) => {
    const s = snap?.byCode.get(e.code);
    const price = s?.price ?? null;
    return {
      ...e,
      price,
      changeRate: s?.changeRate ?? null,
      sinceAdded:
        price !== null && e.addedPrice > 0 ? ((price - e.addedPrice) / e.addedPrice) * 100 : null,
    };
  });
  /*
   * 채점 요약 — 「교집합이 넓을수록·오래 걸릴수록 진짜인가」에 답하는 표.
   * 표본이 몇 건 안 될 때는 화면이 n 을 함께 보여 주므로 여기서 숨기지 않는다.
   */
  const grade = [
    gradeRow("전체", store.entries),
    gradeRow("목록 4곳 이상", store.entries.filter((e) => e.lists.length >= 4)),
    gradeRow("이틀 이상 반복", store.entries.filter((e) => e.seenCount >= 2)),
  ];

  const today = todayStr();
  const d20s = store.entries
    .map((e) => ({ name: e.name, v: e.returns?.d20 ?? null }))
    .filter((x): x is { name: string; v: number } => x.v !== null);
  const stats: SuperStats = {
    activeCount: store.entries.filter((e) => e.active !== false).length,
    exitedCount: store.entries.filter((e) => e.active === false).length,
    todayAdded: store.entries.filter((e) => e.addedDate === today).length,
    win: {
      d1: winRate(store.entries, (r) => r.d1),
      d5: winRate(store.entries, (r) => r.d5),
      d20: winRate(store.entries, (r) => r.d20),
    },
    best: d20s.length ? d20s.reduce((a, b) => (b.v > a.v ? b : a)) : null,
    worst: d20s.length ? d20s.reduce((a, b) => (b.v < a.v ? b : a)) : null,
  };
  return { entries, lastRunDate: store.lastRunDate, minLists: MIN_LISTS, grade, stats };
}

/** 수동 이탈 — 기록을 남기고 추적만 멈춘다. 목록에서 지우지 않는다 */
export async function exitSuperEntry(
  client: KiwoomClient,
  code: string,
  note: string,
): Promise<SuperEntry | null> {
  const store = await load();
  const e = store.entries.find((x) => x.code === code);
  if (!e) return null;
  const snap = await getMarketSnapshot(client).catch(() => null);
  const market = await evaluateMarket(client)
    .then((m) => ({ level: m.level, score: m.score }))
    .catch(() => null);
  const sig = await evaluateSignal(client, code).catch(() => null);
  e.active = false;
  (e.exits ??= []).push({
    date: todayStr(),
    price: snap?.byCode.get(code)?.price ?? null,
    score: sig?.score ?? null,
    marketLevel: market?.level ?? null,
    marketScore: market?.score ?? null,
    note: note.trim() || "수동 이탈",
    auto: false,
  });
  await save(store);
  activeCache = null;
  await notifySuperRun([], [], [e]).catch(() => undefined);
  return e;
}

/** 자유 메모 수정 */
export async function updateSuperNote(code: string, note: string): Promise<boolean> {
  const store = await load();
  const e = store.entries.find((x) => x.code === code);
  if (!e) return false;
  e.note = note.trim();
  await save(store);
  return true;
}

// ---------------------------------------------------------------- 상세 (온디맨드)

interface DailyPoint {
  date: string;
  close: number;
}

const CHART_RESOURCE = "/api/dostk/chart";

function toNum2(v: unknown): number {
  const n = Number(String(v ?? "").replace(/[+,]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** 종목 일봉 — 옛날→최신 순 {date, close} */
async function stockDailySeries(client: KiwoomClient, code: string): Promise<DailyPoint[]> {
  const base = todayStr().replace(/-/g, "");
  const res = await client.request<Record<string, unknown>>(CHART_RESOURCE, "ka10081", {
    stk_cd: code,
    base_dt: base,
    upd_stkpc_tp: "1",
  });
  return ((res.data?.stk_dt_pole_chart_qry ?? []) as Record<string, unknown>[])
    .map((r) => ({ date: String(r.dt ?? ""), close: Math.abs(toNum2(r.cur_prc)) }))
    .filter((r) => /^\d{8}$/.test(r.date) && r.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** 업종/지수 일봉(ka20006) — 옛날→최신 순. 값이 지수×100 이지만 비율만 쓰므로 그대로 */
async function indexDailySeries(client: KiwoomClient, indsCode: string): Promise<DailyPoint[]> {
  const base = todayStr().replace(/-/g, "");
  const res = await client.request<Record<string, unknown>>(CHART_RESOURCE, "ka20006", {
    inds_cd: indsCode,
    base_dt: base,
  });
  return ((res.data?.inds_dt_pole_qry ?? []) as Record<string, unknown>[])
    .map((r) => ({ date: String(r.dt ?? ""), close: Math.abs(toNum2(r.cur_prc)) }))
    .filter((r) => /^\d{8}$/.test(r.date) && r.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** 일별 외인/기관 순매수 (ka10060) — 옛날→최신 순 */
async function investorDailySeries(
  client: KiwoomClient,
  code: string,
): Promise<{ date: string; foreign: number; inst: number }[]> {
  const base = todayStr().replace(/-/g, "");
  const res = await client.request<Record<string, unknown>>(CHART_RESOURCE, "ka10060", {
    stk_cd: code,
    dt: base,
    amt_qty_tp: "1", // 금액
    trde_tp: "0",
    unit_tp: "1000",
  });
  return ((res.data?.stk_invsr_orgn_chart ?? []) as Record<string, unknown>[])
    .map((r) => ({
      date: String(r.dt ?? ""),
      foreign: toNum2(r.frgnr_invsr),
      inst: toNum2(r.orgn),
    }))
    .filter((r) => /^\d{8}$/.test(r.date))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 종목 하나의 대시보드 상세 — 클릭했을 때만 부른다 (조회 4콜 안팎).
 *
 * 편입일 20거래일 전부터의 주가·지수·업종 시리즈와 일별 수급을 준다.
 * 상대 비교(편입일=0% 정규화)는 화면이 한다 — 서버는 원자료만.
 */
export async function superDetail(client: KiwoomClient, code: string) {
  const store = await load();
  const entry = store.entries.find((e) => e.code === code);
  if (!entry) return null;

  const [stock, flows, mood, sig, market] = await Promise.all([
    stockDailySeries(client, code).catch(() => [] as DailyPoint[]),
    investorDailySeries(client, code).catch(() => [] as { date: string; foreign: number; inst: number }[]),
    getSectorMood(client, code).catch(() => null),
    evaluateSignal(client, code).catch(() => null),
    evaluateMarket(client).catch(() => null),
  ]);

  /* 지수 — 업종 매칭이 알려 준 시장, 못 찾으면 코스피 */
  const marketIdx = mood?.sector?.marketKey === "kosdaq" ? "101" : "001";
  const [indexSeries, sectorSeries] = await Promise.all([
    indexDailySeries(client, marketIdx).catch(() => [] as DailyPoint[]),
    mood?.sector?.code
      ? indexDailySeries(client, mood.sector.code).catch(() => [] as DailyPoint[])
      : Promise.resolve([] as DailyPoint[]),
  ]);

  /* 편입일 20거래일 전부터만 — 그 앞은 이 화면의 물음이 아니다 */
  const addedYmd = entry.addedDate.replace(/-/g, "");
  const cut = (rows: DailyPoint[]): DailyPoint[] => {
    const i = rows.findIndex((r) => r.date >= addedYmd);
    return i < 0 ? rows.slice(-1) : rows.slice(Math.max(0, i - 20));
  };

  return {
    entry,
    stock: cut(stock),
    index: { code: marketIdx, name: marketIdx === "101" ? "코스닥" : "코스피", series: cut(indexSeries) },
    sector: mood?.sector
      ? { code: mood.sector.code, name: mood.sector.name, changeRate: mood.sector.changeRate, series: cut(sectorSeries) }
      : null,
    flows: (() => {
      const i = flows.findIndex((r) => r.date >= addedYmd);
      return i < 0 ? [] : flows.slice(Math.max(0, i - 20));
    })(),
    signalNow: sig ? { level: sig.level, score: sig.score } : null,
    marketNow: market ? { level: market.level, score: market.score, summary: market.summary } : null,
  };
}

export async function removeSuperEntry(code: string): Promise<void> {
  const store = await load();
  store.entries = store.entries.filter((e) => e.code !== code);
  await save(store);

  /*
   * 관심종목 쪽도 정리한다 — 슈퍼신호등 그룹에만 있던 종목이면 통째로 빼고,
   * 다른 그룹에도 담겨 있으면 슈퍼신호등 그룹만 뗀다(사람이 담은 건 사람 것이다).
   */
  try {
    const items = await listWatchlist();
    const w = items.find((i) => i.code === code);
    if (!w) return;
    if (w.groups.length === 1 && w.groups[0] === SUPER_GROUP) {
      await removeWatchItem(code);
    } else if (w.groups.includes(SUPER_GROUP)) {
      await updateWatchItem(code, { groups: w.groups.filter((g) => g !== SUPER_GROUP) });
    }
  } catch {
    /* 관심종목 정리는 부수 작업 — 실패해도 슈퍼 목록에서는 빠졌다 */
  }
}

/**
 * 평일 15:45 에 알아서 돈다 — 추적기(15:40)가 신호등 캐시를 데운 5분 뒤.
 * 그 시각을 지나 서버를 켠 날도 그날 안이면 한 번 돈다 (lastRunDate 가 막는다).
 */
export function startSuperSignalScheduler(client: KiwoomClient): void {
  const tick = async () => {
    const now = new Date();
    const k = new Date(now.getTime() + 9 * 3600_000);
    const day = k.getUTCDay();
    if (day === 0 || day === 6) return;
    const mins = k.getUTCHours() * 60 + k.getUTCMinutes();
    if (mins < 15 * 60 + 45 || mins > 23 * 60) return;
    await runSuperSignal(client).catch(() => undefined);
  };
  void tick();
  setInterval(() => void tick(), 60_000);
  console.log("[superSignal] 슈퍼신호등 시작 — 평일 15:45 교집합 편입");
}
