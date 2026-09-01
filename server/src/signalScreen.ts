import { mkdir, readFile, writeFile } from "node:fs/promises";
import { allStocksUniverse } from "./allStocks.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cumulativeRank } from "./cumulativeRank.js";
import type { KiwoomClient } from "./kiwoomClient.js";
import { getMarketSnapshot } from "./marketSnapshot.js";
import { COMMON_PARAMS, findSpec } from "./rankSpecs.js";
import { evaluateSignal, type Level, type SignalResult } from "./signalLight.js";
import { getCommonStockCodes } from "./stockListCache.js";
import { stockLens, themeMapNow } from "./stockLens.js";

/**
 * 신호등 스크리너 — 거래대금 상위에서 내 기준에 맞는 종목을 찾는다.
 *
 * 지금까지 신호등은 **이미 아는 종목을 확인하는 용도**였다. 그런데 정작 필요한 건
 * "내 기준에 맞는 종목이 지금 시장에 뭐가 있나"다.
 *
 * 모집단은 **거래대금 상위**로 잡았다. 전종목을 돌리면 종목당 3~4회 조회라 감당이 안 되고,
 * 무엇보다 거래대금이 없는 종목은 신호가 맞아도 못 산다. 돈이 몰린 곳에서 고르는 게 맞다.
 *
 * 종목당 여러 번 조회하므로 **무겁다.** 그래서:
 *   - 진행 상황을 볼 수 있게 job 방식으로 돌린다 (algoScan 과 같은 구조)
 *   - 신호등 자체 캐시(15분)를 그대로 타므로 두 번째 실행은 훨씬 빠르다
 */

const RKINFO = "/api/dostk/rkinfo";

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const HISTORY_FILE = join(DATA_DIR, "screenHistory.json");

export interface ScreenHit {
  code: string;
  name: string;
  price: number;
  changeRate: number;
  /** 거래대금(백만원) */
  tradeValue: number;
  level: Level;
  score: number;
  /** 통과한 항목 이름 */
  passed: string[];
  /** 미달한 항목 이름 */
  failed: string[];
  /** 렌즈 (2026-08-28) — 이 종목의 무리(가장 강한 사업 테마)와 ETF 뒷배. 조회 0회 */
  theme?: { key: string; name: string; changeRate: number; streak: number } | null;
  etfBack?: { rate: number; top: string } | null;
  /**
   * 등락률·거래대금이 **직전 거래일 값**인가 (`Candidate.stale` 이 그대로 실린다).
   *
   * ⚠️ 타입에만 없고 값은 원래도 넘어가고 있었다 — `...u` 로 후보를 펼쳐 담기
   * 때문이다. 그래서 화면은 「메웠다」를 **알 수 있었는데 몰랐다.**
   * 새벽에 돌린 결과가 오늘 값인 척 떠 있던 이유다 (2026-09-01).
   */
  stale?: boolean;
}

export interface ScreenJob {
  status: "running" | "done" | "error";
  /** 검사 대상 수 */
  total: number;
  done: number;
  /** 지금까지 나온 결과 (점수 높은 순) */
  results: ScreenHit[];
  market: string;
  minLevel: Level;
  /** 어느 목록에서 찾았나 — SCREEN_UNIVERSES 의 key */
  universe: string;
  startedAt: string;
  error?: string;
}

function toNum(v: unknown): number {
  const n = Number(String(v ?? "").replace(/[+,\s]/g, ""));
  return Number.isFinite(n) ? Math.abs(n) : 0;
}

function bare(code: unknown): string {
  return String(code ?? "").replace(/_AL$/, "").trim();
}

export interface Candidate {
  code: string;
  name: string;
  price: number;
  changeRate: number;
  tradeValue: number;
  /**
   * **오늘 거래가 아직 없어 직전 거래일 값으로 메운 줄인가.**
   *
   * 개장 전에 돌리면 `ka10032` 가 등락률도 거래대금도 0 으로 준다. 그걸 그대로
   * 보여주면 화면에 **「0.00% · 0억」이 늘어서고**, 시세분석은 같은 종목을 두고
   * 전일 값을 말하니 두 화면이 다른 소리를 한다. 실제로 07:26 에 그 일이 났다.
   *
   * 0 은 「안 움직였다」가 아니라 **「아직 안 열렸다」**다. 그 둘은 다른 말이므로
   * 같은 0 으로 적으면 안 된다. 직전 거래일 값으로 메우고 **메웠다고 표시한다.**
   */
  stale?: boolean;
}

