import type { KiwoomClient } from "./kiwoomClient.js";
import { alCode } from "./alCode.js";

/**
 * 키움 MTS/HTS에 등록해둔 관심종목 그룹 조회 (읽기 전용).
 * ka01301은 종목코드만 주므로 ka10095로 시세를 한 번에 붙인다.
 */

type Row = Record<string, unknown>;

const WATCHLIST_RESOURCE = "/api/dostk/watchlist";
const STKINFO_RESOURCE = "/api/dostk/stkinfo";

function toNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export interface KiwoomGroup {
  code: string;
  name: string;
}

export interface KiwoomGroupStock {
  code: string;
  name: string;
  price: number;
  change: number;
  changeRate: number;
  volume: number;
  /** 거래대금 (백만원) */
  tradeAmount: number;
}

export async function listKiwoomGroups(client: KiwoomClient): Promise<KiwoomGroup[]> {
  const { data } = await client.request<Row>(WATCHLIST_RESOURCE, "ka01300", {});
  const rows = Array.isArray(data.nofi) ? (data.nofi as Row[]) : [];
  return rows.map((r) => ({
    code: String(r.gcod ?? ""),
    name: String(r.name ?? ""),
  }));
}

export async function getKiwoomGroupStocks(
  client: KiwoomClient,
  groupCode: string,
): Promise<KiwoomGroupStock[]> {
  const { data } = await client.request<Row>(WATCHLIST_RESOURCE, "ka01301", {
    arn_grp_id: groupCode,
  });
  const rows = Array.isArray(data.nofj) ? (data.nofj as Row[]) : [];
  const codes = rows.map((r) => String(r.cod2 ?? "")).filter(Boolean);
  if (codes.length === 0) return [];

  // ka10095는 "|" 로 구분해 여러 종목을 한 번에 조회할 수 있다
  // 통합(_AL) — NXT 프리·애프터 체결도 보이게 (2026-08-26, 키움 앱과 같은 기준)
  const { data: quoteData } = await client.request<Row>(STKINFO_RESOURCE, "ka10095", {
    stk_cd: codes.map((c) => alCode(c)).join("|"),
  });
  const quotes = Array.isArray(quoteData.atn_stk_infr) ? (quoteData.atn_stk_infr as Row[]) : [];

  return quotes.map((q) => ({
    code: String(q.stk_cd ?? "").replace(/_(AL|NX)$/i, ""),
    name: String(q.stk_nm ?? ""),
    price: Math.abs(toNum(q.cur_prc)),
    change: toNum(q.pred_pre),
    changeRate: toNum(q.flu_rt),
    volume: toNum(q.trde_qty),
    tradeAmount: toNum(q.trde_prica),
  }));
}
