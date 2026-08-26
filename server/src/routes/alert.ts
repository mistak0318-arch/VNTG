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
import { formatLiveAlerts, runLiveAlerts } from "../liveAlerts.js";
import { formatStopBreaks, runStopWatch } from "../stopWatch.js";
import { isTelegramConfigured, sendTelegram, telegramChannelStatus, telegramEnvRooms, type TelegramChannel } from "../telegram.js";
import { readRooms, saveRooms, type RoomStore } from "../telegramRooms.js";

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

  /* ── 텔레그램 방 재배정 (2026-08-26) — 화면에서 갈래별 보내는 방 바꾸기 ── */

  router.get("/telegram-rooms", (_req, res) => {
    res.json({
      channels: telegramChannelStatus(),
      envRooms: telegramEnvRooms(),
      store: readRooms(),
    });
  });

  router.put("/telegram-rooms", (req, res, next) => {
    try {
      const body = req.body as Partial<RoomStore>;
      const saved = saveRooms({ assign: body.assign ?? {}, custom: body.custom ?? [] });
      res.json({ store: saved, channels: telegramChannelStatus() });
    } catch (err) {
      next(err);
    }
  });

  /** 지정한 갈래로 시험 발송 — 방 배정이 맞는지 그 자리에서 확인 */
  router.post("/telegram-rooms/test/:channel", async (req, res, next) => {
    try {
      const ch = req.params.channel as TelegramChannel;
      if (!isTelegramConfigured(ch)) {
        res.json({ ok: false, error: "이 갈래로 보낼 방이 없습니다 (키 미설정)" });
        return;
      }
      const r = await sendTelegram(
        `🔧 VNTG 방 배정 시험 — 「${ch}」 갈래가 이 방으로 옵니다`,
        ch,
      );
      res.json(r);
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
      /*
       * VI·체결강도는 다른 길로 도는데(실시간·1분), **미리보기에는 같이 보여준다** —
       * 「지금 검사」를 눌렀는데 절반만 나오면 나머지가 꺼진 줄 안다.
       * `send:false` 라 상태를 안 남기므로 진짜 알림을 잡아먹지 않는다.
       */
      const live = await runLiveAlerts({ send: false }).catch(() => null);
      res.json({
        ...result,
        live: live ? { count: live.alerts.length, connected: live.live } : null,
        preview:
          [
            result.alerts.length > 0 ? formatAlerts(result.alerts) : "",
            live && live.alerts.length > 0 ? formatLiveAlerts(live.alerts) : "",
          ]
            .filter(Boolean)
            .join("\n\n") || "",
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * 손절 감시 지금 상태.
   *
   * **보내지 않는다.** 「내가 지금 몇 자리를 들고 있고 그중 몇 자리에 손절선을
   * 적어 뒀나」를 보는 창이다. 손절선이 없는 자리가 몇인지가 실은 제일 중요한 숫자다 —
   * 그만큼은 **감시할 수가 없다.**
   */
  router.get("/stop-watch", async (_req, res, next) => {
    try {
      const r = await runStopWatch(client, { send: false });
      res.json({
        ...r,
        /* 손절선을 안 적어 감시 못 하는 자리 수 */
        unwatched: r.positions - r.watched,
        preview: r.breaks.length > 0 ? formatStopBreaks(r.breaks) : "",
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
