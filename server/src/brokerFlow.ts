import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";
import { noteFxFids } from "./fxFidProbe.js";
import { alCode } from "./alCode.js";
import { loadLedger } from "./dailyStore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(__dirname, "..", "data", "brokerFlow.json");

/**
 * 거래원(증권사 창구) — **누가 사고 누가 파나.**
 *
 * ## 시간대별은 키움이 안 준다. 우리가 쌓아야 한다
 *
 * `ka10040`(당일주요거래원)은 **지금까지의 누적**과 **직전 조회 대비 증감**만 준다.
 * 창구별 시간대별 매매를 주는 TR 을 찾지 못했다(`ka10039` 는 어느 URI 에도 없었다).
 *
 * 그래서 **주기적으로 찍어 쌓는다.** 투자자 수급(`marketOverview` 의 `recordFlow`)이
 * 같은 이유로 같은 방식을 쓴다 — 「누적만 주므로 시계열은 이렇게밖에 못 만든다」.
 *
 * ⚠️ **한계를 분명히 해 둔다.** 보고 있는 동안만 쌓인다. 화면을 안 열어 둔 시간은
 * 빈다. 그래서 「09:00부터의 완전한 흐름」이 아니라 **「내가 본 구간의 흐름」**이다.
 * 화면에도 그렇게 적는다.
 *
 * ## `irds` 가 이 TR 의 값어치다
 *
 * 누적 수량만 보면 아침에 크게 산 창구가 하루 종일 1위로 남는다. `irds`(증감)는
 * **지금 붙고 있는 창구**를 알려준다 — 누적 1위가 손 놓고 있고 3위가 계속 담는 날이 있다.
 */

const RKINFO = "/api/dostk/rkinfo";

/** 외국계 창구 — 이름에 이게 들어가면 외국계로 본다 */
const FOREIGN_HINTS = [
  "모건", "모간", "골드만", "메릴", "씨티", "제이피", "JP", "노무라", "다이와",
  "맥쿼리", "UBS", "CS", "홍콩", "HSBC", "BNP", "도이치", "바클", "크레디",
  "뱅크오브", "미즈호", "소시에", "뉴엣지", "CLSA", "다이스", "SG", "CIMB", "CGS",
  "스탠다드", "스탠더드", "유안타",
];

/**
 * 외국계 창구인가.
 *
 * ⚠️ 키움은 이름에 **공백을 넣어** 준다 — 실제로 `"H S B C"` 로 왔다.
 * 공백을 지우고 비교하지 않으면 못 잡는다. (실측에서 HSBC 를 국내로 세고 있었다)
 */
function isForeign(name: string): boolean {
  /*
   * 점·공백을 다 뗀다 (2026-09-08). 키움은 「C.L.S.A 증권」처럼 점을 찍어 주는데
   * 힌트 「CLSA」와 안 맞아서 외국계인데 표가 안 붙었다 (벤티지 실측, SK하이닉스 매도 5위).
   * ⚠️ 유안타는 대만계라 넣었다.
   */
  const flat = name.replace(/[\s.·]/g, "").toUpperCase();
  return FOREIGN_HINTS.some((h) => flat.includes(h.replace(/[\s.·]/g, "").toUpperCase()));
}

function num(v: unknown): number {
  const n = Number(String(v ?? "").replace(/[+,\s]/g, ""));
  return Number.isFinite(n) ? Math.abs(n) : 0;
}

/*
 * 부호를 살리는 파서 (2026-09-11 숫자 점검).
 *
 * `num()` 은 절대값을 쓴다 — 누적 수량(`qty`)·외국계 추정 합계(`frgn_*_prsm_sum`)는
 * 부호가 붙어 와도 크기만 쓰므로 그게 맞다. 그런데 **증감(`irds`)은 다르다.**
 * 직전 조회 대비 줄어든 창구는 음수로 오는데, 절대값을 씌우면 「10,000주 빠졌다」가
 * 「+10,000」이 되어 화면에서 **가장 많이 빠진 창구가 「지금 붙는 중」으로** 강조됐다.
 * 증감만 이걸 쓴다.
 */
