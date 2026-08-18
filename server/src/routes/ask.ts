import { Router } from "express";
import { askMarket, isAskConfigured, type AskTurn } from "../askMarket.js";
import type { KiwoomClient } from "../kiwoomClient.js";
import { addAsk, listAsk, removeAsk } from "../askHistory.js";

export function createAskRouter(client: KiwoomClient): Router {
  const router = Router();

  router.get("/status", (_req, res) => {
    res.json({ ready: isAskConfigured() });
  });

  router.get("/history", async (req, res, next) => {
    try {
      res.json({ items: await listAsk(Number(req.query.limit) || 100) });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/history/:id", async (req, res, next) => {
    try {
      await removeAsk(req.params.id);
      res.json({ items: await listAsk() });
    } catch (err) {
      next(err);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const question = String(req.body?.question ?? "");
      const history = (req.body?.history ?? []) as AskTurn[];
      const useSearch = req.body?.useSearch !== false;
      const useMarketData = req.body?.useMarketData !== false;
      const r = await askMarket(client, question, history, { useSearch, useMarketData });
      /*
       * 물어본 것은 남긴다. 두 달 뒤 같은 일이 벌어졌을 때 그때 내가 무엇을 몰랐는지
       * 보이는 게 답 자체보다 값어치가 있다. 기록에 실패해도 답은 돌려준다.
       */
      await addAsk({
        question,
        answer: r.text,
        model: r.model,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        searches: r.searches,
        sources: r.sources,
        error: r.error,
      }).catch(() => undefined);
      res.json(r);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
