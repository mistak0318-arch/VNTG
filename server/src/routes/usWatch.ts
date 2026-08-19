import { Router } from "express";
import {
  addGroup,
  addStock,
  evaluateGroups,
  invalidateUsCache,
  reorderCachedGroup,
  listGroups,
  quoteSymbol,
  removeGroup,
  removeStock,
  reorderGroups,
  reorderStocks,
  searchUs,
  updateGroup,
  updateStock,
} from "../usWatchlist.js";

/** 미국 관심종목 */
export function createUsWatchRouter(): Router {
  const router = Router();

  router.get("/", async (req, res, next) => {
    try {
      res.json(await evaluateGroups(req.query.force === "1"));
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
      // 방금 고쳤으니 캐시를 버린다 — 안 그러면 담은 종목이 한동안 안 뜬다
      invalidateUsCache();
      res.json(await evaluateGroups());
    } catch (err) {
      next(err);
    }
  });

  router.patch("/groups/:id", async (req, res, next) => {
    try {
      await updateGroup(req.params.id, req.body ?? {});
      // 방금 고쳤으니 캐시를 버린다 — 안 그러면 담은 종목이 한동안 안 뜬다
      invalidateUsCache();
      res.json(await evaluateGroups());
    } catch (err) {
      next(err);
    }
  });

  router.delete("/groups/:id", async (req, res, next) => {
    try {
      await removeGroup(req.params.id);
      // 방금 고쳤으니 캐시를 버린다 — 안 그러면 담은 종목이 한동안 안 뜬다
      invalidateUsCache();
      res.json(await evaluateGroups());
    } catch (err) {
      next(err);
    }
  });

  router.put("/groups/order", async (req, res, next) => {
    try {
      await reorderGroups(Array.isArray(req.body?.ids) ? req.body.ids.map(String) : []);
      // 방금 고쳤으니 캐시를 버린다 — 안 그러면 담은 종목이 한동안 안 뜬다
      invalidateUsCache();
      res.json(await evaluateGroups());
    } catch (err) {
      next(err);
    }
  });

  router.put("/groups/:id/stocks/order", async (req, res, next) => {
    try {
      const symbols = Array.isArray(req.body?.symbols) ? req.body.symbols.map(String) : [];
      await reorderStocks(req.params.id, symbols);
      /*
       * **캐시를 버리지 않는다.** 순서를 바꾼다고 가격이 변하지는 않는다.
       * 버리면 164종목 시세를 다시 받느라 ▲ 한 번에 6~8초가 걸린다 —
       * 손에 있는 값의 줄 순서만 고쳐 주면 즉시 끝난다.
       */
      await reorderCachedGroup(req.params.id, symbols);
      res.json(await evaluateGroups());
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
      // 방금 고쳤으니 캐시를 버린다 — 안 그러면 담은 종목이 한동안 안 뜬다
      invalidateUsCache();
      res.json(await evaluateGroups());
    } catch (err) {
      next(err);
    }
  });

  router.patch("/groups/:id/stocks/:symbol", async (req, res, next) => {
    try {
      await updateStock(req.params.id, req.params.symbol, req.body ?? {});
      // 방금 고쳤으니 캐시를 버린다 — 안 그러면 담은 종목이 한동안 안 뜬다
      invalidateUsCache();
      res.json(await evaluateGroups());
    } catch (err) {
      next(err);
    }
  });

  router.delete("/groups/:id/stocks/:symbol", async (req, res, next) => {
    try {
      await removeStock(req.params.id, req.params.symbol);
      // 방금 고쳤으니 캐시를 버린다 — 안 그러면 담은 종목이 한동안 안 뜬다
      invalidateUsCache();
      res.json(await evaluateGroups());
    } catch (err) {
      next(err);
    }
  });

  return router;
}