/**
 * 거래대금 상위 — ka10032.
 *
 * 한 번에 100건씩 오므로 필요하면 이어받는다. **ETF·ETN·우선주를 빼고 나서** 세므로
 * "상위 100종목"은 실제 종목 100개를 뜻한다. (거래대금 상위 100건 중 30~40건이 ETF다)
 */
/**
 * 거래대금 상위 **실제 종목**.
 *
 * 추적기도 같은 것을 쓴다 — 「신호등 찾기」와 모집단이 다르면 같은 종목을 두고
 * 한쪽은 담고 한쪽은 안 담는다. 그러면 추적기가 검증하는 게 신호등이 아니라
 * **두 모집단의 차이**가 된다.
 */
export async function tradeValueTop(
  client: KiwoomClient,
  market: string,
  limit: number,
): Promise<Candidate[]> {
  const common = await getCommonStockCodes(client);
  const out: Candidate[] = [];
  let contYn = "N";
  let nextKey = "";

  /*
   * 페이지를 넘기며 채운다.
   *
   * ⚠️ 4페이지(400건)로 막혀 있었다. 그런데 **보통주만 남기므로** 400건을 받아도
   * 손에 남는 건 그보다 훨씬 적다 — 거래대금 상위에는 KODEX·TIGER 같은 ETF 와 우선주가
   * 잔뜩 섞여 있다. 실시간 구독을 500 종목으로 올리면서 여기가 병목이 됐다.
   *
   * ⚠️ 그다음 여덟 페이지로 늘렸는데 **그것도 모자랐다.** 「상위 500」을 골랐더니
   * 화면에 「421/421 검사」가 떴다 — 800건에서 ETF·우선주를 빼면 421개뿐이었다.
   * 500을 고른 사람은 500을 봤다고 믿는데 실제로는 421을 본 것이다.
   *
   * 그래서 **요청한 수를 채울 때까지** 넘긴다. 넉넉히 스무 쪽까지 두되, 채우면
   * 그 자리에서 멈추므로 적게 부르면 예전처럼 한두 페이지에서 끝난다.
   */
  for (let page = 0; page < 20 && out.length < limit; page += 1) {
    const res = await client.request<Record<string, unknown>>(
      RKINFO,
      "ka10032",
      {
        mrkt_tp: market,
        mang_stk_incls: "0", // 관리종목 제외 — 신호가 맞아도 들어갈 자리가 아니다
        stex_tp: "3",
      },
      page === 0 ? {} : { contYn, nextKey },
    );
    const rows = Array.isArray(res.data.trde_prica_upper)
      ? (res.data.trde_prica_upper as Record<string, unknown>[])
      : [];
    if (rows.length === 0) break;

    for (const r of rows) {
      const code = bare(r.stk_cd);
      if (!common.has(code)) continue; // ETF·ETN·리츠·우선주
      out.push({
        code,
        name: String(r.stk_nm ?? "").trim(),
        // 키움은 하락 종목의 현재가를 음수로 준다 — 부호를 떼야 「−52,300원」이 안 뜬다
        price: Math.abs(toNum(r.cur_prc) ?? 0),
        changeRate: Number(String(r.flu_rt ?? "").replace(/[+,\s]/g, "")) || 0,
        tradeValue: toNum(r.trde_prica),
      });
      if (out.length >= limit) break;
    }

    if (res.contYn !== "Y" || !res.nextKey) break;
    contYn = "Y";
    nextKey = res.nextKey;
    await new Promise((r) => setTimeout(r, 260));
  }

  /*
   * 개장 전이면(전부 0) **직전 거래일 기준으로 다시 뽑는다.** 값만 메우면 순서가
   * 종목코드순으로 남아 「거래대금 상위」라는 이름이 거짓이 된다.
   */
  if (out.length > 0 && out.every((r) => r.tradeValue <= 0)) {
    const prev = await rankByPrevDay(client, limit, market);
    if (prev && prev.length > 0) return prev;
  }
  await fillFromSnapshot(client, out);
  return out;
}

