import { Router } from "express";
import type { KiwoomClient } from "../kiwoomClient.js";
import { TRADE_TARGETS, getTradeStats, isTradeConfigured } from "../tradeStats.js";
import { listAllThemes, relatedStocks } from "../tradeStocks.js";
import { findSectorByName } from "../sectorMood.js";

export function createTradeRouter(client: KiwoomClient): Router {
  const router = Router();

  router.get("/", async (req, res, next) => {
    try {
      const r = await getTradeStats(req.query.force === "1");
      res.json({ ...r, configured: isTradeConfigured(), targets: TRADE_TARGETS });
    } catch (err) {
      next(err);
    }
  });

  /**
   * 품목의 관련 종목.
   * 목록과 분리한 이유: 31품목의 종목을 한꺼번에 받으면 첫 조회가 훨씬 느려진다.
   * 사용자가 품목을 펼칠 때만 부른다.
   */
  router.get("/:key/stocks", async (req, res, next) => {
    try {
      const t = TRADE_TARGETS.find((x) => x.key === req.params.key);
      if (!t) throw new Error("알 수 없는 품목입니다.");
      const sector = await findSectorByName(client, t.sectors[0]).catch(() => null);
      res.json(await relatedStocks(client, t.themes ?? [], sector));
    } catch (err) {
      next(err);
    }
  });

  /** 어떤 테마가 있는지 확인용 */
  router.get("/themes/all", async (_req, res, next) => {
    try {
      res.json({ themes: await listAllThemes(client) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
