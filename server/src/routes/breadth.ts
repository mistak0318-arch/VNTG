import { Router } from "express";
import { captureBreadth, describeBreadth, listBreadth, toPoints } from "../breadthStore.js";
import type { KiwoomClient } from "../kiwoomClient.js";

export function createBreadthRouter(client: KiwoomClient): Router {
  const router = Router();

  /** 누적된 시장 폭 — 기본 60일 */
  router.get("/", async (req, res, next) => {
    try {
      const days = Math.min(Math.max(Number(req.query.days) || 60, 1), 500);
      const rows = await listBreadth(days);
      const points = toPoints(rows);
      res.json({
        days: rows.length,
        points,
        summary: describeBreadth(points),
        raw: req.query.raw === "1" ? rows : undefined,
      });
    } catch (err) {
      next(err);
    }
  });

  /** 지금 한 번 찍기 — 스케줄러를 기다리지 않고 수동으로 */
  router.post("/capture", async (req, res, next) => {
    try {
      res.json(await captureBreadth(client, { force: req.query.force === "1" }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