/**
 * 개장 전이면 **직전 거래일 거래대금으로 줄을 다시 세운다** (2026-08-31).
 *
 * ⚠️ 예전엔 값만 메우고 **순서는 그대로 뒀다.** 그런데 개장 전 `ka10032` 는 거래대금이
 * 전부 0 이라 **종목코드 앞순서**로 온다(실측: 동화약품·KR모터스·경방…). 그걸 앞에서
 * N개 잘라 쓰면 「거래대금 상위 40」이 실제로는 **000020 부터 40개**다.
 *
 * 신호등 찾기·신호등 백테스트·주도주가 전부 이 함수를 모집단으로 쓰므로, 아침에
 * 돌린 결과는 통째로 다른 종목을 본 것이었다.
 *
 * 스냅샷에는 **직전 거래일 거래대금이 들어 있다**(`tradeValue`, 억). 그것으로 전 종목을
 * 다시 줄 세워 진짜 상위를 뽑는다 — 받아 온 N개 안에서만 정렬하면 「엉뚱한 40개 중의
 * 상위」가 될 뿐이다.
 *
 * ## 등락률 상위도 같은 함정이었다 (2026-09-01)
 *
 * `by: "rate"` 를 붙였다. 「등락률 상위」도 장 밖에는 등락률이 전부 0 으로 오므로
 * **순서가 종목코드순으로 무너진다** — 거래대금 상위와 똑같은 문제인데 그쪽만
 * 막아 두고 있었다. 스냅샷에 등락률도 있으니 같은 방법으로 다시 뽑는다.
 *
 * 나머지 모집단(누적등락률·외국인 연속순매매·동일순매매·기관외인 연속매매)은
 * **정렬 기준이 수급이라 스냅샷으로 다시 뽑을 수 없다.** 대신 그 TR 들은 장 밖에도
 * 직전 거래일 수급으로 순위를 제대로 주므로 순서는 멀쩡하다 — 빈 칸만 메우면 된다.
 */
async function rankByPrevDay(
  client: KiwoomClient,
  limit: number,
  market: string,
  by: "value" | "rate" = "value",
): Promise<Candidate[] | null> {
  const snap = await getMarketSnapshot(client).catch(() => null);
  if (!snap) return null;
  const common = await getCommonStockCodes(client).catch(() => null);
  const rows = [...snap.byCode.values()]
    /*
     * 거래대금이 있는 것만 — 등락률로 줄 세울 때도 마찬가지다. 거래가 거의 없는
     * 종목은 등락률이 크게 튀어도 들어갈 자리가 아니다(상한가 잔량만 쌓인 품절주).
     */
    .filter((s) => (s.tradeValue ?? 0) > 0 && (!common || common.has(s.code)))
    /* 시장 고르기 — "000" 은 전체, "001" 코스피, "101" 코스닥 */
    .filter((s) =>
      market === "001" ? s.market === "kospi" : market === "101" ? s.market === "kosdaq" : true,
    )
    .sort((a, b) =>
      by === "rate" ? b.changeRate - a.changeRate : (b.tradeValue ?? 0) - (a.tradeValue ?? 0),
    )
    .slice(0, limit);
  if (rows.length === 0) return null;
  return rows.map((s) => ({
    code: s.code,
    name: s.name,
    price: s.price,
    changeRate: s.changeRate,
    /* 스냅샷은 억, 이 함수를 쓰는 쪽은 백만원을 기대한다 (leaderScan 이 /100 한다) */
    tradeValue: (s.tradeValue ?? 0) * 100,
    stale: true,
  }));
}

/**
 * 빠진 칸을 **직전 거래일 스냅샷으로 메운다.**
 *
 * 전종목 스냅샷은 「거래가 반영된 것」만 저장하도록 막아 뒀다(`traded`). 그래서
 * 장 밖에 읽으면 **직전 거래일 종가·등락률·거래대금**이 들어 있다 — 필요한 게 그것이다.
 *
 * ## 왜 하나로 합쳤나 (2026-09-01)
 *
 * 예전엔 메우는 함수가 둘이었고 조건이 서로 달랐다:
 *
 *   `fillStale`   — **거래대금**이 전부 0 일 때만 (거래대금 상위 모집단 전용)
 *   `fillMissing` — **가격**이 0 인 줄만 (연속매매 모집단 전용)
 *
 * 그 사이로 새는 경우가 있었다. 벤티지가 새벽 00:30 에 「외국인 연속순매매」로
 * 돌렸더니 **현재가는 나오는데 등락률 0.00% · 거래대금 「-」**. 그 TR 은 현재가는
 * 주고 등락률·거래대금을 안 주는데,
 *
 *   · `fillMissing` 은 가격이 있으니 그냥 지나갔고,
 *   · `fillStale` 은 이 경로에서 아예 안 불렸다.
 *
 * 칸마다 조건을 따로 두면 이런 조합이 계속 생긴다. **칸 단위로 판단**하도록 합쳤다.
 *
 * ## 「전부 0」으로 판단하는 이유
 *
 * 등락률이 진짜 0.00% 인 종목(보합)은 있다. 그래서 한 줄만 보고는 「안 온 값」인지
 * 「진짜 0」인지 못 가른다. 하지만 **수십 종목이 전부 0 일 수는 없다** —
 * 그건 TR 이 그 칸을 안 준 것이다. 그때만 메운다.
 *
 * ## 메운 값에는 표를 단다
 *
 * 스냅샷 거래대금은 **어림값**(거래량 × 현재가)이고 등락률은 **직전 거래일** 것이다.
 * 오늘 값인 척하면 안 되므로 `stale` 을 세운다 — 화면이 그걸로 「직전 거래일 기준」을
 * 적는다. 스냅샷조차 0 이면 아무것도 안 한다. 그때는 정말 값이 없는 것이고,
 * **못 내는 값을 어림해서 채우지 않는다.**
 */
