import { Router } from "express";
import { getFinance } from "../dartFinance.js";
import { getDisclosures, newsCounts, searchNews } from "../newsDisclosure.js";

export function createNewsRouter(): Router {
  const router = Router();

  // 뉴스 검색 — 종목명이나 임의 키워드
  router.get("/news", async (req, res, next) => {
    try {
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      if (!q) {
        res.status(400).json({ error: "검색어(q)가 필요합니다." });
        return;
      }
      const limit = Math.min(Number(req.query.display) || 30, 100);
      // scope=all 이면 전체, 기본은 주요 언론사만
      const majorOnly = req.query.scope !== "all";
      const [items, counts] = await Promise.all([
        searchNews(q, { majorOnly, limit }),
        newsCounts(q),
      ]);
      res.json({ items, counts });
    } catch (err) {
      next(err);
    }
  });

  // 종목 공시 (DART)
  router.get("/disclosures/:code", async (req, res, next) => {
    try {
      const days = Math.min(Number(req.query.days) || 180, 365);
      res.json({ items: await getDisclosures(req.params.code, days) });
    } catch (err) {
      next(err);
    }
  });

  // 재무제표 3년치 + 배당 (DART)
  router.get("/finance/:code", async (req, res, next) => {
    try {
      res.json(await getFinance(req.params.code));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
