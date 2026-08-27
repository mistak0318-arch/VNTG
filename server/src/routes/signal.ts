import { Router } from "express";
import {
  activeScreenJobs,
  diffScreenRuns,
  getScreenJob,
  getScreenRun,
  listScreenRuns,
  SCREEN_UNIVERSES,
  startScreen,
} from "../signalScreen.js";
import { evaluateMarket } from "../marketSignal.js";
import {
  exitSuperEntry,
  listSuperSignal,
  removeSuperEntry,
  runSuperSignal,
  superDetail,
  superJob,
  superRunStatus,
  updateSuperNote,
} from "../superSignal.js";
import { gradeSignalHistory, signalDays } from "../signalHistory.js";
import { themeSeriesFor } from "../themeSeries.js";
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
        /*
         * 한 번에 **50 개**까지. 화면이 한 쪽에 50 줄을 그리므로 그만큼은 받아야
         * 「40번째까지만 켜지고 그 뒤는 안 켜지는」 이상한 화면이 안 나온다.
         *
         * 상한 자체는 남겨 둔다 — 종목마다 차트·수급·재무를 받아 계산하는지라
         * 백 개를 한 번에 부르면 키움 초당 5회 제한에 걸리고 화면도 한참 멈춘다.
         * 더 보려면 **쪽을 넘겨** 그 쪽을 평가하는 쪽이 맞다.
         */
        .slice(0, 50);
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
   * 신호등 점수 축적 — 며칠치가 쌓였나.
   *
   * 추적기가 도는 자리에서 **문턱 아래까지 전부** 적는다(조회 0회 추가).
   * 「70점이 진짜 40점보다 나은가」는 떨어진 것도 있어야 물을 수 있다.
   */
  router.get("/history", async (_req, res, next) => {
    try {
      res.json({ days: await signalDays() });
    } catch (err) {
      next(err);
    }
  });

  /**
   * 채점 — 점수 구간별로 N거래일 뒤 어땠나.
   *
   * ⚠️ 종목당 일봉 한 번이라 몇 분 걸린다. 쌓인 날이 며칠 안 되면 표본이 적어
   * 숫자가 튄다 — 그건 화면이 적는다.
   */
  router.get("/history/grade", async (req, res, next) => {
    try {
      const days = Math.min(Math.max(Number(req.query.days) || 5, 1), 60);
      res.json({ grade: await gradeSignalHistory(client, days) });
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

  /** 고를 수 있는 모집단 — 화면이 버튼을 이걸로 그린다 (하드코딩하면 서버와 갈린다) */
  router.get("/screen/universes", (_req, res) => {
    res.json({ universes: SCREEN_UNIVERSES });
  });

  /** 지금 돌고 있는 찾기 — 전역 작업 띠와 화면 복귀가 본다 */
  router.get("/screen/active", (_req, res) => {
    res.json({ jobs: activeScreenJobs() });
  });

  router.post("/screen/start", (req, res, next) => {
    try {
      const id = startScreen(client, {
        market: typeof req.query.market === "string" ? req.query.market : undefined,
        minLevel: req.query.level === "yellow" ? "yellow" : "green",
        limit: Number(req.query.limit) || 100,
        universe: typeof req.query.universe === "string" ? req.query.universe : undefined,
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

  /* ---------------- 슈퍼신호등 ---------------- */

  /** 관찰 목록 — 지금 가격·편입가 대비까지 붙여서 */
  router.get("/super", async (_req, res, next) => {
    try {
      res.json(await listSuperSignal(client));
    } catch (err) {
      next(err);
    }
  });

  /** 진행 상황 — 돌고 있으면 화면이 진행바를 그린다 */
  router.get("/super/job", (_req, res) => {
    res.json(superJob());
  });

  /** 밤사이 버즈 — 채널 언급 급증 판정 결과 (장전 브리핑룸 카드가 읽는다) */
  router.get("/buzz", async (_req, res, next) => {
    try {
      const { evaluateBuzz } = await import("../buzzRadar.js");
      res.json(await evaluateBuzz());
    } catch (err) {
      next(err);
    }
  });

  /** 마지막 수집일만 — 사이드바 N 배지가 1분마다 물어본다(가볍게) */
  router.get("/super/status", async (_req, res, next) => {
    try {
      res.json(await superRunStatus());
    } catch (err) {
      next(err);
    }
  });

  /** 지금 돌리기 — 하루 한 번 자동(15:45)이지만 눈으로 확인하고 싶을 때 */
  router.post("/super/run", (_req, res) => {
    void runSuperSignal(client, true).catch(() => undefined);
    res.json(superJob());
  });

  router.delete("/super/:code", async (req, res, next) => {
    try {
      await removeSuperEntry(req.params.code);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  /* ---------------- 슈퍼신호등 대시보드 (2026-08-26) ---------------- */

  /**
   * 테마 지수 — **비교선 하나를 위해 따로 부른다** (2026-08-27).
   *
   * 상세(`/super/detail`) 응답에 안 싣는다. 테마엔 지수가 없어서 구성종목 일봉으로
   * 만들어야 하는데(최대 8콜), 그걸 기다리느라 종목 창이 늦게 열리면 안 된다.
   * 선 하나가 뒤늦게 그려지는 편이 낫다. 서버 캐시 6시간이라 대개는 즉답이다.
   */
  router.get("/super/theme/:code", async (req, res, next) => {
    try {
      res.json({ theme: await themeSeriesFor(client, req.params.code) });
    } catch (err) {
      next(err);
    }
  });

  /** 종목 하나의 흐름 — 주가·지수·수급·일별 점수. 클릭했을 때만 부른다 */
  router.get("/super/detail/:code", async (req, res, next) => {
    try {
      const d = await superDetail(client, req.params.code);
      if (!d) {
        res.status(404).json({ error: "슈퍼신호등 목록에 없는 종목입니다" });
        return;
      }
      res.json(d);
    } catch (err) {
      next(err);
    }
  });

  /** 수동 이탈 — 기록을 남기고 추적만 멈춘다 */
  router.post("/super/exit/:code", async (req, res, next) => {
    try {
      const note = String((req.body as { note?: string })?.note ?? "");
      const e = await exitSuperEntry(client, req.params.code, note);
      if (!e) {
        res.status(404).json({ error: "슈퍼신호등 목록에 없는 종목입니다" });
        return;
      }
      res.json({ ok: true, entry: e });
    } catch (err) {
      next(err);
    }
  });

  /** 자유 메모 */
  router.put("/super/note/:code", async (req, res, next) => {
    try {
      const note = String((req.body as { note?: string })?.note ?? "");
      const ok = await updateSuperNote(req.params.code, note);
      res.status(ok ? 200 : 404).json({ ok });
    } catch (err) {
      next(err);
    }
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
