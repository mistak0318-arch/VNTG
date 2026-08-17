import { Router } from "express";
import {
  INTERVAL_CHOICES,
  getConfig,
  resolveKeywords,
  runKeywordScan,
  saveConfig,
} from "../keywordAlert.js";

/** 내 관심 키워드 */
export function createKeywordRouter(): Router {
  const router = Router();

  router.get("/", async (_req, res, next) => {
    try {
      const config = await getConfig();
      res.json({ config, keywords: await resolveKeywords(config), intervals: INTERVAL_CHOICES });
    } catch (err) {
      next(err);
    }
  });

  router.put("/", async (req, res, next) => {
    try {
      const config = await saveConfig(req.body ?? {});
      res.json({ config, keywords: await resolveKeywords(config) });
    } catch (err) {
      next(err);
    }
  });

  /** 지금 한 번 돌린다. send=1 이면 실제로 보낸다 */
  router.post("/run", async (req, res, next) => {
    try {
      res.json(
        await runKeywordScan({
          send: req.query.send === "1",
          force: true,
          sinceMinutes: Number(req.query.minutes) || undefined,
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  return router;
}
