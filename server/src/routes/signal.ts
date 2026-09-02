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
import { buildSamplesFromLedger, ledgerSamplesProgress } from "../samplesFromLedger.js";
import { resetSignalLedgers } from "../ledgerReset.js";
import {
  exitListEntry,
  listTrackDetail,
  listTrackJob,
  listTrackSummary,
  removeListEntry,
  runListTrack,
  updateListNote,
} from "../listTrack.js";
import {
  buildVerdict,
  conditional,
  loadVerdict,
  simulate,
  superSim,
  sweep,
} from "../signalSimulate.js";
import {
  getCondJob,
  listPresets,
  removePreset,
  linesOf,
  savePreset,
  startCondSearch,
  type CondQuery,
} from "../condSearch.js";
import { COND_FIELDS } from "../condFields.js";
import { allStocksUniverse } from "../allStocks.js";
import { afterCloseStatus, runAfterClose } from "../afterClose.js";
import {
  enabledUniverses,
  getUniverseConfig,
  saveUniverseConfig,
  type UniverseConfig,
} from "../universeConfig.js";
import { collectProgress, startCollectDaily } from "../collectDaily.js";
import { LEDGER_KINDS, ledgerStatus, type LedgerKind } from "../dailyStore.js";
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
      const saved = await saveConfig(req.body as SignalConfig);
      /*
       * 판정을 **같이 다시 낸다** (2026-09-01). 기준이 바뀌면 「55점부터 값을
       * 한다」도 바뀌는데, 안 갱신하면 **낡은 판정이 새 설정인 척** 화면에 남는다.
       * 파일만 읽어 채점하므로 조회 0회에 수십 밀리초다.
       */
      void buildVerdict(saved).catch(() => undefined);
      res.json({ config: saved });
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

  /**
   * 고를 수 있는 모집단 — 화면이 버튼을 이걸로 그린다 (하드코딩하면 서버와 갈린다).
   *
   * **켠 것만** 준다 (2026-09-01). 벤티지: "신호등에 넣을 수 있는 그룹을 내가
   * 고르는 거고, 고르고 나면 신호등 찾기에서 그게 보이는 거지."
   *
   * 카탈로그 전체는 `/screen/universes/all` 이 준다 — 설정 화면이 그걸로 그린다.
   */
  router.get("/screen/universes", async (_req, res, next) => {
    try {
      res.json({ universes: await enabledUniverses() });
    } catch (err) {
      next(err);
    }
  });

  /** 카탈로그 전체 + 지금 선택 — 설정 화면용 */
  router.get("/screen/universes/all", async (_req, res, next) => {
    try {
      res.json({ catalog: SCREEN_UNIVERSES, config: await getUniverseConfig() });
    } catch (err) {
      next(err);
    }
  });

  router.put("/screen/universes/all", async (req, res, next) => {
    try {
      res.json({ config: await saveUniverseConfig(req.body as Partial<UniverseConfig>) });
    } catch (err) {
      next(err);
    }
  });

  /**
   * **전종목 사전훑기 미리보기** (2026-09-01) — 조회 0회.
   *
   * 「전종목」 모집단을 고르면 2,400여 종목 중 어떤 후보가 올라오는지 **돌려 보기
   * 전에** 보여 준다. 찾기를 걸면 후보마다 수급·재무 조회가 나가므로, 무엇이
   * 뽑혔는지 모르는 채로 몇 분을 기다리게 하면 안 된다.
   *
   * ⚠️ 여기 점수는 **일봉으로 낼 수 있는 기준만**으로 낸 사전 점수다. 수급·재무는
   * 전부 빠져 있어 추세가 좋은 종목이 위로 온다. 「좋은 종목」이 아니라 「본격적으로
   * 볼 만한 후보」다 — 화면이 그 말을 그대로 적는다.
   *
   * `/screen/:jobId` 보다 먼저 등록해야 한다.
   */
  router.get("/screen/preview", async (req, res, next) => {
    try {
      const market = ["000", "001", "101"].includes(String(req.query.market))
        ? String(req.query.market)
        : "000";
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 10), 500);
      const minValue = Math.max(Number(req.query.minValue) || 10, 0);
      res.json(await allStocksUniverse(client, market, limit, minValue));
    } catch (err) {
      next(err);
    }
  });

  /**
   * **전종목 일별 수집** (2026-09-01) — 종목당 5콜, 한 바퀴 약 41분.
   *
   * 벤티지: "지금 로직상에 수집하는 모든것 전종목 기준으로 데이터 다 받아."
   *
   * ⚠️ 장중에는 그날 값이 미확정이라 마감 뒤에 도는 것이 맞다. 다만 막지는
   * 않는다 — 이어 붙이므로 다음 바퀴에 그날 값이 확정본으로 덮인다.
   */
  router.post("/collect/daily", (req, res) => {
    const b = req.body as { kinds?: string[]; back?: number; codes?: string[] };
    const kinds = (Array.isArray(b?.kinds) ? b.kinds : []).filter((k): k is LedgerKind =>
      (LEDGER_KINDS as string[]).includes(k),
    );
    void startCollectDaily(
      client,
      kinds.length > 0 ? kinds : undefined,
      Math.min(Math.max(Number(b?.back) || 120, 5), 400),
      Array.isArray(b?.codes) && b.codes.length > 0 ? b.codes.slice(0, 50) : undefined,
    );
    res.json({ started: true, progress: collectProgress() });
  });

  router.get("/collect/daily", (_req, res) => {
    res.json({ progress: collectProgress() });
  });

  /** 얼마나 쌓였나 · 한도에 얼마나 왔나 — 「2년 되는 날 알려줘」가 여기서 나온다 */
  router.get("/collect/status", async (_req, res, next) => {
    try {
      res.json(await ledgerStatus());
    } catch (err) {
      next(err);
    }
  });

  /**
   * **마감 뒤 파이프라인** (2026-09-01) — 손으로 돌린다.
   *
   * 벤티지: "1번과 2번을 내가 수동으로도 시작할 수 있지? 지금 한 번 돌리게."
   *
   * `steps` 를 주면 그 단계만 돈다. 안 주면 전부 — 일봉 → 원장 → 장세 →
   * 추적기 → 슈퍼신호등 → 신호등 분석 → 표본 순서다.
   *
   * ⚠️ 응답을 기다리지 않는다. 전체가 두 시간 남짓이라 HTTP 로 붙들고 있을 수
   * 없다 — 진행은 `GET` 으로 본다.
   */
  router.post("/after-close", (req, res) => {
    const b = req.body as { steps?: string[] };
    const steps = Array.isArray(b?.steps) ? b.steps.filter((x) => typeof x === "string") : undefined;
    void runAfterClose(client, true, steps, "손으로 눌렀다").catch(() => undefined);
    res.json({ started: true, steps: steps ?? "전체", status: afterCloseStatus() });
  });

  router.get("/after-close", (_req, res) => {
    res.json({ status: afterCloseStatus() });
  });

  /** 지금 돌고 있는 찾기 — 전역 작업 띠와 화면 복귀가 본다 */
  router.get("/screen/active", (_req, res) => {
    res.json({ jobs: activeScreenJobs() });
  });

  /*
   * 조건 검색 (2026-09-01) — 증권사 조건검색식처럼 신호등 기준을 통과/미달로 쓴다.
   *
   * 신호등이 **점수**라면 이건 **이분법**이다. 점수는 한두 기준이 나빠도 나머지가
   * 좋으면 걸리는데, 그래서 「정배열인 것만」을 못 고른다 — 점수 안에 묻힌다.
   */
  router.post("/cond/start", async (req, res, next) => {
    try {
      const b = req.body as Partial<CondQuery>;
      /* 옛 형식(그룹)으로 와도 받는다 — 저장해 둔 조건식이 죽지 않게 */
      const lines = Array.isArray(b.lines) ? b.lines : linesOf(b as CondQuery);
      if (lines.length === 0) {
        res.status(400).json({ error: "조건을 하나 이상 넣어야 합니다" });
        return;
      }
      const id = startCondSearch(client, {
        universe: String(b.universe ?? "trade-value"),
        /* 기간 — 목록이 열어 둔 값만 통과한다(`fetchUniverse` 가 거른다) */
        span: Number(b.span) > 0 ? Number(b.span) : undefined,
        market: ["000", "001", "101"].includes(String(b.market)) ? String(b.market) : "000",
        limit: Math.min(Math.max(Number(b.limit) || 200, 20), 500),
        capMin: typeof b.capMin === "number" ? b.capMin : null,
        capMax: typeof b.capMax === "number" ? b.capMax : null,
        lines,
      });
      res.json({ jobId: id });
    } catch (err) {
      next(err);
    }
  });

  /*
   * ⚠️ **`/cond/:id` 보다 먼저 둔다.** 뒤에 두면 "presets" 를 작업 id 로 먹어
   * 404 가 난다 — express 는 먼저 걸리는 쪽을 쓴다.
   */
  /**
   * **조건 필드 사전** (2026-09-01) — 이름 · 단위 · 뜻 · 쓸 만한 값.
   *
   * 예전엔 화면이 신호등 기준 목록을 그대로 깔았다. 그래서 「덩치 (클수록 안
   * 움직인다)」 같은 것이 조건 이름으로 나왔고, **단위를 아무 데서도 말해 주지
   * 않아** 「덩치 ≥ 3000」이 3천억인지 3천만원인지 알 수 없었다.
   *
   * ⚠️ `/cond/:id` 보다 먼저 둔다 — 뒤에 두면 "fields" 를 작업 id 로 먹는다.
   */
  router.get("/cond/fields", (_req, res) => {
    res.json({ fields: COND_FIELDS });
  });

  router.get("/cond/presets", async (_req, res, next) => {
    try {
      res.json({ presets: await listPresets() });
    } catch (err) {
      next(err);
    }
  });

  router.post("/cond/presets", async (req, res, next) => {
    try {
      const b = req.body as { name?: string; query?: CondQuery };
      if (!b?.name || !b?.query) {
        res.status(400).json({ error: "이름과 조건식이 필요합니다" });
        return;
      }
      res.json({ presets: await savePreset(b.name, b.query) });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/cond/presets/:id", async (req, res, next) => {
    try {
      res.json({ presets: await removePreset(req.params.id) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/cond/:id", (req, res) => {
    const job = getCondJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: "없는 작업입니다" });
      return;
    }
    res.json(job);
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

  /* ---------------- 신호등 분석 (목록별 추적) ---------------- */

  /**
   * 목록별 원장 — **슈퍼신호등과 나란히 놓고 견주려고 만든 것.**
   *
   * 편입·이탈 규칙이 슈퍼신호등과 **똑같다.** 그래야 두 원장의 차이가
   * 「교집합을 봤나 안 봤나」 하나로 좁혀진다.
   */
  router.get("/list-track", async (_req, res, next) => {
    try {
      res.json(await listTrackSummary());
    } catch (err) {
      next(err);
    }
  });

  router.get("/list-track/job", (_req, res) => {
    res.json(listTrackJob());
  });

  /** 지금 돌리기 — 백그라운드로 돈다(40분쯤). 화면은 진행률을 폴링한다 */
  router.post("/list-track/run", (req, res, next) => {
    try {
      const body = req.body as { limit?: number; force?: boolean } | undefined;
      if (listTrackJob().status === "running") {
        res.json({ started: false, reason: "이미 돌고 있습니다" });
        return;
      }
      void runListTrack(client, { limit: body?.limit, force: body?.force !== false });
      res.json({ started: true });
    } catch (err) {
      next(err);
    }
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

  /*
   * **신호등 분석 원장에서 지운다** (2026-09-01).
   *
   * 벤티지: "신호등이랑 슈퍼신호등 종목삭제 버튼 좀 만들자. 내가 봐서 시가총액이
   * 너무 적거나 거래대금 너무 적은건 지워버리게."
   *
   * 이탈과 다르다 — 이탈은 「걸렸었는데 벗어났다」는 기록이라 남기고, 삭제는
   * 「애초에 볼 게 아니었다」라 진짜로 뺀다. 못 사는 종목이 원장에 남으면
   * 성적 평균이 오염된다(살 수 없었던 수익률이 섞이니까).
   *
   * `?list=` 를 주면 그 목록에서만 뺀다. 안 주면 전부 — 화면의 「이 종목 삭제」는
   * 「아예 안 보겠다」는 뜻이라 그쪽이 기본이다.
   */
  /*
   * **신호등 분석 종목 상세** (2026-09-01) — 슈퍼신호등과 같은 모양의 응답.
   * 화면이 두 원장을 한 컴포넌트로 그리므로 응답도 같아야 한다.
   *
   * ⚠️ `/list-track/:code` 보다 **먼저** 등록한다 — 아래 있으면 "detail" 이
   * 종목코드로 먹힌다.
   */
  router.get("/list-track/detail/:code", async (req, res, next) => {
    try {
      const d = await listTrackDetail(client, req.params.code);
      if (!d) {
        res.status(404).json({ error: "그 종목이 원장에 없습니다." });
        return;
      }
      res.json(d);
    } catch (err) {
      next(err);
    }
  });

  router.post("/list-track/exit/:code", async (req, res, next) => {
    try {
      const note = String((req.body as { note?: unknown })?.note ?? "");
      res.json({ ok: await exitListEntry(req.params.code, note) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/list-track/note/:code", async (req, res, next) => {
    try {
      const text = String((req.body as { note?: unknown })?.note ?? "");
      res.json({ ok: await updateListNote(req.params.code, text) });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/list-track/:code", async (req, res, next) => {
    try {
      const list = typeof req.query.list === "string" ? req.query.list : undefined;
      const removed = await removeListEntry(req.params.code, list);
      res.json({ ok: true, removed });
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
        /** 000 전체 · 001 코스피 · 101 코스닥 */
        market?: string;
      };
      /*
       * 표본 상한 500 (2026-08-31 — "샘플은 500개 기준으로"). 150 이었는데
       * 그 표본으로는 점수 구간별 성적이 톱니로 나왔다(80~89 가 70~79 보다
       * 훨씬 나쁨) — 구간마다 관측이 100~200개뿐이라 몇 종목의 등락에 휘둘린다.
       *
       * ⚠️ 500 이면 종목당 일봉 한 번씩이라 **몇 분** 걸린다. 화면이 진행률을 준다.
       */
      const limit = Math.min(Math.max(Number(body.limit) || 500, 5), 500);
      /*
       * **모집단은 「거래대금 상위」 하나다** (2026-08-31 명시).
       *
       * 시가총액·수급·연속매매 같은 다른 조건은 **모집단을 고르는 데 안 쓴다** —
       * 그것들은 신호등이 그 안에서 채점하는 값이다. 둘을 섞으면 「이미 수급이
       * 좋은 종목만 골라 놓고 수급 기준이 잘 맞는다」는 순환이 된다.
       *
       * 시장은 고를 수 있다: 000 전체 · 001 코스피 · 101 코스닥.
       */
      const mk = String((body as { market?: string }).market ?? "000");
      const market = ["000", "001", "101"].includes(mk) ? mk : "000";
      const top = await tradeValueTop(client, market, limit);
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

  /*
   * **원장으로 표본 만들기** (2026-09-01) — 조회 0회.
   *
   * 백테스트로 표본을 만들면 종목마다 조회를 새로 해 40~60분이 걸리고 500종목이
   * 한계였다. 이제 원장에 전종목 수급이 이미 있으므로 파일만 읽어 만든다 —
   * 2,600종목, 몇 분. 중간에 죽어도 다시 돌리면 그만이라 무르다.
   */
  router.post("/samples/fromLedger", (req, res) => {
    const b = req.body as { minFlowDays?: unknown; minVolEok?: unknown };
    const min = Number(b?.minFlowDays);
    const vol = Number(b?.minVolEok);
    void buildSamplesFromLedger(
      client,
      Number.isFinite(min) ? min : undefined,
      Number.isFinite(vol) ? vol : undefined,
    );
    res.json(ledgerSamplesProgress());
  });

  router.get("/samples/fromLedger/progress", (_req, res) => {
    res.json(ledgerSamplesProgress());
  });

  /*
   * **원장에 선 긋기** (2026-09-01) — 지우는 게 아니라 옮긴다.
   *
   * GET 은 **세어만 본다.** 무엇이 얼마나 비워지는지 먼저 보여 줘야 사람이
   * 누를지 정한다 — 되돌릴 수 있다 해도 「눌렀더니 뭔가 사라졌다」는 나쁘다.
   */
  router.get("/reset-ledgers/preview", async (_req, res, next) => {
    try {
      res.json(await resetSignalLedgers(true));
    } catch (err) {
      next(err);
    }
  });

  router.post("/reset-ledgers", async (_req, res, next) => {
    try {
      res.json(await resetSignalLedgers(false));
    } catch (err) {
      next(err);
    }
  });

  /**
   * 이 설정이면 성적이 어떻게 되나. `config` 를 안 주면 **지금 저장된 설정**을 잰다.
   */
  /*
   * 판정 요약 (2026-09-01) — 「이 점수가 무슨 뜻인가」.
   *
   * 신호등을 돌리면 점수만 나오고 그 점수의 뜻은 안 보였다. 시뮬레이터가 앞/뒤로
   * 갈라 낸 값을 파일에 남기고 화면이 읽는다 — **하드코딩하면 표본이 바뀌어도
   * 그대로 남아 곧 거짓말이 된다.**
   */
  router.get("/verdict", async (_req, res, next) => {
    try {
      res.json({ verdict: await loadVerdict() });
    } catch (err) {
      next(err);
    }
  });

  /** 지금 설정으로 다시 재서 남긴다 — 파일만 읽으므로 조회 0회, 수십 밀리초 */
  router.post("/verdict/build", async (_req, res, next) => {
    try {
      res.json({ verdict: await buildVerdict(await getConfig()) });
    } catch (err) {
      next(err);
    }
  });

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
   * 조건부 성적표 — **이 신호등이 어디서 먹히고 어디서 안 먹히나.**
   *
   * 지금 신호등은 모든 종목·모든 장세에 같은 문턱을 쓴다. 그게 가장 큰 한계라,
   * 「어느 기준이 최고인가」보다 「언제 이 기준을 믿나」가 더 큰 물음이다.
   * 표본 안에서 그날 시장을 되짚으므로 **조회가 0회**다.
   */
  router.post("/conditional", async (req, res, next) => {
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
      const r = await conditional(cfg);
      if (!r) {
        res.status(409).json({ error: "표본이 아직 없습니다." });
        return;
      }
      res.json({ result: r });
    } catch (err) {
      next(err);
    }
  });

  /**
   * 슈퍼신호등 재구성 — **두 겹 문이 각각 값을 하나.**
   *
   * 원장은 편입분 수십 건뿐이라 아무 말도 못 한다. 표본(19만 관측)에서 일곱 목록 중
   * 여섯을 되살려 「교집합만」·「초록만」·「둘 다」를 견준다. 조회 0회.
   */
  router.post("/super-sim", async (req, res, next) => {
    try {
      const body = req.body as { config?: Partial<SignalConfig>; minLists?: number };
      const saved = await getConfig();
      const cfg: SignalConfig = {
        ...saved,
        ...body.config,
        axisWeights: { ...saved.axisWeights, ...(body.config?.axisWeights ?? {}) },
        checks: body.config?.checks ?? saved.checks,
        maLines: body.config?.maLines ?? saved.maLines,
      };
      const r = await superSim(cfg, Math.min(Math.max(Number(body.minLists) || 3, 1), 6));
      if (!r) {
        res.status(409).json({ error: "표본이 아직 없습니다." });
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
