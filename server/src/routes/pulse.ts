import { Router } from "express";
import type { KiwoomClient } from "../kiwoomClient.js";
import { marketPulse, pulseBrief } from "../marketPulse.js";

/**
 * 시장 맥박.
 *
 * 숫자와 AI 판독을 **따로** 연다. 숫자는 1분 캐시라 자주 열어도 되지만
 * AI 는 돈이 나가므로 화면이 원할 때만 부르게 한다 — 한 요청으로 묶으면
 * 화면을 열 때마다 요약이 돌게 된다.
 */
export function createPulseRouter(client: KiwoomClient): Router {
  const router = Router();

  router.get("/", async (req, res, next) => {
    try {
      res.json(await marketPulse(client, req.query.force === "1"));
    } catch (err) {
      next(err);
    }
  });

  router.get("/brief", async (req, res, next) => {
    try {
      res.json(await pulseBrief(client, req.query.force === "1"));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
