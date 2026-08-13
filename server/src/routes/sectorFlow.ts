import { Router } from "express";
import type { KiwoomClient } from "../kiwoomClient.js";
import {
  backfillSectorFlow,
  institutionSplits,
  listSectorFlow,
  sectorFlowStats,
  sectorStreaks,
  sizeRotation,
  SUBJECTS,
  SUBJECT_LABEL,
  type Subject,
} from "../sectorFlowStore.js";

export function createSectorFlowRouter(client: KiwoomClient): Router {
  const router = Router();

  /**
   * 업종별 자금 흐름.
   *
   * `subject` 로 주체를, `window` 로 누적 일수를 고른다.
   * 하루치는 노이즈라 기본은 5일이다.
   */
  router.get("/", async (req, res, next) => {
    try {
      const subject = (
        SUBJECTS.includes(req.query.subject as Subject) ? req.query.subject : "foreign"
      ) as Subject;
      const window = Math.min(Math.max(Number(req.query.window) || 5, 1), 60);

      // 순위 변화를 내려면 직전 기간도 필요해서 두 배를 읽는다
      const days = await listSectorFlow(window * 2 + 2);

      res.json({
        subject,
        subjectLabel: SUBJECT_LABEL[subject],
        window,
        dates: days.map((d) => d.date),
        stats: sectorFlowStats(days, subject, window),
        streaks: sectorStreaks(days, subject)
          .filter((s) => Math.abs(s.streak) >= 2)
          .slice(0, 12),
        splits: institutionSplits(days, window).slice(0, 8),
        sizes: sizeRotation(days, window),
        subjects: SUBJECTS.map((s) => ({ key: s, label: SUBJECT_LABEL[s] })),
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * 과거분 채우기.
   *
   * ka10051은 base_dt로 과거 조회가 되므로 시장 폭과 달리 소급이 가능하다.
   * 2시장 × N일이라 60일이면 120호출 — 초당 5회 제한 때문에 30초쯤 걸린다.
   */
  router.post("/backfill", async (req, res, next) => {
    try {
      const days = Math.min(Math.max(Number(req.query.days) || 60, 1), 250);
      res.json(await backfillSectorFlow(client, days));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
