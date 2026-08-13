import { Router } from "express";
import { getHistory, getUsage } from "../apiUsage.js";
import { summarize } from "../summarize.js";

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
        { name: "ANTHROPIC_API_KEY", configured: Boolean(process.env.ANTHROPIC_API_KEY) },
        { name: "TELEGRAM_BOT_TOKEN", configured: Boolean(process.env.TELEGRAM_BOT_TOKEN) },
        { name: "TELEGRAM_CHAT_ID", configured: Boolean(process.env.TELEGRAM_CHAT_ID) },
        { name: "NAVER_MAIL_USER", configured: Boolean(process.env.NAVER_MAIL_USER) },
        { name: "NAVER_MAIL_PASS", configured: Boolean(process.env.NAVER_MAIL_PASS) },
      ],
      isMock: process.env.KIWOOM_IS_MOCK === "true",
    });
  });

  /** Claude 연결 테스트 — 실제 호출이라 토큰 사용량에도 반영된다 */
  router.post("/claude/test", async (_req, res, next) => {
    try {
      const r = await summarize("'연결 성공'이라고만 답해줘.", 50);
      res.json({ ok: r.text !== null, ...r });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
