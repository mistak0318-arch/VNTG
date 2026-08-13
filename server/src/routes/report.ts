import { Router } from "express";
import type { KiwoomClient } from "../kiwoomClient.js";
import { getAiSummary } from "../aiSummary.js";
import { buildMarketDrivers } from "../reportBuilder.js";

/**
 * 리포트 전용 라우트.
 * 웹 화면·메일·텔레그램이 모두 이 응답을 그대로 쓴다.
 */
export function createReportRouter(client: KiwoomClient): Router {
  const router = Router();

  /** 오늘 시장을 움직인 것 — 강한 테마·업종과 그 이유(관련 뉴스) */
  router.get("/drivers", async (req, res, next) => {
    try {
      const topN = Math.min(Number(req.query.top) || 5, 15);
      res.json(await buildMarketDrivers(client, { topN }));
    } catch (err) {
      next(err);
    }
  });

  /** AI 시장 정리 — 리포트 최상단. 10분 캐싱되고 force=1로 강제 갱신 */
  router.get("/ai-summary", async (req, res, next) => {
    try {
      res.json(await getAiSummary(client, { force: req.query.force === "1" }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
