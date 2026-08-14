import { Router } from "express";
import type { KiwoomClient } from "../kiwoomClient.js";
import { DEFAULT_LINKS, evaluateLinks, listLinks, saveLinks } from "../usKrLinks.js";

export function createUsKrRouter(client: KiwoomClient): Router {
  const router = Router();

  /** 미국 ↔ 국내를 나란히 */
  router.get("/", async (_req, res, next) => {
    try {
      res.json(await evaluateLinks(client));
    } catch (err) {
      next(err);
    }
  });

  /** 매핑 원본 (편집용) */
  router.get("/links", async (_req, res, next) => {
    try {
      res.json({ links: await listLinks(), defaults: DEFAULT_LINKS });
    } catch (err) {
      next(err);
    }
  });

  router.put("/links", async (req, res, next) => {
    try {
      res.json({ links: await saveLinks(req.body?.links) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
