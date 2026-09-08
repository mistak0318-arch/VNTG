import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";
import { alCode } from "./alCode.js";

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

export interface BrokerSide {
  rank: number;
  code: string;
  name: string;
  /** 누적 수량 */
  qty: number;
  /** 직전 조회 대비 증감 — **지금 붙고 있는 창구**를 가른다 */
  delta: number;
  foreign: boolean;
}

export interface BrokerPoint {
  /** HH:mm */
  t: string;
  /** 창구코드 → 그 시각의 누적 순매수(매수−매도) */
  net: Record<string, number>;
  /**
   * 외국계 합계·프로그램 순매수 — 그 시각의 누적 (2026-09-08 — 벤티지 "외국계랑
   * 프로그램 클릭하면 다른 거래원들처럼 밑에 그래프 나와서 추이 볼 수 있도록").
   * 창구는 실시간(0F)이 있지만 이 둘은 REST 에만 있어서 **화면이 열려 있는 동안**
   * 30초마다 여기 찍는다. 옛 점에는 없을 수 있다.
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
  try {
    return JSON.parse(await readFile(FILE, "utf-8")) as Store;
  } catch {
    return {};
  }
}

async function save(s: Store): Promise<void> {
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(s), "utf-8");
}

function kstNow(): { date: string; hm: string } {
  const d = new Date(Date.now() + 9 * 3600_000);
  const iso = d.toISOString();
  return { date: iso.slice(0, 10), hm: iso.slice(11, 16) };
}

/* ------------------------------------------------------------------ */

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
      const p = progRows.find((r) => String(r.dt ?? "") === today) ?? progRows[0];
      const raw = String(p.prm_netprps_amt ?? "").replace(/[+,\s]/g, "");
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
          delta: num(data[`${kind}_trde_ori_irds_${i}`]),
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
    };
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : "거래원 조회 실패" };
  }
}
