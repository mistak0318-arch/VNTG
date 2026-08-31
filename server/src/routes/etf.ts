import { Router } from "express";
import { analyzeEtfs } from "../etfAnalysis.js";
import { analyzeHoldings } from "../etfHoldingsScore.js";
import type { KiwoomClient } from "../kiwoomClient.js";
import { buildEtfHolders, etfHoldersOf } from "../etfHolders.js";

/**
 * ETF 메뉴 (2026-08-27 — "퇴직연금에서 ETF도 투자하거든").
 *
 * 키움 REST ETF 묶음(ka40001~40010) 중 **전체 시세(ka40004)** 가 판의 본체다.
 * 필드 실측(2026-08-27, KIWOOM 코스피100 등 100행):
 *   stk_cd·stk_nm·close_pric(현재가)·pre_rt(등락률)·pred_pre(대비)·trde_qty(거래량)
 *   ·nav·trace_eor_rt(추적오차율)·trace_idex_nm(추적지수)·stk_cls
 * 필수 파라미터도 실측으로 받아냈다(에러가 이름을 하나씩 알려준다):
 *   txon_type·navpre·mngmcomp·txon_yn·trace_idex·stex_tp — 전부 "0"이면 전체.
 *
 * **괴리율은 우리가 계산한다** — (현재가 − NAV) ÷ NAV. ka40004 에 괴리율 필드가
 * 없고, 이 값이야말로 ETF 를 사기 전에 봐야 하는 것이다(NAV 보다 비싸게 사는 중인가).
 *
 * 과세유형(비과세/보유기간과세)은 ka40002(종목정보)가 준다 — 목록엔 없어 상세에서.
 * 실측: KODEX 200 → etftxon_type "비과세" (한글 문자열 그대로).
 */

const ETF_RESOURCE = "/api/dostk/etf";

export interface EtfListRow {
  code: string;
  name: string;
  price: number;
  change: number;
  changeRate: number;
  volume: number;
  /** 거래대금(억원) — 현재가 × 거래량 어림. ka40004 가 거래대금을 안 준다 */
  tradeValue: number;
  nav: number | null;
  /** 괴리율(%) = (현재가 − NAV) ÷ NAV — 양수면 NAV 보다 비싸게(프리미엄) 거래 중 */
  deviation: number | null;
  /** 추적오차율(%) — 클수록 지수를 못 따라간다 */
  traceErr: number | null;
  /** 추적 지수 이름 (KOSPI200 등) */
  index: string;
}

function num(v: unknown): number | null {
  const n = Number(String(v ?? "").replace(/[+,\s]/g, "").replace(/^--/, "-"));
  return Number.isFinite(n) ? n : null;
}

let listCache: { at: number; rows: EtfListRow[] } | null = null;
const LIST_TTL = 3 * 60_000;

/** ETF 전체 시세 — 연금 계좌 엔진(cisPension)이 모집단으로 쓴다 */
export async function fetchAll(client: KiwoomClient): Promise<EtfListRow[]> {
  if (listCache && Date.now() - listCache.at < LIST_TTL) return listCache.rows;
  const body = {
    txon_type: "0",
    navpre: "0",
    mngmcomp: "0",
    txon_yn: "0",
    trace_idex: "0",
    stex_tp: "0",
  };
  const rows: EtfListRow[] = [];
  let contYn = "N";
  let nextKey = "";
  /* 국내 ETF ~1,000종목, 100건씩 — 넉넉히 15쪽까지 */
  for (let page = 0; page < 15; page += 1) {
    const res = await client.request<{ etfall_mrpr?: Record<string, unknown>[] }>(
      ETF_RESOURCE,
      "ka40004",
      body,
      page === 0 ? {} : { contYn, nextKey },
    );
    for (const r of res.data.etfall_mrpr ?? []) {
      const price = Math.abs(num(r.close_pric) ?? 0);
      const volume = Math.abs(num(r.trde_qty) ?? 0);
      const nav = num(r.nav);
      if (!r.stk_cd || price <= 0) continue;
      rows.push({
        code: String(r.stk_cd),
        name: String(r.stk_nm ?? ""),
        price,
        change: num(r.pred_pre) ?? 0,
        changeRate: num(r.pre_rt) ?? 0,
        volume,
        tradeValue: Math.round((price * volume) / 1e8),
        nav: nav && nav > 0 ? nav : null,
        deviation: nav && nav > 0 ? ((price - nav) / nav) * 100 : null,
        traceErr: num(r.trace_eor_rt),
        index: String(r.trace_idex_nm ?? ""),
      });
    }
    contYn = res.contYn;
    nextKey = res.nextKey;
    if (contYn !== "Y") break;
    await new Promise((r) => setTimeout(r, 250));
  }
  listCache = { at: Date.now(), rows };
  return rows;
}

