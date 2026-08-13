import { Router } from "express";
import { askMarket, isAskConfigured, type AskTurn } from "../askMarket.js";
import type { KiwoomClient } from "../kiwoomClient.js";

export function createAskRouter(client: KiwoomClient): Router {
  const router = Router();

  router.get("/status", (_req, res) => {
    res.json({ ready: isAskConfigured() });
  });

  router.post("/", async (req, res, next) => {
    try {
      const question = String(req.body?.question ?? "");
      const history = (req.body?.history ?? []) as AskTurn[];
      const useSearch = req.body?.useSearch !== false;
      const useMarketData = req.body?.useMarketData !== false;
      res.json(await askMarket(client, question, history, { useSearch, useMarketData }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
