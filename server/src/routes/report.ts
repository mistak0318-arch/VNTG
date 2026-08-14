import { Router } from "express";
import type { KiwoomClient } from "../kiwoomClient.js";

import { buildMarketDrivers } from "../reportBuilder.js";
import { deliverReport } from "../reportDelivery.js";
import { publishAdhoc, publishEdition } from "../reportScheduler.js";
import { listReviewable, reviewReport } from "../reportReview.js";
import {
  DEFAULT_SCHEDULE,
  currentSlot,
  getSchedule,
  saveSchedule,
} from "../reportSchedule.js";
import { latestEdition, listReports, loadReport, type EditionKey } from "../reportStore.js";
import { createJob, getJob, reporterFor } from "../reportProgress.js";

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
        editions: (await getSchedule()).slots,
        recent: await listReports(20),
      });
    } catch (err) {
      next(err);
    }
  });

  /** 수동 발행 — 아직 발행 시각이 안 됐거나 실패했을 때 쓴다 */
  router.post("/publish", async (req, res, next) => {
    try {
      const schedule = await getSchedule();
      const fallback = currentSlot(schedule, new Date())?.id ?? "midday";
      const edition = String(req.body?.edition ?? fallback);
      // 정기 발행분을 손으로 다시 만드는 것이므로 전송 여부는 그 판의 설정을 따른다
      const slot = schedule.slots.find((s) => s.id === edition);
      res.json({ report: await publishEdition(client, edition, undefined, slot?.deliver ?? false) });
    } catch (err) {
      next(err);
    }
  });

  /**
   * 즉시 발행 — 지금 이 순간의 시장을 바로 본다.
   *
   * 정기 판과 파일을 다투면 안 되므로 `now-HHMM` 이라는 별도 id로 저장한다.
   * 조간을 눌러놓고 오후에 즉시발행을 하면 조간 파일이 오후 내용으로 덮여버리기 때문이다.
   * 시각에 따라 프롬프트(kind)를 자동으로 고른다 — 장 전이면 개장 전 브리핑이 맞다.
   */
  router.post("/publish-now", async (req, res, next) => {
    try {
      const now = new Date();
      const day = now.getDay();
      const mins = now.getHours() * 60 + now.getMinutes();
      const kind =
        day === 0 || day === 6
          ? "weekend"
          : mins < 9 * 60
            ? "morning"
            : mins < 15 * 60 + 40
              ? "intraday"
              : "closing";

      const id = `now-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
      const label = `즉시 ${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")}`;
      const deliver = req.body?.deliver === true;

      /*
       * 곧바로 jobId 를 돌려주고 뒤에서 돈다.
       *
       * 예전엔 이 POST 하나가 1~3분을 물고 있어서 화면이 아무것도 못 보여줬다 —
       * 멈춘 건지 도는 건지 알 수가 없었다. 스크리너·알고리즘 스캔과 같은 방식으로 맞춘다.
       */
      const { id: jobId, job } = createJob(label);
      const reporter = reporterFor(job);

      void publishAdhoc(client, { id, label, kind, deliver }, reporter)
        .then((report) => {
          job.report = report;
          job.status = "done";
        })
        .catch((err: unknown) => {
          job.status = "error";
          job.error = err instanceof Error ? err.message : "발행 실패";
          // 돌던 단계를 실패로 닫아야 화면이 영영 "진행 중"으로 남지 않는다
          for (const s of job.steps) if (s.state === "running") s.state = "failed";
        });

      res.json({ jobId });
    } catch (err) {
      next(err);
    }
  });

  /** 발행 진행 상황 폴링 */
  router.get("/publish/:jobId", (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "작업을 찾을 수 없습니다 (서버 재시작 시 사라집니다)" });
      return;
    }
    res.json(job);
  });

  /**
   * 복기 — 지난 리포트의 체크포인트를 실제 결과와 대조한다.
   * 채점은 기계가 하므로 AI 비용이 없다.
   */
  router.get("/reviewable", async (_req, res, next) => {
    try {
      res.json({ reports: await listReviewable(30) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/review", async (req, res, next) => {
    try {
      const date = String(req.query.date ?? "");
      const edition = String(req.query.edition ?? "");
      if (!date || !edition) {
        res.status(400).json({ error: "date 와 edition 이 필요합니다." });
        return;
      }
      res.json({ result: await reviewReport(client, date, edition) });
    } catch (err) {
      next(err);
    }
  });

  /** 발행 일정 설정 */
  router.get("/schedule", async (_req, res, next) => {
    try {
      res.json({ schedule: await getSchedule(), defaults: DEFAULT_SCHEDULE });
    } catch (err) {
      next(err);
    }
  });

  router.put("/schedule", async (req, res, next) => {
    try {
      res.json({ schedule: await saveSchedule(req.body) });
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
