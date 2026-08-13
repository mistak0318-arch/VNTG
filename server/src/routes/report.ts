import { Router } from "express";
import type { KiwoomClient } from "../kiwoomClient.js";

import { buildMarketDrivers } from "../reportBuilder.js";
import { deliverReport } from "../reportDelivery.js";
import { publishEdition } from "../reportScheduler.js";
import { EDITIONS, latestEdition, listReports, loadReport, type EditionKey } from "../reportStore.js";

/**
 * 리포트 전용 라우트.
 * 웹 화면·메일·텔레그램이 모두 이 응답을 그대로 쓴다.
 */
export function createReportRouter(client: KiwoomClient): Router {
  const router = Router();

  /** 오늘 시장을 움직인 것 — 강한 테마·업종과 그 이유(관련 뉴스) */
  router.get("/drivers", async (req, res, next) => {
    try {
      const topN = Math.min(Number(req.query.top) || 5, 15);
      res.json(await buildMarketDrivers(client, { topN }));
    } catch (err) {
      next(err);
    }
  });

  /**
   * 발행된 리포트 조회. 화면은 **저장된 것만** 읽는다 (여기서 AI를 부르지 않는다).
   * 파라미터 없으면 지금 시점의 최신 판.
   */
  router.get("/published", async (req, res, next) => {
    try {
      const latest = latestEdition();
      const date = typeof req.query.date === "string" ? req.query.date : latest.date;
      const edition = (typeof req.query.edition === "string" ? req.query.edition : latest.edition) as EditionKey;

      const report = await loadReport(date, edition);
      res.json({
        report,
        requested: { date, edition },
        editions: EDITIONS,
        recent: await listReports(20),
      });
    } catch (err) {
      next(err);
    }
  });

  /** 수동 발행 — 아직 발행 시각이 안 됐거나 실패했을 때 쓴다 */
  router.post("/publish", async (req, res, next) => {
    try {
      const edition = (String(req.body?.edition ?? latestEdition().edition)) as EditionKey;
      res.json({ report: await publishEdition(client, edition) });
    } catch (err) {
      next(err);
    }
  });

  /** 저장된 리포트를 다시 보낸다 (AI 재호출 없음 → 비용 0) */
  router.post("/deliver", async (req, res, next) => {
    try {
      const latest = latestEdition();
      const date = String(req.body?.date ?? latest.date);
      const edition = String(req.body?.edition ?? latest.edition) as EditionKey;
      const report = await loadReport(date, edition);
      if (!report) {
        res.status(404).json({ error: "해당 판이 아직 발행되지 않았습니다." });
        return;
      }
      res.json(await deliverReport(report));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
