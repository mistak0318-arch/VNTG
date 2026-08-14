import { Router } from "express";
import type { KiwoomClient } from "../kiwoomClient.js";
import { getSectorStocks } from "../marketOverview.js";
import {
  backfillSectorFlow,
  CONSENSUS_LABELS,
  institutionSplits,
  sectorConsensus,
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
        // 여러 주체가 같은 방향으로 움직인 업종 — 매수 합의와 매도 합의를 나눠서
        consensusBuy: sectorConsensus(days, { window, minAgree: 3, side: 1 }).slice(0, 8),
        consensusSell: sectorConsensus(days, { window, minAgree: 3, side: -1 }).slice(0, 8),
        consensusSubjects: CONSENSUS_LABELS,
        sizes: sizeRotation(days, window),
        subjects: SUBJECTS.map((s) => ({ key: s, label: SUBJECT_LABEL[s] })),
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * 업종 구성종목.
   *
   * "화학에 외국인이 3,244억 들어왔다"를 보고 나면 곧바로 **그래서 어느 종목이냐**가 궁금해진다.
   * 그때 다른 화면으로 옮겨가게 만들면 흐름이 끊기므로 같은 자리에서 펼쳐 보게 한다.
   * 펼칠 때만 부르므로 화면을 열었다고 호출이 늘지는 않는다.
   */
  router.get("/stocks", async (req, res, next) => {
    try {
      const market = req.query.market === "kosdaq" ? "kosdaq" : "kospi";
      const code = String(req.query.code ?? "").trim();
      if (!code) {
        res.status(400).json({ error: "업종코드(code)가 필요합니다." });
        return;
      }
      const rows = await getSectorStocks(client, market, code);
      /*
       * 등락률 높은 순 — 그 업종을 무엇이 끌었는지가 먼저 보여야 한다.
       * 다만 장 시작 전에는 전 종목 등락률이 0으로 오므로 그때는 정렬이 무의미해진다.
       * 그래서 시가총액을 2순위로 둔다 — 최소한 큰 종목부터 보이게.
       */
      const stocks = [...rows]
        .sort((a, b) => b.changeRate - a.changeRate || (b.marketCap ?? 0) - (a.marketCap ?? 0))
        .slice(0, 30);
      // 전 종목이 0이면 아직 거래 전이라는 뜻 — 화면에서 그렇게 말해줘야 오해가 없다
      res.json({ stocks, beforeTrading: stocks.every((s) => s.changeRate === 0) });
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