async function fillFromSnapshot(client: KiwoomClient, rows: Candidate[]): Promise<void> {
  if (rows.length === 0) return;

  const needPrice = rows.some((r) => r.price === 0);
  const needRate = rows.every((r) => r.changeRate === 0);
  const needValue = rows.every((r) => r.tradeValue <= 0);
  if (!needPrice && !needRate && !needValue) return;

  const snap = await getMarketSnapshot(client).catch(() => null);
  if (!snap) return;

  for (const r of rows) {
    const s = snap.byCode.get(r.code);
    if (!s || (s.changeRate === 0 && s.price === 0)) continue;

    if (r.price === 0 && s.price > 0) r.price = s.price;
    if (needRate && s.changeRate !== 0) {
      r.changeRate = s.changeRate;
      r.stale = true;
    }
    /* 스냅샷은 억원, `Candidate.tradeValue` 는 키움과 같은 백만원이다 */
    if (needValue && (s.tradeValue ?? 0) > 0) {
      r.tradeValue = Math.round((s.tradeValue ?? 0) * 100);
      r.stale = true;
    }
  }
}

// ---------------------------------------------------------------- 모집단

/**
 * 어디서 찾을 것인가 (2026-08-25).
 *
 * 지금까지 모집단은 거래대금 상위뿐이었다. 그런데 우리는 이미 다른 목록들을 갖고
 * 있다 — 외국인 연속순매매, 동일순매매, 누적등락률… **어느 목록에서 초록이 잘
 * 나오는가** 자체가 물음이다. 등락률 상위의 초록(이미 오른 것)과 연속매매의
 * 초록(수급이 미는 것)은 다른 종류의 후보다.
 *
 * 전부 **이미 있는 조회**를 그대로 쓴다 — 시세분석 명세(rankSpecs)와 각 화면의
 * TR. 새 TR 을 만들지 않는다.
 */
export const SCREEN_UNIVERSES: { key: string; label: string; hint: string }[] = [
  {
    key: "all",
    label: "전종목 (조회 0회 사전훑기)",
    hint: "2,400여 종목을 일봉 캐시로 훑어 후보를 세운다 — 거래대금 순위 밖도 본다",
  },
  { key: "trade-value", label: "거래대금 상위", hint: "돈이 몰린 곳 — 기본. 최대 500까지 이어받는다" },
  { key: "flu-rate", label: "등락률 상위", hint: "오늘 가장 오른 종목 — 이미 오른 것 중에 더 갈 것을 찾는다" },
  { key: "cum", label: "누적등락률 상위 (5일)", hint: "닷새 누적으로 오른 종목 — 하루 급등보다 흐름" },
  { key: "foreign-cont", label: "외국인 연속순매매", hint: "외국인이 며칠째 사는 종목" },
  { key: "cont", label: "기관·외국인 연속매매", hint: "두 주체가 같이 사는 종목 (ka10131)" },
  { key: "same-net", label: "동일순매매 상위 (7일)", hint: "최근 7일 기관·외국인이 같은 방향으로 순매수" },
  { key: "intraday-investor", label: "장중 기관 매매상위", hint: "지금 장중 기관 순매수 상위 — 장중에만 값이 있다" },
  /*
   * 외국인 순매수 상위 (2026-09-01 벤티지 요청) — `ka10034`.
   *
   * 「외국인 연속순매매」와 다른 것을 본다. 연속은 **며칠 이어졌나**(일수)이고
   * 이건 **얼마나 샀나**(수량)다. 실측에서 연속은 뒤쪽에서 부호가 뒤집혔지만
   * (-1.59%p) 금액·수량 쪽은 다른 값이라 따로 볼 값이 있다.
   *
   * `rankSpecs` 에 이미 있던 조회다 — 시세분석 화면이 쓰던 것을 모집단으로도
   * 쓰는 것이라 새 TR 이 아니다.
   */
  { key: "foreign-period", label: "외국인 순매수 상위", hint: "외국인이 하루 동안 가장 많이 산 종목 — 연속 일수가 아니라 수량" },
];

