import { Router } from "express";
import type { KiwoomClient } from "../kiwoomClient.js";
import { addTrade, closeTrade, evaluateTrades, removeTrade } from "../paperTrade.js";

/**
 * 모의투자.
 *
 * 조회 전용 원칙은 그대로다 — 여기서 실제 주문은 절대 나가지 않는다.
 * 저장하는 건 "내가 이때 이렇게 판단했다"는 기록일 뿐이다.
 */
export function createPaperRouter(client: KiwoomClient): Router {
  const router = Router();

  router.get("/", async (_req, res, next) => {
    try {
      res.json(await evaluateTrades(client));
    } catch (err) {
      next(err);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const code = String(req.body?.code ?? "").trim();
      const name = String(req.body?.name ?? "").trim();
      const entryPrice = Number(req.body?.entryPrice);
      const qty = Number(req.body?.qty);
      if (!code || !name || !Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(qty) || qty <= 0) {
        res.status(400).json({ error: "종목·매수가·수량이 필요합니다." });
        return;
      }
      await addTrade(client, { code, name, entryPrice, qty, thesis: String(req.body?.thesis ?? "") });
      res.json(await evaluateTrades(client));
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/close", async (req, res, next) => {
    try {
      const exitPrice = Number(req.body?.exitPrice);
      if (!Number.isFinite(exitPrice) || exitPrice <= 0) {
        res.status(400).json({ error: "청산가가 필요합니다." });
        return;
      }
      await closeTrade(req.params.id, exitPrice, String(req.body?.exitNote ?? ""));
      res.json(await evaluateTrades(client));
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:id", async (req, res, next) => {
    try {
      await removeTrade(req.params.id);
      res.json(await evaluateTrades(client));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
