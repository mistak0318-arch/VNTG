import { Router } from "express";
import {
  diffScreenRuns,
  getScreenJob,
  getScreenRun,
  listScreenRuns,
  startScreen,
} from "../signalScreen.js";
import { evaluateMarket } from "../marketSignal.js";
import type { KiwoomClient } from "../kiwoomClient.js";
import {
  DEFAULT_CONFIG,
  evaluateMany,
  evaluateSignal,
  getConfig,
  saveConfig,
  type SignalConfig,
} from "../signalLight.js";
import {
  getTrackConfig,
  saveTrackConfig,
  startEnroll,
  trackJob,
  trackSummary,
} from "../signalTrack.js";

export function createSignalRouter(client: KiwoomClient): Router {
  const router = Router();

  router.get("/config", async (_req, res, next) => {
    try {
      res.json({ config: await getConfig(), defaults: DEFAULT_CONFIG });
    } catch (err) {
      next(err);
    }
  });

  router.put("/config", async (req, res, next) => {
    try {
      res.json({ config: await saveConfig(req.body as SignalConfig) });
    } catch (err) {
      next(err);
    }
  });

  /** 여러 종목 한 번에 — 목록 화면에서 쓴다 */
  router.get("/batch", async (req, res, next) => {
    try {
      const codes = String(req.query.codes ?? "")
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean)
        .slice(0, 40); // 과도한 호출 방지
      res.json({ results: await evaluateMany(client, codes) });
    } catch (err) {
      next(err);
    }
  });

  /**
   * 시장 전체 신호등.
   * `/:code` 보다 **먼저** 등록해야 한다 — 아래 있으면 "market"이 종목코드로 먹힌다.
   */
  router.get("/market", async (req, res, next) => {
    try {
      res.json(await evaluateMarket(client, req.query.force === "1"));
    } catch (err) {
      next(err);
    }
  });

  /**
   * 스크리너 — 거래대금 상위에서 내 신호등 기준에 맞는 종목을 찾는다.
   * 종목당 여러 TR을 부르므로 job 방식으로 돌리고 진행 상황을 폴링한다.
   */
  /** 지난 스크리닝 회차 목록 — `/screen/:jobId` 보다 먼저 등록해야 한다 */
  router.get("/screen/runs", async (_req, res, next) => {
    try {
      res.json({ runs: await listScreenRuns() });
    } catch (err) {
      next(err);
    }
  });

  router.get("/screen/runs/:id", async (req, res, next) => {
    try {
      const run = await getScreenRun(req.params.id);
      if (!run) {
        res.status(404).json({ error: "그 회차 기록이 없습니다." });
        return;
      }
      res.json(run);
    } catch (err) {
      next(err);
    }
  });

  /** 두 회차 비교 — 새로 들어온 종목과 빠진 종목 */
  router.get("/screen/diff", async (req, res, next) => {
    try {
      const d = await diffScreenRuns(String(req.query.from ?? ""), String(req.query.to ?? ""));
      if (!d) {
        res.status(404).json({ error: "비교할 회차를 찾을 수 없습니다." });
        return;
      }
      res.json(d);
    } catch (err) {
      next(err);
    }
  });

  router.post("/screen/start", (req, res, next) => {
    try {
      const id = startScreen(client, {
        market: typeof req.query.market === "string" ? req.query.market : undefined,
        minLevel: req.query.level === "yellow" ? "yellow" : "green",
        limit: Number(req.query.limit) || 100,
      });
      res.json({ jobId: id });
    } catch (err) {
      next(err);
    }
  });

  router.get("/screen/:jobId", (req, res) => {
    const job = getScreenJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "없는 작업입니다 (서버가 재시작되면 사라집니다)." });
      return;
    }
    res.json(job);
  });

  /* ---------------- 추적기 ---------------- */

  router.get("/track", async (_req, res, next) => {
    try {
      res.json(await trackSummary());
    } catch (err) {
      next(err);
    }
  });

  /*
   * 손으로 돌리기. 평소엔 스케줄러가 15:40 에 알아서 하지만,
   * **처음 켰을 때 하루를 기다리게 하면 안 된다** — 눌러서 지금 담을 수 있어야 한다.
   *
   * 몇 분짜리 일이라 **붙들고 기다리지 않는다.** 시작만 시키고 진행 상황은 /track/job 으로 묻는다.
   */
  router.post("/track/run", (req, res) => {
    res.json(startEnroll(client, req.query.force === "1"));
  });

  /** 진행 상황 — 화면의 진행 막대가 이걸 읽는다 */
  router.get("/track/job", (_req, res) => {
    res.json(trackJob());
  });

  router.get("/track/config", async (_req, res, next) => {
    try {
      res.json(await getTrackConfig());
    } catch (err) {
      next(err);
    }
  });

  router.put("/track/config", async (req, res, next) => {
    try {
      res.json(await saveTrackConfig(req.body ?? {}));
    } catch (err) {
      next(err);
    }
  });

  /*
   * 종목 하나 평가 — **반드시 맨 끝이다.**
   *
   * `/:code` 는 한 칸짜리 주소를 전부 삼킨다. 이게 위에 있으면 `/track` 이 종목코드
   * 「track」으로 읽혀 추적기 목록이 신호등 판정으로 바뀐다. 실제로 그렇게 돼서
   * 추적기가 늘 비어 보였다 — 화면은 `entries` 가 없으니 조용히 「담긴 것 없음」을 그렸다.
   * 새 주소를 붙일 때는 **이 줄 위에** 붙일 것.
   */
  router.get("/:code", async (req, res, next) => {
    try {
      res.json(await evaluateSignal(client, req.params.code, req.query.force === "1"));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
