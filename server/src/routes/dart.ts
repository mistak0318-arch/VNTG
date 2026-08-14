import { Router } from "express";
import { todayDartEvents } from "../dartEvents.js";

/** 오늘 공시 — 내 종목 것부터 */
export function createDartRouter(): Router {
  const router = Router();

  router.get("/today", async (req, res, next) => {
    try {
      res.json(await todayDartEvents(req.query.force === "1"));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
