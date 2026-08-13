import { Router } from "express";
import {
  DEFAULT_AI_CONFIG,
  PURPOSE_LABEL,
  getAiConfig,
  saveAiConfig,
  type AiConfig,
} from "../aiConfig.js";
import { availableTextModels } from "../vision.js";

export function createAiRouter(): Router {
  const router = Router();

  router.get("/config", async (_req, res, next) => {
    try {
      res.json({
        config: await getAiConfig(),
        defaults: DEFAULT_AI_CONFIG,
        models: availableTextModels(),
        purposes: PURPOSE_LABEL,
        /** 아무것도 안 고르면 어디로 가는지 */
        fallback: process.env.ANTHROPIC_API_KEY?.trim()
          ? process.env.CLAUDE_MODEL?.trim() || "claude-sonnet-5"
          : null,
      });
    } catch (err) {
      next(err);
    }
  });

  router.put("/config", async (req, res, next) => {
    try {
      res.json({ config: await saveAiConfig(req.body as AiConfig) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
