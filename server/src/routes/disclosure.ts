import { Router } from "express";
import {
  INTERVAL_CHOICES,
  getConfig,
  runDisclosureScan,
  saveConfig,
} from "../disclosureAlert.js";
import { chatIdFor, isTelegramConfigured } from "../telegram.js";

/** 관심종목 공시 알림 */
export function createDisclosureRouter(): Router {
  const router = Router();

  router.get("/", async (_req, res, next) => {
    try {
      res.json({
        config: await getConfig(),
        intervals: INTERVAL_CHOICES,
        // 방이 설정돼 있는지 화면에서 바로 보이게 — 안 되어 있으면 켜도 안 간다
        telegramReady: isTelegramConfigured("disclosure"),
        chatId: chatIdFor("disclosure") ? "설정됨" : "",
      });
    } catch (err) {
      next(err);
    }
  });

  router.put("/", async (req, res, next) => {
    try {
      res.json({ config: await saveConfig(req.body ?? {}) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/run", async (req, res, next) => {
    try {
      res.json(await runDisclosureScan({ send: req.query.send === "1", force: true }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
