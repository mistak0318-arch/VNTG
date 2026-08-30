import { Router } from "express";
import { CATS, dataReport, pruneData, setKeepDays } from "../dataRetention.js";

/** 데이터 보관 — 현황 보기 · 기간 정하기 · 지금 정리 (2026-08-31) */
export function createDataRouter(): Router {
  const router = Router();

  router.get("/", async (_req, res, next) => {
    try {
      res.json(await dataReport());
    } catch (err) {
      next(err);
    }
  });

  router.post("/:key/keep", async (req, res, next) => {
    try {
      const key = req.params.key;
      if (!CATS.some((c) => c.key === key)) return res.status(404).json({ error: "없는 항목" });
      const raw = req.body?.days;
      await setKeepDays(key, raw === null || raw === undefined || raw === "" ? null : Number(raw));
      res.json(await dataReport());
    } catch (err) {
      next(err);
    }
  });

  router.post("/prune", async (_req, res, next) => {
    try {
      const r = await pruneData();
      res.json({ ...r, report: await dataReport() });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
