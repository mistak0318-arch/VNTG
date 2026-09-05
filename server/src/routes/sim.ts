import { Router } from "express";
import type { KiwoomClient } from "../kiwoomClient.js";
import { backtest } from "../simEngine.js";
import { draftRule, getRule, listRules, removeRule, upsertRule } from "../simRules.js";
import { SERIES } from "../simSeries.js";
import { advance, dropLive, liveResult, resetLive } from "../simLive.js";
import { analyze } from "../simAnalyze.js";

/**
 * /api/sim — 시뮬레이터 (2026-09-04).
 *
 * ⚠️ **여기서 실제 주문은 안 나간다.** 주문은 `/api/order` 하나뿐이고, 그쪽은 겹이
 * 일곱이다. 이 창구는 장부만 만진다 — 시뮬레이터가 주문을 낼 수 있으면 「규칙을
 * 만들어 두면 알아서 산다」가 되는데, 그건 이 도구가 하지 않기로 한 일이다.
 */
export function createSimRouter(client: KiwoomClient): Router {
  const router = Router();

  /** 고를 수 있는 바깥 변수 — 화면이 조건 만들기 칸을 이걸로 그린다 */
  router.get("/series", (_req, res) => {
    res.json({ series: SERIES });
  });

  router.get("/rules", async (_req, res, next) => {
    try {
      res.json({ rules: await listRules() });
    } catch (e) {
      next(e);
    }
  });

  router.put("/rules", async (req, res, next) => {
    try {
      res.json({ rule: await upsertRule(req.body ?? {}) });
    } catch (e) {
      next(e);
    }
  });

  router.delete("/rules/:id", async (req, res, next) => {
    try {
      const id = String(req.params.id);
      const ok = await removeRule(id);
      /* 장부도 같이 지운다 — 남겨 두면 다음 규칙이 남의 성적을 물려받는다 */
      await dropLive(id);
      res.json({ ok });
    } catch (e) {
      next(e);
    }
  });

  /** 실전 성적 — 규칙 하나. 아직 한 걸음도 안 갔으면 `result: null` */
  router.get("/live/:id", async (req, res, next) => {
    try {
      const rule = await getRule(String(req.params.id));
      if (!rule) {
        res.status(404).json({ error: "규칙을 못 찾았습니다" });
        return;
      }
      res.json({ result: await liveResult(rule) });
    } catch (e) {
      next(e);
    }
  });

  /** 지금 한 걸음 — 스케줄러를 기다리지 않고 손으로 */
  router.post("/live/:id/step", async (req, res, next) => {
    try {
      const rule = await getRule(String(req.params.id));
      if (!rule) {
        res.status(404).json({ error: "규칙을 못 찾았습니다" });
        return;
      }
      const steps = await advance(client, rule);
      res.json({ steps, result: await liveResult(rule) });
    } catch (e) {
      next(e);
    }
  });

  /** 처음부터 다시 — 규칙을 고쳤으면 옛 장부는 다른 규칙의 성적이다 */
  router.post("/live/:id/reset", async (req, res, next) => {
    try {
      await resetLive(String(req.params.id));
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  /**
   * 백테스트 — 저장된 일봉으로 과거를 다시 산다.
   * 규칙을 저장하지 않고도 돌릴 수 있게 **본문으로 받은 규칙**도 받는다(만들다 말고 시험).
   */
  router.post("/backtest", async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as { id?: string; days?: number; rule?: unknown };
      /* 저장된 규칙이거나, 아직 저장 안 한 초안이거나 — 초안은 **창고에 안 넣는다** */
      const rule = body.id ? await getRule(String(body.id)) : draftRule((body.rule ?? {}) as object);
      if (!rule) {
        res.status(404).json({ error: "규칙을 못 찾았습니다" });
        return;
      }
      const days = Number.isFinite(Number(body.days)) ? Number(body.days) : 250;
      res.json({ rule, result: await backtest(client, rule, days) });
    } catch (e) {
      next(e);
    }
  });

  /**
   * **상세 분석** (2026-09-05) — 요약이 답하지 않는 둘: 「어떤 조건이 무엇을 했나」와
   * 「언제 벌고 언제 잃었나」.
   *
   * 조건을 하나씩 빼고 다시 돌리므로 조회가 아니라 **계산**이 는다. 일봉은 이미 창고에
   * 있고 바깥 변수는 캐시라, 조건 열두 개짜리 규칙이어도 조회는 그대로다.
   */
  router.post("/analyze", async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as { id?: string; days?: number; rule?: unknown };
      const rule = body.id ? await getRule(String(body.id)) : draftRule((body.rule ?? {}) as object);
      if (!rule) {
        res.status(404).json({ error: "규칙을 못 찾았습니다" });
        return;
      }
      const days = Number.isFinite(Number(body.days)) ? Number(body.days) : 250;
      res.json({ analysis: await analyze(client, rule, days) });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
