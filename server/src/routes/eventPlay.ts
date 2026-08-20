import { Router } from "express";
import type { KiwoomClient } from "../kiwoomClient.js";
import { listPlays, removePlay, savePlay, trackPlays } from "../eventPlay.js";

/**
 * 일정 매매.
 *
 * 목록·저장은 가볍지만 **추적은 종목마다 일봉을 받아 몇 십 초** 걸린다.
 * 그래서 따로 열어 둔다 — 화면이 목록을 그릴 때마다 그게 돌면 안 된다.
 */
export function createEventPlayRouter(client: KiwoomClient): Router {
  const router = Router();

  router.get("/", async (_req, res, next) => {
    try {
      res.json({ plays: await listPlays() });
    } catch (err) {
      next(err);
    }
  });

  router.get("/track", async (_req, res, next) => {
    try {
      res.json({ plays: await trackPlays(client) });
    } catch (err) {
      next(err);
    }
  });

  router.put("/", async (req, res, next) => {
    try {
      res.json({ plays: await savePlay(req.body ?? {}) });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:id", async (req, res, next) => {
    try {
      res.json({ plays: await removePlay(String(req.params.id)) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
