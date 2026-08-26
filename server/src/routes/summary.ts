import { Router } from "express";
import type { KiwoomClient } from "../kiwoomClient.js";
import { getSection } from "../marketOverview.js";
import type { IndexCard } from "../marketOverview.js";
import { evaluateMarket } from "../marketSignal.js";
import { evaluateGroups } from "../usWatchlist.js";
import { listGroups, listWatchlist } from "../watchlist.js";

/**
 * 위젯·워치 요약 (2026-08-26, TODO G절).
 *
 * 바탕화면 위젯(안드로이드 Glance)과 워치 타일은 브라우저가 없다 — 화면 API 를
 * 여러 번 부를 수도 없다. 그래서 **한 번에 다 담은 작은 JSON** 을 여기서 만든다.
 *
 * ## 인증 (Cloudflare Access 서비스 토큰)
 *
 * 위젯·워치에는 브라우저 세션이 없으므로 Access 의 **서비스 토큰**으로 통과한다
 * (헤더 CF-Access-Client-Id / CF-Access-Client-Secret). Access 정책은 이 프리픽스
 * (`/api/summary/*`)만 열어 준다 — 시크릿이 기기에 박히므로 **조회 요약만** 나가고,
 * 계좌·설정 경로는 이 토큰으로 못 들어온다. 서버 코드는 손댈 게 없다(CF가 앞에서 거른다).
 *
 * ## 기준 표기
 *
 * 시세는 통합(_AL)이다. ⚠️ 마감 후 통합 현재가는 NXT 애프터 값이다(2026-08-21 실측) —
 * 그래서 응답에 venue(지금 어느 장인가)를 반드시 담고, 위젯이 그대로 표기한다.
 */

type Row = Record<string, unknown>;

const STKINFO_RESOURCE = "/api/dostk/stkinfo";

function toNum(v: unknown): number {
  const n = Number(String(v ?? "").replace(/[+,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** 지금 어느 장인가 — market.ts 의 venueNow 와 같은 규칙 (위젯 표기용) */
function venueNow(): string {
  const kst = new Date(Date.now() + 9 * 3600_000);
  const day = kst.getUTCDay();
  if (day === 0 || day === 6) return "마감";
  const m = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  if (m >= 8 * 60 && m < 8 * 60 + 50) return "NXT 프리마켓";
  if (m >= 8 * 60 + 50 && m < 9 * 60) return "장전 시간외";
  if (m >= 9 * 60 && m < 15 * 60 + 30) return "정규장";
  if (m >= 15 * 60 + 30 && m < 20 * 60) return "NXT 애프터마켓";
  return "마감";
}

export interface SummaryRow {
  code: string;
  name: string;
  price: number;
  change: number;
  changeRate: number;
  volume: number;
}

/** ka10095 통합(_AL) — 여러 종목 한 번에. 필드명은 kiwoomWatchlist 와 같은 실측값 */
async function quoteCodes(client: KiwoomClient, codes: string[]): Promise<SummaryRow[]> {
  const valid = [...new Set(codes.filter((c) => /^\d{6}$/.test(c)))];
  if (valid.length === 0) return [];
  const { data } = await client.request<Row>(STKINFO_RESOURCE, "ka10095", {
    stk_cd: valid.map((c) => `${c}_AL`).join("|"),
  });
  const rows = Array.isArray(data.atn_stk_infr) ? (data.atn_stk_infr as Row[]) : [];
  const byCode = new Map(
    rows.map((q) => {
      const code = String(q.stk_cd ?? "").replace(/_(AL|NX)$/i, "");
      return [
        code,
        {
          code,
          name: String(q.stk_nm ?? ""),
          price: Math.abs(toNum(q.cur_prc)),
          change: toNum(q.pred_pre),
          changeRate: toNum(q.flu_rt),
          volume: toNum(q.trde_qty),
        } satisfies SummaryRow,
      ];
    }),
  );
  // 관심종목에 적어 둔 순서 그대로 — 위젯 줄 순서가 매번 바뀌면 눈이 못 따라간다
  return valid.map((c) => byCode.get(c)).filter((r): r is SummaryRow => Boolean(r && r.price > 0));
}

/** 지수 셋 + 시장 신호등 — 위젯·워치 공통 머리 */
async function commonHead(client: KiwoomClient) {
  const [idxSec, sig] = await Promise.all([
    getSection("indices", client).catch(() => null),
    evaluateMarket(client).catch(() => null),
  ]);
  const indices = ((idxSec?.data ?? []) as IndexCard[]).slice(0, 3).map((i) => ({
    name: i.name,
    price: i.price,
    changeRate: i.changeRate,
  }));
  return {
    indices,
    signal: sig ? { level: sig.level, score: sig.score } : null,
  };
}

export function createSummaryRouter(client: KiwoomClient): Router {
  const router = Router();

  /** 위젯 설정(⚙)이 그룹 고르기에 쓴다 */
  router.get("/groups", async (_req, res, next) => {
    try {
      res.json({ groups: await listGroups() });
    } catch (err) {
      next(err);
    }
  });

  /**
   * 바탕화면 위젯 한 장 — 증권플러스 모양.
   * ?group= 으로 관심종목 그룹을 고른다(없으면 전체). 한 줄 = 다섯 칸
   * (종목명·현재가·대비·등락률·거래량) — 칸을 줄이는 건 위젯 쪽 몫이다.
   */
  router.get("/widget", async (req, res, next) => {
    try {
      const group = typeof req.query.group === "string" ? req.query.group : "";
      const items = (await listWatchlist()).filter((i) => !i.divider);
      const picked = group ? items.filter((i) => i.groups.includes(group)) : items;
      const rows = await quoteCodes(
        client,
        picked.slice(0, 30).map((i) => i.code),
      );
      const head = await commonHead(client);
      res.json({
        group: group || "관심종목 전체",
        at: new Date().toISOString(),
        venue: venueNow(),
        basis: "통합시세 기준",
        rows,
        ...head,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * 워치 한 장 — 네이버 증권 워치앱 모양.
   * 해외는 다른 세션(애프터/주간거래) 값까지 — 표기 규칙은 워치 쪽 usSession 몫.
   */
  router.get("/watch", async (_req, res, next) => {
    try {
      const items = (await listWatchlist()).filter((i) => !i.divider);
      const [rows, head, us] = await Promise.all([
        quoteCodes(
          client,
          items.slice(0, 8).map((i) => i.code),
        ),
        commonHead(client),
        evaluateGroups(false).catch(() => null),
      ]);
      const usRows = (us?.groups ?? [])
        .flatMap((g) => g.stocks)
        .slice(0, 12)
        .map((s) => ({
          symbol: s.symbol,
          name: s.name,
          price: s.price,
          changeRate: s.changeRate,
          marketState: s.marketState,
          afterPrice: s.afterPrice,
          afterChangeRate: s.afterChangeRate,
          dayPrice: s.dayPrice,
          dayChangeRate: s.dayChangeRate,
          dayVolume: s.dayVolume,
          currency: s.currency,
          flag: s.flag,
        }));
      res.json({
        at: new Date().toISOString(),
        venue: venueNow(),
        domestic: rows,
        us: usRows,
        ...head,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
