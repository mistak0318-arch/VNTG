import { Router } from "express";
import { searchChannels } from "../channelSearch.js";
import { buildChannelReport, listChannelReports } from "../channelReport.js";
import { pinnedHealth, pinnedPosts, type Edition } from "../pinnedChannel.js";
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
import { CHANNEL_STEPS, createJob, getJob, reporterFor } from "../reportProgress.js";

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
  /**
   * 곧바로 jobId 를 돌려주고 뒤에서 돈다.
   * 채널 200개를 읽는 동안 「발송 중…」만 떠 있어서 얼마나 기다려야 하는지 알 수 없었다.
   */
  router.post("/report", async (req, res, next) => {
    try {
      const useAi = req.query.ai !== "0";
      const send = req.query.send === "1";
      const sinceMinutes = Math.min(
        Math.max(Number(req.query.minutes) || Number(req.query.hours) * 60 || 60, 5),
        72 * 60,
      );
      const { id: jobId, job } = createJob(
        `${useAi ? "AI 정리" : "선별"}${send ? " + 발송" : ""}`,
        CHANNEL_STEPS,
        "channel",
      );
      const reporter = reporterFor(job);

      void buildChannelReport({ useAi, send, sinceMinutes, useOffsets: false, progress: reporter })
        .then((report) => {
          job.report = report;
          job.status = "done";
        })
        .catch((err: unknown) => {
          job.status = "error";
          job.error = err instanceof Error ? err.message : "실패";
          for (const s of job.steps) if (s.state === "running") s.state = "failed";
        });

      res.json({ jobId });
    } catch (err) {
      next(err);
    }
  });

  /** 진행 상황 폴링 — 리포트와 같은 job 저장소를 쓴다 */
  router.get("/report/:jobId", (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "작업을 찾을 수 없습니다 (서버 재시작 시 사라집니다)" });
      return;
    }
    res.json(job);
  });

  router.post("/report-sync", async (req, res, next) => {
    try {
      const report = await buildChannelReport({
        useAi: req.query.ai !== "0",
        send: req.query.send === "1",
        /*
         * 분 단위로 받는다. 텔레그램은 신속성이 무기인데 최소 단위가 1시간이면
         * "방금 뭐 돌았나"를 볼 수가 없다. 옛 hours 파라미터도 계속 받아 준다.
         */
        sinceMinutes: Math.min(
          Math.max(Number(req.query.minutes) || Number(req.query.hours) * 60 || 60, 5),
          72 * 60,
        ),
        useOffsets: false,
      });
      res.json(report);
    } catch (err) {
      next(err);
    }
  });

  /*
   * 고정 채널 원문. 선별·AI 를 거치지 않고 그대로 준다 —
   * 이미 사람이 정리해 둔 글을 다시 요약하면 정보만 잃는다.
   */
  router.get("/pinned", async (req, res, next) => {
    try {
      const e = String(req.query.edition ?? "morning");
      const edition = (["morning", "intraday", "closing", "weekend"] as const).includes(e as never)
        ? (e as Edition)
        : "morning";
      res.json({
        posts: await pinnedPosts(edition, Number(req.query.limit) || 3, req.query.force === "1"),
        /*
         * **어디서 막혔는지 같이 준다.**
         * 빈 배열만 주면 채널 미등록인지 세션이 끊긴 건지 그냥 글이 없는 건지
         * 화면에서 구분할 수가 없다 — 「계속 안 불러진다」는 말만 나온다.
         */
        health: pinnedHealth(),
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * 채널 **검색** — 「내 종목이 지금 어디서 언급되나」.
   *
   * 정리(digest)와 다른 물음이다. 정리는 채널 전체가 무슨 말을 하나이고, 이건
   * 종목 하나가 언급됐나다. 정리본에는 그 종목이 안 뽑혔을 수도 있다.
   *
   * `q` 는 쉼표로 여럿 — 한 종목이 「한화에어로」·「한화에어로스페이스」·「012450」처럼
   * 채널마다 다르게 불리기 때문이다. 하나라도 걸리면 나온다.
   */
  router.get("/search", async (req, res, next) => {
    try {
      const q = String(req.query.q ?? "")
        .split(",")
        .map((w) => w.trim())
        .filter(Boolean);
      const minutes = Math.min(Math.max(Number(req.query.minutes) || 720, 5), 4320);
      const limit = Math.min(Math.max(Number(req.query.limit) || 60, 5), 200);
      res.json(await searchChannels(q, minutes, limit));
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
