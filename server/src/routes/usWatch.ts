import { Router } from "express";
import {
  addGroup,
  addStock,
  evaluateGroups,
  listGroups,
  quoteSymbol,
  removeGroup,
  removeStock,
  reorderGroups,
  searchUs,
  updateGroup,
  updateStock,
} from "../usWatchlist.js";

/** 미국 관심종목 */
export function createUsWatchRouter(): Router {
  const router = Router();

  router.get("/", async (_req, res, next) => {
    try {
      res.json({ groups: await evaluateGroups() });
    } catch (err) {
      next(err);
    }
  });

  /** 편집용 원본 (시세 없이) */
  router.get("/raw", async (_req, res, next) => {
    try {
      res.json({ groups: await listGroups() });
    } catch (err) {
      next(err);
    }
  });

  router.get("/search", async (req, res, next) => {
    try {
      res.json({ results: await searchUs(String(req.query.q ?? "")) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/quote/:symbol", async (req, res, next) => {
    try {
      res.json({ price: await quoteSymbol(req.params.symbol) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/groups", async (req, res, next) => {
    try {
      const name = String(req.body?.name ?? "").trim();
      if (!name) {
        res.status(400).json({ error: "그룹 이름이 필요합니다." });
        return;
      }
      await addGroup(name, String(req.body?.memo ?? ""));
      res.json({ groups: await evaluateGroups() });
    } catch (err) {
      next(err);
    }
  });

  router.patch("/groups/:id", async (req, res, next) => {
    try {
      await updateGroup(req.params.id, req.body ?? {});
      res.json({ groups: await evaluateGroups() });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/groups/:id", async (req, res, next) => {
    try {
      await removeGroup(req.params.id);
      res.json({ groups: await evaluateGroups() });
    } catch (err) {
      next(err);
    }
  });

  router.put("/groups/order", async (req, res, next) => {
    try {
      await reorderGroups(Array.isArray(req.body?.ids) ? req.body.ids.map(String) : []);
      res.json({ groups: await evaluateGroups() });
    } catch (err) {
      next(err);
    }
  });

  router.post("/groups/:id/stocks", async (req, res, next) => {
    try {
      const symbol = String(req.body?.symbol ?? "").trim();
      if (!symbol) {
        res.status(400).json({ error: "티커가 필요합니다." });
        return;
      }
      /*
       * 편입가를 안 주면 지금 가격으로 채운다. "담은 뒤로 얼마나 움직였나"를 재는 게
       * 목적이라 담은 순간의 가격이 기준으로 맞다.
       */
      const addedPrice =
        req.body?.addedPrice != null ? Number(req.body.addedPrice) : await quoteSymbol(symbol);
      await addStock(req.params.id, {
        symbol,
        name: String(req.body?.name ?? symbol),
        addedPrice,
        memo: String(req.body?.memo ?? ""),
      });
      res.json({ groups: await evaluateGroups() });
    } catch (err) {
      next(err);
    }
  });

  router.patch("/groups/:id/stocks/:symbol", async (req, res, next) => {
    try {
      await updateStock(req.params.id, req.params.symbol, req.body ?? {});
      res.json({ groups: await evaluateGroups() });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/groups/:id/stocks/:symbol", async (req, res, next) => {
    try {
      await removeStock(req.params.id, req.params.symbol);
      res.json({ groups: await evaluateGroups() });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
