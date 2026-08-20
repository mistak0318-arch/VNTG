import { Router } from "express";
import type { KiwoomClient } from "../kiwoomClient.js";
import { marketPulse, pulseBrief } from "../marketPulse.js";
import { getLeaderConfig, leaderScan, saveLeaderConfig } from "../leaderScan.js";
import { leaderTrack } from "../leaderTrack.js";

/**
 * 시장 맥박.
 *
 * 숫자와 AI 판독을 **따로** 연다. 숫자는 1분 캐시라 자주 열어도 되지만
 * AI 는 돈이 나가므로 화면이 원할 때만 부르게 한다 — 한 요청으로 묶으면
 * 화면을 열 때마다 요약이 돌게 된다.
 */
export function createPulseRouter(client: KiwoomClient): Router {
  const router = Router();

  router.get("/", async (req, res, next) => {
    try {
      res.json(await marketPulse(client, req.query.force === "1"));
    } catch (err) {
      next(err);
    }
  });

  router.get("/brief", async (req, res, next) => {
    try {
      res.json(await pulseBrief(client, req.query.force === "1"));
    } catch (err) {
      next(err);
    }
  });

  /*
   * 주도주 탐색기.
   *
   * 뉴스는 **따로 끈다.** 섹터마다 네이버를 부르므로, 화면을 열 때마다 돌면
   * 하루 할당량이 금방 녹는다. 숫자만 볼 때는 `news=0` 으로 부른다.
   */
  router.get("/leaders", async (req, res, next) => {
    try {
      res.json(await leaderScan(client, { withNews: req.query.news !== "0" }));
    } catch (err) {
      next(err);
    }
  });

  /*
   * 성적 — **`/leaders/config` 보다 위든 아래든 상관없지만 `/leaders` 뒤여야 한다.**
   * 종목마다 일봉을 받아 몇 십 초 걸리므로 화면이 눌렀을 때만 부른다.
   */
  router.get("/leaders/track", async (_req, res, next) => {
    try {
      res.json(await leaderTrack(client));
    } catch (err) {
      next(err);
    }
  });

  router.get("/leaders/config", async (_req, res, next) => {
    try {
      res.json(await getLeaderConfig());
    } catch (err) {
      next(err);
    }
  });

  router.put("/leaders/config", async (req, res, next) => {
    try {
      res.json(await saveLeaderConfig(req.body ?? {}));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
