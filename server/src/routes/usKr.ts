import { Router } from "express";
import type { KiwoomClient } from "../kiwoomClient.js";
import { DEFAULT_LINKS, evaluateLinks, listLinks, saveLinks } from "../usKrLinks.js";
import { computeCorrelations, loadCorrelations } from "../usKrCorrelation.js";

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

  /** 저장된 상관계수 (계산은 무거우므로 화면은 이걸 읽는다) */
  router.get("/correlation", async (_req, res, next) => {
    try {
      res.json({ result: await loadCorrelations() });
    } catch (err) {
      next(err);
    }
  });

  /**
   * 상관계수 다시 계산.
   * 테마 구성종목 일봉을 전부 받아야 해서 136종목 기준 30초쯤 걸린다.
   * 하루에 한 번이면 충분하므로 사용자가 누를 때만 돈다.
   */
  router.post("/correlation", async (req, res, next) => {
    try {
      const days = Math.min(Math.max(Number(req.query.days) || 60, 20), 250);
      res.json({ result: await computeCorrelations(client, days) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
