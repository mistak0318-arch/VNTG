import { Router } from "express";
import { TRADE_TARGETS, getTradeStats, isTradeConfigured } from "../tradeStats.js";

export function createTradeRouter(): Router {
  const router = Router();

  router.get("/", async (req, res, next) => {
    try {
      const r = await getTradeStats(req.query.force === "1");
      res.json({ ...r, configured: isTradeConfigured(), targets: TRADE_TARGETS });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
