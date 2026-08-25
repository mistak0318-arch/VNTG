import { Router } from "express";
import { getBacktestJob, RULES, startBacktest, type BacktestConfig } from "../backtest.js";
import type { KiwoomClient } from "../kiwoomClient.js";

/**
 * 조건 백테스트 라우트.
 *
 * 신호등 찾기와 같은 모양이다 — **시작만 시키고 진행은 따로 물어본다.**
 * 100종목이면 일봉 100회라 30초쯤 걸리는데, 붙들고 기다리면 프록시가 먼저 끊는다.
 */
export function createBacktestRouter(client: KiwoomClient): Router {
  const router = Router();

  router.get("/rules", (_req, res) => {
    res.json({ rules: RULES });
  });

  router.post("/run", (req, res, next) => {
    try {
      res.json(startBacktest(client, req.body as Partial<BacktestConfig>));
    } catch (err) {
      next(err);
    }
  });

  router.get("/job/:id", (req, res) => {
    const job = getBacktestJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: "그 백테스트를 못 찾았습니다 (서버가 다시 시작됐을 수 있습니다)" });
      return;
    }
    res.json(job);
  });

  return router;
}