function yyyymmdd(daysAgo = 0): string {
  const d = new Date(Date.now() + 9 * 3600_000 - daysAgo * 86400_000);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

/** 시세분석 명세(rankSpecs)에 있는 조회를 모집단으로 — 연속조회로 limit 까지 */
async function rankSpecUniverse(
  client: KiwoomClient,
  specKey: string,
  market: string,
  limit: number,
): Promise<Candidate[]> {
  const spec = findSpec(specKey);
  if (!spec) throw new Error(`없는 조회입니다: ${specKey}`);
  const common = await getCommonStockCodes(client);
  const seen = new Set<string>();
  const out: Candidate[] = [];
  let contYn = "N";
  let nextKey = "";
  for (let page = 0; page < 6 && out.length < limit; page += 1) {
    const res = await client.request<Record<string, unknown>>(
      `/api/dostk/${spec.uri}`,
      spec.apiId,
      {
        ...COMMON_PARAMS,
        ...(spec.params ?? {}),
        mrkt_tp: market,
        // ⚠️ 항상 보낸다 — 시세분석 라우트도 그렇다. ka10035 는 exchange 표시가
        // 없는데도 stex_tp 가 필수라(1511), 조건부로 보내면 그 조회가 통째로 죽는다
        stex_tp: "3",
      },
      page === 0 ? {} : { contYn, nextKey },
    );
    const rows = Array.isArray(res.data[spec.listKey])
      ? (res.data[spec.listKey] as Record<string, unknown>[])
      : [];
    if (rows.length === 0) break;
    for (const r of rows) {
      const code = bare(r.stk_cd);
      if (!code || !common.has(code) || seen.has(code)) continue;
      seen.add(code);
      out.push({
        code,
        name: String(r.stk_nm ?? "").trim(),
        price: toNum(r.cur_prc),
        changeRate: Number(String(r.flu_rt ?? "").replace(/[+,\s]/g, "")) || 0,
        tradeValue: toNum(r.trde_prica),
      });
      if (out.length >= limit) break;
    }
    if (res.contYn !== "Y" || !res.nextKey) break;
    contYn = "Y";
    nextKey = res.nextKey;
    await new Promise((r) => setTimeout(r, 260));
  }

  /*
   * 등락률로 줄 세우는 목록은 장 밖에 **순서가 무너진다** — 등락률이 전부 0 으로
   * 오므로 종목코드순이 된다. 그때는 스냅샷의 직전 거래일 등락률로 다시 뽑는다.
   * (거래대금 상위가 `rankByPrevDay` 로 막아 둔 것과 같은 문제다.)
   */
  if (specKey === "flu-rate" && out.length > 0 && out.every((r) => r.changeRate === 0)) {
    const prev = await rankByPrevDay(client, limit, market, "rate");
    if (prev && prev.length > 0) return prev;
  }

  await fillFromSnapshot(client, out);
  return out;
}

/** 동일순매매 (ka10062) — 화면과 같은 조건: 최근 7일 · 순매수 · 금액순 */
async function sameNetUniverse(
  client: KiwoomClient,
  market: string,
  limit: number,
): Promise<Candidate[]> {
  const common = await getCommonStockCodes(client);
  const { data } = await client.request<Record<string, unknown>>(RKINFO, "ka10062", {
    strt_dt: yyyymmdd(7),
    end_dt: yyyymmdd(0),
    mrkt_tp: market,
    trde_tp: "1",
    sort_cnd: "2",
    unit_tp: "1",
    stex_tp: "1",
  });
  const rows = Array.isArray(data.eql_nettrde_rank)
    ? (data.eql_nettrde_rank as Record<string, unknown>[])
    : [];
  const out: Candidate[] = [];
  for (const r of rows) {
    const code = bare(r.stk_cd);
    if (!code || !common.has(code)) continue;
    out.push({
      code,
      name: String(r.stk_nm ?? "").trim(),
      price: toNum(r.cur_prc),
      changeRate: Number(String(r.flu_rt ?? "").replace(/[+,\s]/g, "")) || 0,
      tradeValue: 0,
    });
    if (out.length >= limit) break;
  }
  await fillFromSnapshot(client, out);
  return out;
}

/**
 * 기관·외국인 연속매매 (ka10131) — 화면과 같은 조건.
 * ⚠️ 이 TR 은 전체(000)가 없다 — 000 이면 코스피·코스닥을 받아 합친다.
 * 현재가를 안 주므로 스냅샷으로 메운다.
 */
async function contUniverse(
  client: KiwoomClient,
  market: string,
  limit: number,
): Promise<Candidate[]> {
  const common = await getCommonStockCodes(client);
  const markets = market === "000" ? ["001", "101"] : [market];
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const m of markets) {
    const { data } = await client
      .request<Record<string, unknown>>("/api/dostk/frgnistt", "ka10131", {
        dt: "1",
        strt_dt: "",
        end_dt: "",
        mrkt_tp: m,
        netslmt_tp: "2",
        stk_inds_tp: "0",
        amt_qty_tp: "0",
        stex_tp: "1",
      })
      .catch(() => ({ data: {} as Record<string, unknown> }));
    const rows = Array.isArray(data.orgn_frgnr_cont_trde_prst)
      ? (data.orgn_frgnr_cont_trde_prst as Record<string, unknown>[])
      : [];
    for (const r of rows) {
      const code = bare(r.stk_cd);
      if (!code || !common.has(code) || seen.has(code)) continue;
      seen.add(code);
      out.push({
        code,
        name: String(r.stk_nm ?? "").trim(),
        price: 0, // 이 TR 은 현재가를 안 준다 — 아래 스냅샷이 메운다
        changeRate: 0,
        tradeValue: 0,
      });
      if (out.length >= limit) break;
    }
    if (out.length >= limit) break;
  }
  await fillFromSnapshot(client, out);
  return out;
}

