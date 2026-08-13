import { Router } from "express";
import {
  DEFAULT_ALERT_CONFIG,
  formatAlerts,
  getAlertConfig,
  saveAlertConfig,
  type AlertConfig,
} from "../alertRules.js";
import { runAlertScan } from "../alertScheduler.js";
import type { KiwoomClient } from "../kiwoomClient.js";
import { telegramChannelStatus } from "../telegram.js";

export function createAlertRouter(client: KiwoomClient): Router {
  const router = Router();

  router.get("/config", async (_req, res, next) => {
    try {
      res.json({
        config: await getAlertConfig(),
        defaults: DEFAULT_ALERT_CONFIG,
        channels: telegramChannelStatus(),
      });
    } catch (err) {
      next(err);
    }
  });

  router.put("/config", async (req, res, next) => {
    try {
      res.json({ config: await saveAlertConfig(req.body as AlertConfig) });
    } catch (err) {
      next(err);
    }
  });

  /**
   * 지금 검사.
   * 기본은 미리보기(dryRun) — 상태를 남기지 않으므로 진짜 알림을 잡아먹지 않는다.
   * `?send=1` 을 붙였을 때만 실제로 텔레그램으로 보낸다.
   */
  router.post("/scan", async (req, res, next) => {
    try {
      const send = req.query.send === "1";
      const result = await runAlertScan(client, { dryRun: !send, send });
      res.json({
        ...result,
        preview: result.alerts.length > 0 ? formatAlerts(result.alerts) : "",
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