function signed(v: unknown): number {
  const n = Number(String(v ?? "").replace(/[+,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export interface BrokerSide {
  rank: number;
  code: string;
  name: string;
  /** 누적 수량 */
  qty: number;
  /**
   * 직전 조회 대비 증감 — **지금 붙고 있는 창구**를 가른다.
   * 음수면 그 창구가 **빠지고 있다**는 뜻이다 (2026-09-11 숫자 점검 — 여태 절대값이었다).
   */
  delta: number;
  foreign: boolean;
}

export interface BrokerPoint {
  /**
   * `HH:mm` — ⚠️ **콜론이 있다.** 실시간 시계열(`0F`·`0w`)은 `152030` 처럼 숫자만이라
   * 모양이 다르다. 그림(`FlowSeries`)은 자리로 잘라 읽으므로 받는 쪽에서 숫자만
   * 남긴다(2026-10-14 에 여기 콜론 하나로 외국계 그래프가 통째로 안 그려졌다).
   * 여기를 숫자로 바꾸지 말 것 — 이 값은 「23:20 기준」처럼 사람에게도 보인다.
   */
  t: string;
  /** 창구코드 → 그 시각의 누적 순매수(매수−매도) */
  net: Record<string, number>;
  /**
   * 외국계 합계·프로그램 순매수 — 그 시각의 누적 (2026-09-08 — 벤티지 "외국계랑
   * 프로그램 클릭하면 다른 거래원들처럼 밑에 그래프 나와서 추이 볼 수 있도록").
   * 창구는 실시간(0F)이 있지만 이 둘은 REST 에만 있어서 **이 함수를 부를 때만** 찍힌다.
   * 부르는 자리는 둘이다 — 화면(30초마다)과 **자동 수집**(`brokerAuto`: 관심종목·오늘
   * 초록 최대 80종목, 한 바퀴 2~3분). 그래서 그 80종목은 화면을 안 열어도 쌓인다.
   * 옛 점에는 없을 수 있다.
   */
  fx?: { sell: number; buy: number };
  /** 백만원 */
  prog?: number;
}

export interface BrokerFlow {
  code: string;
  at: string;
  sell: BrokerSide[];
  buy: BrokerSide[];
  /**
   * 외국계 합계 — **키움이 주는 값** (2026-09-08).
   *
   * 여태 상위 5개 창구 이름에 「모건」「골드만」이 들어 있나로 세고 있었다. 그래서 상위 5가
   * 전부 국내 증권사인 날은 외국계가 0 으로 찍혔다 — 벤티지: "거래원에 외국계 현황이
   * 키움이랑 안 맞네?" 그날 키움 앱은 매도 17,077 / 매수 30,917 이었다.
   *
   * ka10040 응답에 `frgn_sel_prsm_sum`·`frgn_buy_prsm_sum` 이 따로 온다. 상위 5 와 무관한
   * **전체 외국계 추정 합계**다. 그걸 그대로 싣는다.
   */
  foreignSell: number;
  foreignBuy: number;
  /**
   * **장 전이면 지난 장 값** (2026-10-13 — 벤티지: "지금 6시 25분인데 전일 데이터
   * 표시해줘야 하는 시간인데 왜 0으로 표시된 애들이 있는 거야?" · "우리 이미 데이터를
   * 다 들고 있지 않아? 일일원장 받아오잖아").
   *
   * 맞다. 새벽에는 키움이 이미 **새 날**이라 오늘치가 전부 비는데, 우리는 그 빈 값을
   * 0 으로 그렸다. 0 은 「거래가 없었다」는 **사실처럼 보이는 거짓말**이다 — 실제로는
   * 「아직 오늘이 시작 안 했다」이다.
   *
   * 그런데 어제 값은 이미 일별 원장(`data/daily/<코드>.json`)에 있다. 조회를 더 쓸 일이
   * 아니라 **들고 있는 것을 꺼내 쓰면 되는 일**이었다. 가격 카드가 새벽에 어제 일봉으로
   * 물러서는 것과 같은 처치다.
   */
  prev: { date: string; prog: number | null; fgnNet: number | null } | null;
  /** 매수 − 매도. 키움 값에서 */
  foreignNet: number;
  /** 프로그램 순매수(백만원). 못 받으면 null */
  program: number | null;
  /**
   * @deprecated 상위 5 이름으로 센 옛 값. 화면이 「상위5 내」라고 적던 자리에만 남긴다.
   */
  foreignNetTop5: number;
  /** 우리가 쌓아 온 시간대별. 화면을 안 본 시간은 빈다 */
  series: BrokerPoint[];
  /** 창구코드 → 이름 (시계열을 읽을 때 필요) */
  names: Record<string, string>;
  error: string | null;
}

/* ------------------------------------------------------------------ */
/* 시계열 저장                                                          */
/* ------------------------------------------------------------------ */

type Store = Record<string, { date: string; points: BrokerPoint[]; names: Record<string, string> }>;

async function load(): Promise<Store> {
  /* (2026-09-10 전수 점검) 아직 안 쓴 것이 있으면 그게 최신이다 — 파일을 읽으면 30초치 점을 잃는다 */
  if (pending) return pending;
  try {
    return JSON.parse(await readFile(FILE, "utf-8")) as Store;
  } catch {
    return {};
  }
}

async function writeNow(s: Store): Promise<void> {
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(s), "utf-8");
}

/*
 * (2026-09-10 전수 점검) **30초에 한 번만 쓴다.** brokerAuto 가 장중 1초마다 부르니 파일 전체를
 * 초당 한 번 다시 쓰고 있었다. 마지막 상태를 들고 있다가 30초 지나면 쓰고, 장이 끝나면
 * `flushBrokerFlow()` 로 남은 것을 쓴다. 메모리의 `store` 는 매번 최신이라 화면은 그대로다.
 */
const WRITE_GAP_MS = 30_000;
let pending: Store | null = null;
let lastWriteAt = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

async function save(s: Store): Promise<void> {
  pending = s;
  const wait = lastWriteAt + WRITE_GAP_MS - Date.now();
  if (wait <= 0) return flushBrokerFlow();
  if (!flushTimer) {
    flushTimer = setTimeout(() => void flushBrokerFlow().catch(() => undefined), wait);
    flushTimer.unref?.();
  }
}

/** 미뤄 둔 것을 지금 쓴다 — 장 끝·종료 직전 */
export async function flushBrokerFlow(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const s = pending;
  pending = null;
  if (!s) return;
  lastWriteAt = Date.now();
  await writeNow(s);
}

function kstNow(): { date: string; hm: string } {
  const d = new Date(Date.now() + 9 * 3600_000);
  const iso = d.toISOString();
  return { date: iso.slice(0, 10), hm: iso.slice(11, 16) };
}

/* ------------------------------------------------------------------ */

/**
 * 일별 원장에서 **지난 장**의 프로그램 순매수·외국인 순매수를 꺼낸다 (2026-10-13).
 * 새벽에는 키움이 이미 새 날이라 오늘치가 비는데, 어제 값은 우리가 이미 들고 있다.
 */
async function prevFromLedger(code: string): Promise<{ date: string; prog: number | null; fgnNet: number | null } | null> {
  try {
    const l = await loadLedger(code);
    const p = (l.prog ?? []).slice(-1)[0] ?? null;
    const f = (l.flow ?? []).slice(-1)[0] ?? null;
    const date = p?.d ?? f?.d ?? "";
    if (!date) return null;
    return { date, prog: p?.net ?? null, fgnNet: (f as { fgn?: number } | null)?.fgn ?? null };
  } catch {
    return null;
  }
}

export async function brokerFlow(client: KiwoomClient, code: string): Promise<BrokerFlow> {
  const bare = code.replace(/_(AL|NX)$/i, "");
  const empty: BrokerFlow = {
    code: bare,
    at: "",
    sell: [],
    buy: [],
    foreignSell: 0,
    foreignBuy: 0,
    foreignNet: 0,
    foreignNetTop5: 0,
    program: null,
    prev: null,
    series: [],
    names: {},
    error: null,
  };

  try {
    const { date: todayKst } = kstNow();
    const today = todayKst.replace(/-/g, "");
    const [{ data }, progRes] = await Promise.all([
      client.request<Record<string, unknown>>(RKINFO, "ka10040", {
        // 통합(_AL) — KRX 단독은 NXT 물량 창구(키움 등)가 반토막으로 보였다 (2026-08-26)
        stk_cd: alCode(bare),
      }),
      /* 프로그램 순매수 — 종합 탭(stockSummary)과 같은 TR·같은 줄. 시계열에 찍으려고 여기서도 */
      client
        .request<Record<string, unknown>>("/api/dostk/mrkcond", "ka90013", { stk_cd: alCode(bare), date: today, amt_qty_tp: "1" })
        .catch(() => null),
    ]);
    let prog: number | null = null;
    const progRows = Array.isArray(progRes?.data?.stk_daly_prm_trde_trnsn)
      ? (progRes!.data.stk_daly_prm_trde_trnsn as Record<string, unknown>[])
      : [];
    if (progRows.length > 0) {
      /*
       * (2026-09-11 숫자 점검) 여태 `?? progRows[0]` 폴백이 있었다. 오늘 줄이 아직 없으면
       * **다른 날 프로그램 순매수가 오늘 값으로** 실렸고, 시계열의 오늘 점(`point.prog`)에도
       * 그대로 찍혔다. 없으면 없는 것이다 — `program` 은 이미 `number | null` 이고,
       * `prog` 가 null 이면 점에 아예 안 넣는다(아래 참조).
       */
      const p = progRows.find((r) => String(r.dt ?? "") === today);
      const raw = String(p?.prm_netprps_amt ?? "").replace(/[+,\s]/g, "");
      const n = Number(raw);
      if (raw !== "" && Number.isFinite(n)) prog = n;
    }

    const side = (kind: "sel" | "buy"): BrokerSide[] => {
      const out: BrokerSide[] = [];
      for (let i = 1; i <= 5; i++) {
        const name = String(data[`${kind}_trde_ori_${i}`] ?? "").trim();
        if (!name) continue;
        out.push({
          rank: i,
          code: String(data[`${kind}_trde_ori_cd_${i}`] ?? "").trim(),
          name,
          qty: num(data[`${kind}_trde_ori_qty_${i}`]),
          // 증감은 음수(빠지는 창구)가 사실이다 — 절대값을 씌우지 않는다 (2026-09-11 숫자 점검)
          delta: signed(data[`${kind}_trde_ori_irds_${i}`]),
          foreign: isForeign(name),
        });
      }
      return out;
    };

    const sell = side("sel");
    const buy = side("buy");

    /*
     * 창구별 순매수 = 매수 − 매도.
     * **상위 5 안에 든 것만 셀 수 있다.** 키움이 5개까지만 주므로, 6위 밖에서 크게
     * 산 창구는 안 보인다 — 이 값을 「그 종목 전체」로 읽으면 안 된다.
     */
    const net: Record<string, number> = {};
    const names: Record<string, string> = {};
    for (const b of buy) {
      net[b.code] = (net[b.code] ?? 0) + b.qty;
      names[b.code] = b.name;
    }
    for (const s of sell) {
      net[s.code] = (net[s.code] ?? 0) - s.qty;
      names[s.code] = s.name;
    }

    const foreignNetTop5 =
      buy.filter((b) => b.foreign).reduce((a, b) => a + b.qty, 0) -
      sell.filter((s) => s.foreign).reduce((a, s) => a + s.qty, 0);
    /* 키움이 주는 전체 외국계 합계 — 부호가 붙어 오므로 절대값으로 */
    const foreignSell = num(data.frgn_sel_prsm_sum);
    const foreignBuy = num(data.frgn_buy_prsm_sum);
    const foreignNet = foreignBuy - foreignSell;
    /*
     * **번호의 뜻을 추측하지 않고 값을 맞춰 본다** (2026-10-15) — 같은 종목의 `0F` 프레임에
     * 이 두 숫자와 같은 칸이 있나. 조회를 더 쓰지 않는다. 까닭은 `fxFidProbe` 머리에.
     */
    try {
      noteFxFids(bare, foreignSell, foreignBuy);
    } catch {
      /* 재 보는 일 때문에 거래원 화면이 멈추면 안 된다 */
    }

    /* ---------- 시계열에 한 점 찍는다 ---------- */
    const { date, hm } = kstNow();
    const store = await load();
    const cur = store[bare];
    const entry = cur && cur.date === date ? cur : { date, points: [], names: {} };
    // 같은 분에 여러 번 부르면 마지막 것으로 덮는다 — 1분 간격이면 충분하다
    const point: BrokerPoint = { t: hm, net, fx: { sell: foreignSell, buy: foreignBuy } };
    if (prog !== null) point.prog = prog;
    const last = entry.points[entry.points.length - 1];
    if (last && last.t === hm) entry.points[entry.points.length - 1] = point;
    else entry.points.push(point);
    entry.names = { ...entry.names, ...names };
    store[bare] = entry;
    // 종목이 늘어도 파일이 안 커지게 — 오늘 것만 남긴다
    for (const k of Object.keys(store)) if (store[k].date !== date) delete store[k];
    await save(store).catch(() => undefined);

    return {
      ...empty,
      at: hm,
      sell,
      buy,
      foreignSell,
      foreignBuy,
      foreignNet,
      foreignNetTop5,
      program: prog,
      series: entry.points,
      names: entry.names,
      /*
       * 장 전이라 오늘치가 비면 **원장에서 지난 장을 꺼내 준다.**
       * 조회를 더 쓰지 않는다 — 이미 받아 둔 것을 읽을 뿐이다.
       */
      prev: foreignBuy === 0 && foreignSell === 0 && (prog === null || prog === 0) ? await prevFromLedger(bare) : null,
    };
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : "거래원 조회 실패" };
  }
}