/** 모집단 하나를 받아 온다 — 어느 키든 Candidate[] 로 통일. 슈퍼신호등도 이걸 쓴다 */
export async function fetchUniverse(
  client: KiwoomClient,
  key: string,
  market: string,
  limit: number,
): Promise<Candidate[]> {
  /**
   * **전종목** (2026-09-01) — 조회 0회.
   *
   * 벤티지: "전체종목 훑는거지? 다?" — 아니었다. 모집단이 전부 순위 조회라
   * **거래대금 500위 밖은 아예 안 보였다.** 실측에서 가장 잘 통한 것이
   * 「시총 3천억 이하 소형주」인데 그런 종목이 거래대금 순위에서는 아래쪽이다.
   *
   * ⚠️ 여기서 매기는 사전 점수는 **일봉으로 낼 수 있는 기준만**으로 낸 것이라
   * 추세가 좋은 종목이 위로 온다. 「좋은 종목」이 아니라 「볼 만한 후보」다.
   */
  if (key === "all") {
    const { rows } = await allStocksUniverse(client, market, limit);
    return rows.map((r) => ({
      code: r.code,
      name: r.name,
      price: r.price,
      changeRate: r.changeRate,
      tradeValue: r.tradeValue,
    }));
  }
  if (key === "trade-value") return tradeValueTop(client, market, limit);
  if (key === "cum") {
    const r = await cumulativeRank(client, market, 5, Math.min(200, Math.max(limit, 100)));
    const out: Candidate[] = r.rows.slice(0, limit).map((c) => ({
      code: c.code,
      name: c.name,
      price: c.price,
      /* 누적 순위는 5일 누적으로 매겨지고, 여기 담는 것은 **오늘치**다 */
      changeRate: c.todayRate,
      tradeValue: c.tradeValue,
    }));
    /*
     * ⚠️ 이 경로만 메우기를 안 탔다 (2026-09-01). 다른 모집단은 다 스냅샷으로
     * 메우는데 여기는 매핑하고 바로 돌려줬다 — 장 밖에 `todayRate` 는 0 이므로
     * 「누적등락률 상위」의 등락률 칸이 통째로 0.00% 였다.
     * 순위 자체는 5일 누적이라 장 밖에도 멀쩡하다. 칸만 메우면 된다.
     */
    await fillFromSnapshot(client, out);
    return out;
  }
  if (key === "same-net") return sameNetUniverse(client, market, limit);
  if (key === "cont") return contUniverse(client, market, limit);
  return rankSpecUniverse(client, key, market, limit);
}

