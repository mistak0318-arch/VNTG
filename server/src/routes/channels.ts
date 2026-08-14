import { Router } from "express";
import { buildChannelReport, listChannelReports } from "../channelReport.js";
import {
  DEFAULT_CONFIG,
  INTERVAL_CHOICES,
  getChannelConfig,
  saveChannelConfig,
} from "../channelConfig.js";
import { isMailConfigured } from "../mailer.js";
import {
  isReaderConfigured,
  listChannels,
  refreshChannels,
  setChannelEnabled,
} from "../telegramReader.js";

export function createChannelsRouter(): Router {
  const router = Router();

  /** 구독 채널 목록 + 세션 설정 여부 */
  router.get("/", async (_req, res, next) => {
    try {
      res.json({ configured: isReaderConfigured(), channels: await listChannels() });
    } catch (err) {
      next(err);
    }
  });

  /** 텔레그램에서 구독 목록을 다시 읽어온다 (기존 on/off 선택은 유지) */
  router.post("/refresh", async (_req, res, next) => {
    try {
      res.json({ channels: await refreshChannels() });
    } catch (err) {
      next(err);
    }
  });

  /** 수집 대상 on/off */
  router.put("/enabled", async (req, res, next) => {
    try {
      const updates = (req.body?.updates ?? []) as { id: string; enabled: boolean }[];
      res.json({ channels: await setChannelEnabled(updates) });
    } catch (err) {
      next(err);
    }
  });

  /**
   * 채널 정리 실행.
   * `?ai=0` 이면 AI를 호출하지 않고 필터 결과만 본다 — 비용 없이 선별 품질을 확인할 때.
   * `?send=1` 일 때만 텔레그램으로 보낸다.
   *
   * 여기로 들어오는 건 전부 사람이 버튼을 눌러 실행하는 경우다. 그래서 채널별 "읽은 위치"를
   * 무시하고 최근 N시간을 다시 훑는다 — 누른 시점의 최신을 보려는 것이지, 지난 실행 이후
   * 새로 온 것만 보려는 게 아니기 때문이다. 정기 발행(스케줄러)만 읽은 위치를 쓴다.
   */
  router.post("/report", async (req, res, next) => {
    try {
      const report = await buildChannelReport({
        useAi: req.query.ai !== "0",
        send: req.query.send === "1",
        sinceHours: Math.min(Math.max(Number(req.query.hours) || 12, 1), 72),
        useOffsets: false,
      });
      res.json(report);
    } catch (err) {
      next(err);
    }
  });

  router.get("/reports", async (req, res, next) => {
    try {
      res.json({ reports: await listChannelReports(Number(req.query.limit) || 10) });
    } catch (err) {
      next(err);
    }
  });

  /** 텔레그램 동향 설정 (AI 관리 · 선별 관리) */
  router.get("/config", async (_req, res, next) => {
    try {
      res.json({
        config: await getChannelConfig(),
        defaults: DEFAULT_CONFIG,
        intervals: INTERVAL_CHOICES,
        mailConfigured: isMailConfigured(),
      });
    } catch (err) {
      next(err);
    }
  });

  router.put("/config", async (req, res, next) => {
    try {
      res.json({ config: await saveChannelConfig(req.body) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
