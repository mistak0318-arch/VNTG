import { Router } from "express";
import { DEFAULT_ALGO_CONFIG, getAlgoJob, normalizeConfig, startAlgoScan } from "../algoScan.js";
import type { KiwoomClient } from "../kiwoomClient.js";

export function createAlgoRouter(client: KiwoomClient): Router {
  const router = Router();

  router.get("/config/default", (_req, res) => {
    res.json(DEFAULT_ALGO_CONFIG);
  });

  router.post("/scan/start", (req, res) => {
    const config = normalizeConfig(req.body);
    const jobId = startAlgoScan(client, config);
    res.json({ jobId, config });
  });

  router.get("/scan/status/:jobId", (req, res) => {
    const job = getAlgoJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "존재하지 않는 작업입니다." });
      return;
    }
    res.json(job);
  });

  return router;
}