const LEVEL_RANK: Record<Level, number> = { green: 3, yellow: 2, red: 1, unknown: 0 };

const jobs = new Map<string, ScreenJob>();

/** 오래된 작업은 치운다 — 메모리에만 두므로 서버를 재시작하면 사라진다 */
function prune(): void {
  if (jobs.size < 20) return;
  const old = [...jobs.entries()]
    .sort((a, b) => a[1].startedAt.localeCompare(b[1].startedAt))
    .slice(0, 10);
  for (const [id] of old) jobs.delete(id);
}

export function getScreenJob(id: string): ScreenJob | undefined {
  return jobs.get(id);
}

/**
 * 지금 돌고 있는 찾기 — **전역 작업 띠와 화면 복귀용** (2026-08-25).
 *
 * 채널 검색과 같은 문제였다: 찾기를 걸고 다른 메뉴로 가면 진행을 볼 방법이 없고,
 * 돌아와도 jobId 를 잃어 이어받지 못했다. 서버가 어차피 작업을 들고 있으니
 * 「지금 도는 것」을 물어볼 수 있게 한다 — 화면 상태를 어디 저장할 필요가 없다.
 */
export function activeScreenJobs(): {
  id: string;
  done: number;
  total: number;
  market: string;
  universe: string;
  universeLabel: string;
  hits: number;
}[] {
  return [...jobs.entries()]
    .filter(([, j]) => j.status === "running")
    .map(([id, j]) => ({
      id,
      done: j.done,
      total: j.total,
      market: j.market,
      universe: j.universe,
      universeLabel: SCREEN_UNIVERSES.find((u) => u.key === j.universe)?.label ?? j.universe,
      hits: j.results.length,
    }));
}

/**
 * 지난 스크리닝 결과.
 *
 * 매번 새로 돌려야 하면 **어제 뭐가 걸렸는지 볼 수가 없다.** 그런데 이 화면의 값어치는
 * 오늘 목록보다 오히려 흐름에 있다 — 사흘째 계속 걸리는 종목과 오늘 처음 뜬 종목은
 * 전혀 다른 얘기다. 그래서 끝난 작업은 디스크에 남긴다.
 *
 * 결과만 남기고 작업 상태는 버린다. 다시 열 때 필요한 건 "그때 뭐가 걸렸나"뿐이다.
 */
export interface ScreenRun {
  id: string;
  at: string;
  market: string;
  minLevel: Level;
  /** 어느 목록에서 찾았나 — 예전 기록에는 없다(거래대금 상위였다) */
  universe?: string;
  /** 검사한 종목 수 */
  total: number;
  results: ScreenHit[];
}

const KEEP_RUNS = 40;

