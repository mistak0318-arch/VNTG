import { Router } from "express";
import {
  DEFAULT_AI_CONFIG,
  PURPOSE_LABEL,
  getAiConfig,
  saveAiConfig,
  type AiConfig,
} from "../aiConfig.js";
import { availableTextModels, generateText } from "../vision.js";

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

  /**
   * **모델 점검** (2026-09-07) — 목록의 모델을 하나씩 실제로 불러 본다.
   *
   * 벤티지: "AI API 모델 리스트 최신화 되어 있나?" — 안 돼 있었고, 더 나쁜 건 죽은 모델
   * (`gemini-2.5-flash`, 404)이 목록에 산 것처럼 남아 있던 것이다. 목록은 사람이 고치는
   * 것이라 또 낡는다. 그래서 **목록을 믿지 말고 불러 보게** 한다 — 모델마다 한 줄짜리
   * 프롬프트(출력 상한 5토큰)라 전부 합쳐도 몇 원이다.
   *
   * 셋을 동시에 보낸다(제공자별로 다른 서버). 한 모델이 20초 안에 답을 안 하면 그것만 실패로.
   */
  router.post("/check", async (_req, res, next) => {
    try {
      const models = availableTextModels();
      const results = await Promise.all(
        models.map(async (m) => {
          const t0 = Date.now();
          try {
            const r = await Promise.race([
              generateText("OK 라고만 답해.", 5, m.provider, m.model, "other"),
              new Promise<never>((_, rej) => setTimeout(() => rej(new Error("20초 응답 없음")), 20_000)),
            ]);
            return {
              model: m.model,
              provider: m.provider,
              ok: r.text !== null && !r.error,
              ms: Date.now() - t0,
              error: r.error ?? null,
            };
          } catch (e) {
            return {
              model: m.model,
              provider: m.provider,
              ok: false,
              ms: Date.now() - t0,
              error: e instanceof Error ? e.message : "실패",
            };
          }
        }),
      );
      res.json({ results, at: new Date().toISOString() });
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
