import { Router } from "express";
import { getHistory, getUsage } from "../apiUsage.js";

export function createSettingsRouter(): Router {
  const router = Router();

  router.get("/usage", async (req, res, next) => {
    try {
      const day = typeof req.query.day === "string" ? req.query.day : undefined;
      res.json(await getUsage(day));
    } catch (err) {
      next(err);
    }
  });

  router.get("/usage/history", async (req, res, next) => {
    try {
      const days = Math.min(Number(req.query.days) || 14, 30);
      res.json({ history: await getHistory(days) });
    } catch (err) {
      next(err);
    }
  });

  /** 어떤 키가 설정되어 있는지만 알려준다 (값은 절대 내보내지 않음) */
  router.get("/keys", (_req, res) => {
    res.json({
      keys: [
        { name: "KIWOOM_APP_KEY", configured: Boolean(process.env.KIWOOM_APP_KEY) },
        { name: "KIWOOM_APP_SECRET", configured: Boolean(process.env.KIWOOM_APP_SECRET) },
        { name: "DART_API_KEY", configured: Boolean(process.env.DART_API_KEY) },
        { name: "NAVER_CLIENT_ID", configured: Boolean(process.env.NAVER_CLIENT_ID) },
        { name: "NAVER_CLIENT_SECRET", configured: Boolean(process.env.NAVER_CLIENT_SECRET) },
      ],
      isMock: process.env.KIWOOM_IS_MOCK === "true",
    });
  });

  return router;
}
