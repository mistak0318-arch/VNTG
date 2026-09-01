import { Router } from "express";
import { CATS, compressOldLogs, dataReport, pruneData, setKeepDays } from "../dataRetention.js";
import { ledgerStatus } from "../dailyStore.js";
import { collectProgress } from "../collectDaily.js";

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

  /**
   * **지난 로그 압축** (2026-09-01) — 지우기 전에 줄인다.
   *
   * 실시간 로그는 같은 JSON 키가 하루 40만 번 반복돼 압축이 4.2:1 로 듣는다.
   * 5년치가 88GB → 21GB 라, 「작게 오래 두기」가 「크게 짧게 두기」보다 낫다 —
   * 이 데이터는 키움이 지나간 것을 안 줘서 지우면 영영 못 받는다.
   */
  router.post("/compress", async (_req, res, next) => {
    try {
      const z = await compressOldLogs();
      res.json({ ...z, report: await dataReport() });
    } catch (err) {
      next(err);
    }
  });

  /**
   * **일별 원장 현황** (2026-09-01) — 며칠치가 쌓였나 · 한도까지 얼마나.
   *
   * 벤티지: "2년 되는날 나한테 알려줘 리셋할건지 백업할건지 말야."
   * 알림은 텔레그램으로 가지만, **눈으로 볼 데도 있어야** 한다.
   */
  router.get("/ledger", async (_req, res, next) => {
    try {
      res.json({ ledger: await ledgerStatus(), collect: collectProgress() });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
