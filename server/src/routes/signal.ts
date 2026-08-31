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
  getActiveSuper,
  listSuperSignal,
  removeSuperEntry,
  runSuperSignal,
  saveSuperConfig,
  superDetail,
  superJob,
  superRunStatus,
  updateSuperNote,
} from "../superSignal.js";
import { gradeSignalHistory, signalDays } from "../signalHistory.js";
import { etfSeriesFor, themeSeriesFor } from "../themeSeries.js";
import { backtestProgress, backtestResult, startBacktestJob } from "../signalBacktest.js";
import { samplesMeta } from "../signalSamples.js";
import { simulate, sweep } from "../signalSimulate.js";
import { tradeValueTop } from "../signalScreen.js";
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

  router.get("/screen/:jobId", async (req, res) => {
    const job = getScreenJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "없는 작업입니다 (서버가 재시작되면 사라집니다)." });
      return;
    }
    /*
     * 🌟 슈퍼신호등 소속 표시 (2026-08-28 — 「슈퍼인 애들은 표시만 더 해주고」).
     * 잡 안에서 붙이면 signalScreen→superSignal 순환 임포트가 되므로 여기서 얹는다.
     */
    const superCodes = await getActiveSuper()
      .then((l) => l.map((e) => e.code))
      .catch(() => [] as string[]);
    res.json({ ...job, superCodes });
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

  /**
   * 슈퍼신호등 문턱 설정 (2026-08-31) — 교집합 몇 곳, 무지개 며칠.
   *
   * 둘 다 「재고 있는 숫자」다. 성적표가 3곳/4곳/5곳과 하루/이틀/사흘을 각각
   * 재고 있으니, 며칠 쌓인 뒤 여기서 옮기면 된다.
   *
   * ⚠️ **문턱을 바꾸면 이미 쌓인 기록의 뜻이 달라진다** — 옛 편입은 옛 문턱으로
   * 걸린 것이다. 화면이 그 사실을 적는다.
   */
  router.put("/super/config", async (req, res, next) => {
    try {
      res.json({ config: await saveSuperConfig(req.body ?? {}) });
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

  /**
   * 버즈 대시보드 (2026-08-30) — **문턱과 무관하게 전부**.
   *
   * `/buzz` 는 「울릴 것」만 준다(알림용). 사람이 보는 화면은 문턱 아래도 봐야
   * 「지금 조용한 게 맞나」를 스스로 판단할 수 있다.
   */
  router.get("/buzz/board", async (req, res, next) => {
    try {
      const { buzzBoard } = await import("../buzzRadar.js");
      const h = Number(req.query.hours ?? 12);
      res.json(await buzzBoard(Number.isFinite(h) ? h : 12));
    } catch (err) {
      next(err);
    }
  });

  /**
   * 지금 시장의 화제 — 네 브리핑 화면이 **같은 문장**을 쓴다.
   * window: overnight(밤사이 12h) · now(3h) · today(6h)
   */
  router.get("/topic-pulse", async (req, res, next) => {
    try {
      const { topicPulse } = await import("../topicPulse.js");
      const w = String(req.query.window ?? "now");
      res.json(await topicPulse(w === "overnight" || w === "today" ? w : "now"));
    } catch (err) {
      next(err);
    }
  });

  /** 알고리즘 설정 — 버즈와 뉴스 키워드가 **같은 값**을 쓴다 */
  router.get("/buzz/config", async (_req, res, next) => {
    try {
      const { getBuzzConfig } = await import("../buzzScore.js");
      res.json(await getBuzzConfig());
    } catch (err) {
      next(err);
    }
  });

  router.put("/buzz/config", async (req, res, next) => {
    try {
      const { saveBuzzConfig } = await import("../buzzScore.js");
      res.json(await saveBuzzConfig(req.body ?? {}));
    } catch (err) {
      next(err);
    }
  });

  /** 낱말 하나의 속사정 — 언제 터졌나·어느 방이 말했나·실제 문장 */
  router.get("/buzz/term/:term", async (req, res, next) => {
    try {
      const { buzzTerm } = await import("../buzzRadar.js");
      const d = await buzzTerm(decodeURIComponent(req.params.term));
      /*
       * 주요 채널 아카이브에 **전문**이 있으면 그것으로 바꿔 준다 (2026-08-31).
       * 버즈가 들고 있는 조각은 수집 단계에서 이미 잘린 것이라 「원문 보기」로는 모자란다.
       */
      const { fullTextByLinks } = await import("../majorFeed.js");
      const full = await fullTextByLinks(d.samples.map((s) => s.link));
      d.samples = d.samples.map((s) => {
        const t = full.get(s.link);
        return t && t.length > s.text.length ? { ...s, text: t, full: true } : s;
      });
      res.json(d);
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

  /* ---------------- 신호등 백테스트 (2026-08-28) ---------------- */

  /**
   * 기준을 바꿔 가며 과거를 다시 매긴다.
   *
   * 설정은 **저장하지 않는다** — 조절해 보는 자리라 지금 쓰는 기준을 건드리면 안 된다.
   * 모집단은 거래대금 상위 N 종목이다: 실제로 살 수 있는 자리에서만 재야 뜻이 있다.
   */
  /*
   * **백그라운드로 돈다** (2026-08-28). 30초 넘게 요청을 붙잡고 있었고, 페이지를
   * 떠나면 결과를 잃었다. 시작 → 즉시 응답, 진행은 /progress, 결과는 /result.
   */
  router.post("/backtest", async (req, res, next) => {
    try {
      const body = req.body as {
        limit?: number;
        days?: number;
        config?: Partial<SignalConfig>;
        /** 수급까지 받을까 — 종목당 최대 6콜이 더 나간다(몇 배 느려진다). 기본 켬 */
        withFlow?: boolean;
      };
      /*
       * 표본 상한 500 (2026-08-31 — "샘플은 500개 기준으로"). 150 이었는데
       * 그 표본으로는 점수 구간별 성적이 톱니로 나왔다(80~89 가 70~79 보다
       * 훨씬 나쁨) — 구간마다 관측이 100~200개뿐이라 몇 종목의 등락에 휘둘린다.
       *
       * ⚠️ 500 이면 종목당 일봉 한 번씩이라 **몇 분** 걸린다. 화면이 진행률을 준다.
       */
      const limit = Math.min(Math.max(Number(body.limit) || 500, 5), 500);
      const top = await tradeValueTop(client, "000", limit);
      const codes = top.map((t) => ({ code: t.code, name: t.name }));
      res.json(
        startBacktestJob(client, {
          codes,
          days: body.days,
          config: body.config,
          withFlow: body.withFlow,
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  router.get("/backtest/progress", (_req, res) => {
    res.json(backtestProgress());
  });

  /** 마지막 결과 — 탭을 떠났다 돌아와도 그대로 있다 (메모리라 서버 재시작이면 없다) */
  router.get("/backtest/result", (_req, res) => {
    res.json(backtestResult());
  });

  /* ---------------- 시뮬레이터 (2026-08-31) ----------------
   *
   * 백테스트가 남긴 **원시값 창고**를 설정만 바꿔 다시 채점한다. API 를 안 부르므로
   * 즉답이다 — 문턱을 옮기며 성적을 보라고 만든 자리다.
   *
   * 창고는 백테스트를 한 번 돌리면 생긴다(그때 파일로 남는다). 그래서 시뮬레이터는
   * 서버가 재시작돼도 살아 있다 — 메모리에만 있는 백테스트 결과와 다른 점이다.
   */

  /** 창고에 무엇이 있나 — 화면이 「먼저 표본을 받으세요」를 띄울지 판단한다 */
  router.get("/samples", async (_req, res, next) => {
    try {
      res.json(await samplesMeta());
    } catch (err) {
      next(err);
    }
  });

  /**
   * 이 설정이면 성적이 어떻게 되나. `config` 를 안 주면 **지금 저장된 설정**을 잰다.
   */
  router.post("/simulate", async (req, res, next) => {
    try {
      const body = req.body as { config?: Partial<SignalConfig> };
      const saved = await getConfig();
      const cfg: SignalConfig = {
        ...saved,
        ...body.config,
        axisWeights: { ...saved.axisWeights, ...(body.config?.axisWeights ?? {}) },
        checks: body.config?.checks ?? saved.checks,
        maLines: body.config?.maLines ?? saved.maLines,
      };
      const r = await simulate(cfg);
      if (!r) {
        res.status(409).json({
          error: "표본이 아직 없습니다. 백테스트를 한 번 돌리면 표본이 만들어집니다.",
        });
        return;
      }
      res.json({ result: r });
    } catch (err) {
      next(err);
    }
  });

  /**
   * 전수 훑기 — 켤 수 있는 기준의 **모든 조합**을 돌린다.
   *
   * ⚠️ 표본을 날짜로 반 갈라 **뒤쪽 절반 성적으로 줄을 세운다.** 앞에서만 좋은
   * 조합은 그 기간에 맞춘 것이라, 그걸 「최적」이라 부르면 스스로를 속이게 된다.
   */
  router.post("/sweep", async (req, res, next) => {
    try {
      const body = req.body as { config?: Partial<SignalConfig>; top?: number };
      const saved = await getConfig();
      const cfg: SignalConfig = {
        ...saved,
        ...body.config,
        axisWeights: { ...saved.axisWeights, ...(body.config?.axisWeights ?? {}) },
        checks: body.config?.checks ?? saved.checks,
        maLines: body.config?.maLines ?? saved.maLines,
      };
      const r = await sweep(cfg, Math.min(Math.max(Number(body.top) || 25, 5), 100));
      if (!r) {
        res.status(409).json({ error: "표본이 아직 없습니다." });
        return;
      }
      res.json({ result: r });
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

  /** ETF 뒷배 비교선 — 뒷배 점수와 같은 규칙으로 고른 ETF 하나의 일봉 (6시간 캐시) */
  router.get("/super/etf/:code", async (req, res, next) => {
    try {
      res.json({ etf: await etfSeriesFor(client, req.params.code) });
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
