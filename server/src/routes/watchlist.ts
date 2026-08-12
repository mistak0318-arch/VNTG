import { Router } from "express";
import type { KiwoomClient } from "../kiwoomClient.js";
import { getKiwoomGroupStocks, listKiwoomGroups } from "../kiwoomWatchlist.js";
import { getTrackedWatchlist, invalidateTrackingCache } from "../watchTracking.js";
import { addWatchItem, listWatchlist, removeWatchItem, updateWatchItem } from "../watchlist.js";

export function createWatchlistRouter(client: KiwoomClient): Router {
  const router = Router();

  router.get("/", async (_req, res, next) => {
    try {
      res.json({ items: await listWatchlist() });
    } catch (err) {
      next(err);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const { code, name, addedPrice, memo } = req.body ?? {};
      if (typeof code !== "string" || !code) {
        res.status(400).json({ error: "code는 필수입니다." });
        return;
      }
      const items = await addWatchItem({
        code,
        name: typeof name === "string" ? name : code,
        addedPrice: Number(addedPrice) || 0,
        memo: typeof memo === "string" ? memo : "",
      });
      invalidateTrackingCache();
      res.json({ items });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:code", async (req, res, next) => {
    try {
      const items = await removeWatchItem(req.params.code);
      invalidateTrackingCache();
      res.json({ items });
    } catch (err) {
      next(err);
    }
  });

  router.patch("/:code", async (req, res, next) => {
    try {
      const { memo, addedPrice } = req.body ?? {};
      const items = await updateWatchItem(req.params.code, {
        memo: typeof memo === "string" ? memo : undefined,
        addedPrice: addedPrice === undefined ? undefined : Number(addedPrice),
      });
      invalidateTrackingCache();
      res.json({ items });
    } catch (err) {
      next(err);
    }
  });

  // 키움 MTS/HTS에 등록된 관심종목 그룹 (읽기 전용)
  router.get("/kiwoom/groups", async (_req, res, next) => {
    try {
      res.json({ groups: await listKiwoomGroups(client) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/kiwoom/groups/:code", async (req, res, next) => {
    try {
      res.json({ items: await getKiwoomGroupStocks(client, req.params.code) });
    } catch (err) {
      next(err);
    }
  });

  // 마이페이지용 — 관심종목 + 수급/정배열 추적 지표
  router.get("/tracking", async (req, res, next) => {
    try {
      const force = req.query.force === "1";
      res.json({ items: await getTrackedWatchlist(client, force) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