async function readHistory(): Promise<ScreenRun[]> {
  try {
    const parsed = JSON.parse(await readFile(HISTORY_FILE, "utf-8")) as ScreenRun[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveRun(run: ScreenRun): Promise<void> {
  const rows = await readHistory();
  rows.push(run);
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(HISTORY_FILE, JSON.stringify(rows.slice(-KEEP_RUNS)), "utf-8");
}

/** 최신순 목록. 본문(results)까지 주면 무거우므로 요약만 */
export async function listScreenRuns(): Promise<
  { id: string; at: string; market: string; minLevel: Level; universe?: string; total: number; hits: number }[]
> {
  const rows = await readHistory();
  return rows
    .map((r) => ({
      id: r.id,
      at: r.at,
      market: r.market,
      minLevel: r.minLevel,
      universe: r.universe,
      total: r.total,
      hits: r.results.length,
    }))
    .sort((a, b) => b.at.localeCompare(a.at));
}

export async function getScreenRun(id: string): Promise<ScreenRun | null> {
  return (await readHistory()).find((r) => r.id === id) ?? null;
}

/**
 * 두 회차를 견줘 **새로 들어온 종목과 빠진 종목**을 낸다.
 *
 * 목록을 나란히 놓고 사람이 눈으로 맞춰 보는 건 못 할 일이다.
 * 오늘 처음 뜬 종목이 어느 것인지가 이 화면에서 제일 알고 싶은 것이다.
 */
export async function diffScreenRuns(
  fromId: string,
  toId: string,
): Promise<{ added: ScreenHit[]; removed: ScreenHit[]; stayed: ScreenHit[] } | null> {
  const rows = await readHistory();
  const a = rows.find((r) => r.id === fromId);
  const b = rows.find((r) => r.id === toId);
  if (!a || !b) return null;
  const before = new Set(a.results.map((r) => r.code));
  const after = new Set(b.results.map((r) => r.code));
  return {
    added: b.results.filter((r) => !before.has(r.code)),
    removed: a.results.filter((r) => !after.has(r.code)),
    stayed: b.results.filter((r) => before.has(r.code)),
  };
}

/**
 * 스크리닝 시작. 곧바로 jobId 를 돌려주고 뒤에서 계속 돈다.
 *
 * @param market 000 전체 / 001 코스피 / 101 코스닥
 * @param minLevel 이 등급 이상만 결과에 남긴다
 * @param limit 거래대금 상위 몇 개를 검사할지
 */
export function startScreen(
  client: KiwoomClient,
  opts: { market?: string; minLevel?: Level; limit?: number; universe?: string } = {},
): string {
  const market = ["000", "001", "101"].includes(String(opts.market)) ? String(opts.market) : "000";
  const minLevel = opts.minLevel ?? "green";
  /*
   * 상한을 200 에서 500 으로 올렸다. 상위 백 개는 이미 다 아는 종목이라 **새로 걸리는 건
   * 그 아래**에서 나온다. 종목마다 조회가 나가므로 오백이면 한참 걸리지만, 그건 화면이
   * 진행바로 알려 주고 사람이 고른 값이다. 숫자는 이제 화면에서 자유 입력이다.
   */
  const limit = Math.min(Math.max(opts.limit ?? 100, 10), 500);
  const uniKey = SCREEN_UNIVERSES.some((u) => u.key === opts.universe)
    ? String(opts.universe)
    : "trade-value";

  const id = `scr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const job: ScreenJob = {
    status: "running",
    total: 0,
    done: 0,
    results: [],
    market,
    minLevel,
    universe: uniKey,
    startedAt: new Date().toISOString(),
  };
  jobs.set(id, job);
  prune();

  void (async () => {
    try {
      const universe = await fetchUniverse(client, uniKey, market, limit);
      job.total = universe.length;
      /* 렌즈 — 테마 강도 한 벌을 잡 시작에 받아 두고(수십 ms) 걸린 종목마다 붙인다 */
      const themeMap = await themeMapNow().catch(() => new Map() as Awaited<ReturnType<typeof themeMapNow>>);

      for (const u of universe) {
        try {
          const sig: SignalResult = await evaluateSignal(client, u.code);
          if (LEVEL_RANK[sig.level] >= LEVEL_RANK[minLevel]) {
            const lens = await stockLens(u.code, themeMap).catch(() => ({ theme: null, etfBack: null }));
            job.results.push({
              ...u,
              level: sig.level,
              score: sig.score,
              passed: sig.checks.filter((c) => c.pass === true).map((c) => c.label),
              failed: sig.checks.filter((c) => c.pass === false).map((c) => c.label),
              ...lens,
            });
            // 점수 높은 순 — 진행 중에도 화면에서 바로 볼 수 있게 매번 정렬한다
            job.results.sort((a, b) => b.score - a.score || b.tradeValue - a.tradeValue);
          }
        } catch {
          // 한 종목 실패가 전체를 막지 않게
        }
        job.done += 1;
        // 신호등 하나가 여러 TR을 부르므로 간격을 넉넉히 둔다
        await new Promise((r) => setTimeout(r, 260));
      }
      job.status = "done";
      // 결과가 없어도 남긴다 — "이날은 아무것도 안 걸렸다"도 정보다
      await saveRun({
        id,
        at: job.startedAt,
        market,
        minLevel,
        universe: uniKey,
        total: job.total,
        results: job.results,
      }).catch(() => undefined);
      /*
       * **점수대 그룹 동기화** (2026-09-01) — 회차가 저장된 **직후**다.
       *
       * 벤티지: "이탈되거나 삭제되는 종목은 알아서 동기화되는 구조로."
       *
       * 동기화가 이 회차를 읽으므로 저장보다 먼저 부르면 어제 것으로 맞춘다.
       * 조회 0회(파일만 읽는다)라 여기 끼워도 느려지지 않는다.
       */
      const { syncScoreBands } = await import("./scoreBandSync.js");
      await syncScoreBands().catch(() => undefined);
    } catch (err) {
      job.status = "error";
      job.error = err instanceof Error ? err.message : "스크리닝 실패";
    }
  })();

  return id;
}