/** ka40002 종목정보 — 과세유형이 핵심. ETF 여부가 바뀌는 값이 아니라 오래 캐시한다 */
const infoCache = new Map<string, { at: number; info: EtfTaxInfo | null }>();
const INFO_TTL = 6 * 3600_000;

export interface EtfTaxInfo {
  name: string;
  index: string;
  /** "비과세" | "보유기간과세" — 키움이 한글로 준다 (실측). 퇴직연금 세금 판단용 */
  taxType: string;
  etnTaxType: string;
  /** 원주가격 */
  wonju: number | null;
}

export async function etfTaxInfo(client: KiwoomClient, code: string): Promise<EtfTaxInfo | null> {
  const hit = infoCache.get(code);
  if (hit && Date.now() - hit.at < INFO_TTL) return hit.info;
  let info: EtfTaxInfo | null = null;
  try {
    const { data } = await client.request<Record<string, unknown>>(ETF_RESOURCE, "ka40002", {
      stk_cd: code,
    });
    if (data.stk_nm) {
      info = {
        name: String(data.stk_nm ?? ""),
        index: String(data.etfobjt_idex_nm ?? ""),
        taxType: String(data.etftxon_type ?? ""),
        etnTaxType: String(data.etntxon_type ?? ""),
        wonju: num(data.wonju_pric),
      };
    }
  } catch {
    /* ETF 가 아니거나 실패 — null 로 캐시해 재시도 폭주를 막는다 */
  }
  infoCache.set(code, { at: Date.now(), info });
  if (infoCache.size > 500) {
    const first = infoCache.keys().next().value;
    if (first) infoCache.delete(first);
  }
  return info;
}

/** 전체 ETF — 누적등락률(기간 등락률) 계산의 모집단으로도 쓴다 */
export async function etfAll(client: KiwoomClient): Promise<EtfListRow[]> {
  return fetchAll(client);
}

/**
 * 리스트 캐시에서 한 종목 — 상세(ETF 탭)가 추적오차·NAV 를 얹을 때 쓴다.
 * 캐시가 식었으면 전체를 새로 받는다(3분 캐시라 상세 몇 번에 한 번 꼴).
 */
export async function etfRowOf(client: KiwoomClient, code: string): Promise<EtfListRow | null> {
  const rows = await fetchAll(client);
  return rows.find((r) => r.code === code) ?? null;
}

export function createEtfRouter(client: KiwoomClient): Router {
  const router = Router();

  /**
   * 이 종목을 담고 있는 ETF (2026-08-27) — 역인덱스를 파일에서 읽는다(조회 0회).
   * `?rebuild=1` 은 인덱스를 지금 다시 만든다(150곳 훑어 40초쯤 — 눈으로 확인할 때만).
   */
  router.get("/holders/:code", async (req, res, next) => {
    try {
      const code = String(req.params.code).replace(/_(AL|NX)$/i, "");
      if (req.query.rebuild === "1") await buildEtfHolders(client);
      res.json(await etfHoldersOf(code));
    } catch (err) {
      next(err);
    }
  });

  /**
   * ETF 분석 — 테마·상대강도·추세·품질 네 축 (2026-08-31).
   *
   * 무겁다(좁혀진 것마다 일봉 한 번). 화면이 부를 때만 돌고 캐시는 안 한다 —
   * 테마 강세가 장중에 바뀌므로 오래된 값을 보여 주는 게 더 나쁘다.
   */
  router.get("/analysis", async (req, res, next) => {
    try {
      res.json(
        await analyzeEtfs(client, {
          detail: Number(req.query.detail) || undefined,
          minTradeValue: Number(req.query.minTv) || undefined,
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  /**
   * ETF 구성종목 분석 (2026-08-31) — **담은 것을 보고 판단한다.**
   *
   * 이름으로 테마를 잇는 `/analysis` 와 **다른 방법**이다. 어느 쪽이 맞는지는
   * 나란히 두고 봐야 알 수 있어 둘 다 둔다.
   *
   * `?signal=1` 은 구성종목마다 신호등을 잰다 — 무겁다(유니크 종목 수만큼).
   */
  router.get("/holdings-analysis", async (req, res, next) => {
    try {
      res.json(
        await analyzeHoldings(client, {
          withSignal: req.query.signal === "1",
          limit: Number(req.query.limit) || undefined,
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  router.get("/list", async (_req, res, next) => {
    try {
      const rows = await fetchAll(client);
      res.json({ rows, at: listCache?.at ?? Date.now() });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
