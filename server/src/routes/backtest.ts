import { Router } from "express";
import {
  getBacktestJob,
  listBacktestRuns,
  RULES,
  startBacktest,
  verdictOf,
  type BacktestConfig,
} from "../backtest.js";
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

  /**
   * 돌려 본 조건들 — **엣지 순 리더보드.**
   * 통찰은 실행 하나가 아니라 실행들 사이의 비교에서 나온다. 한 줄 판정까지 붙인다.
   */
  router.get("/runs", async (_req, res, next) => {
    try {
      const runs = await listBacktestRuns();
      res.json({
        runs: runs.map((r) => ({ ...r, verdict: verdictOf(r.edge, r.hit.count) })),
      });
    } catch (err) {
      next(err);
    }
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
