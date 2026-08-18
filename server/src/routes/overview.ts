import { Router } from "express";
import type { KiwoomClient } from "../kiwoomClient.js";
import { flowIntradayDates, listFlowIntraday } from "../flowIntraday.js";
import {
  getProgramTrades,
  getSection,
  getSectorStocks,
  getThemeStocks,
  SECTION_NAMES,
  type SectionName,
} from "../marketOverview.js";

/** 장 상태 판정 (한국 시간 기준, 공휴일은 판별하지 않음) */
function marketStatus(): { state: "pre" | "open" | "closed" | "holiday"; label: string } {
  const now = new Date();
  const day = now.getDay();
  if (day === 0 || day === 6) return { state: "holiday", label: "휴장" };

  const minutes = now.getHours() * 60 + now.getMinutes();
  if (minutes < 9 * 60) return { state: "pre", label: "장전" };
  if (minutes <= 15 * 60 + 30) return { state: "open", label: "장중" };
  return { state: "closed", label: "장마감" };
}

export function createOverviewRouter(client: KiwoomClient): Router {
  const router = Router();

  router.get("/status", (_req, res) => {
    res.json(marketStatus());
  });

  // 섹션별 개별 조회 — 한 섹션이 실패해도 다른 섹션에 영향 없음
  router.get("/section/:name", async (req, res) => {
    const name = req.params.name as SectionName;
    if (!SECTION_NAMES.includes(name)) {
      res.status(404).json({ error: `알 수 없는 섹션: ${name}` });
      return;
    }
    try {
      const result = await getSection(name, client);
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : "알 수 없는 오류" });
    }
  });

  /*
   * 장중 수급 변화. 하루 누적 숫자만 보면 오전에 팔다 오후에 산 날과
   * 하루 종일 판 날이 똑같이 생긴다.
   */
  router.get("/flow-intraday", async (req, res, next) => {
    try {
      const date = typeof req.query.date === "string" ? req.query.date : undefined;
      res.json({ day: await listFlowIntraday(date), dates: await flowIntradayDates() });
    } catch (err) {
      next(err);
    }
  });

  // 프로그램 매매 (차익/비차익)
  router.get("/program/:market/:scope", async (req, res, next) => {
    try {
      const market = req.params.market === "kosdaq" ? "kosdaq" : "kospi";
      const scope = req.params.scope === "daily" ? "daily" : "time";
      res.json({ items: await getProgramTrades(client, market, scope) });
    } catch (err) {
      next(err);
    }
  });

  // 테마 구성종목
  router.get("/theme/:code/stocks", async (req, res, next) => {
    try {
      res.json({ items: await getThemeStocks(client, req.params.code) });
    } catch (err) {
      next(err);
    }
  });

  // 업종 구성종목
  router.get("/sector/:market/:code/stocks", async (req, res, next) => {
    try {
      const market = req.params.market === "kosdaq" ? "kosdaq" : "kospi";
      res.json({ items: await getSectorStocks(client, market, req.params.code) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
