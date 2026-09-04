import { Router } from "express";
import type { KiwoomClient } from "../kiwoomClient.js";
import { equityOf, loadAccount, resetAccount, riskMix, today } from "../cisAccount.js";
import { ACCOUNTS, ACCOUNT_IDS, profileOf, type AccountId } from "../cisAccounts.js";
import { getCisConfig, goalProgress, saveCisConfig, RULE_LABEL } from "../cisConfig.js";
import { clearJournal, listDays, loadDay } from "../cisJournal.js";
import { CIS_CREED, readState } from "../cisPersona.js";
import { priceMap, runSlot } from "../cisRun.js";
import { cisStats, cisUsage } from "../cisStats.js";
import { cisAiModels, cisAiReady, weeklyReview } from "../cisAi.js";
import { cisSchedulerState, resetCisTried } from "../cisScheduler.js";
import { CIS_STEPS, createJob, getJob, reporterFor } from "../reportProgress.js";
import { cisBacktest } from "../cisBacktest.js";
import type { CisRules } from "../cisTrader.js";
import { METHOD_LABEL, runPension } from "../cisPensionRun.js";
import { clearWatchEvents, watchEvents, watchStatus } from "../cisWatch.js";

/**
 * 항해일지 API (옛 이름 「CIS 일지」 — 2026-09-04 개명).
 *
 * ⚠️ **조회 전용 원칙은 그대로다.** 여기서 실제 주문은 나가지 않는다 —
 * 이 라우터가 다루는 것은 모의 장부뿐이다.
 *
 * 모든 경로가 `?account=` 를 받는다. 안 주면 트레이딩 계좌다 — 기본값을 두는 이유는
 * 화면이 처음 뜰 때 무엇을 보여줄지 정해져 있어야 하기 때문이고, 연금 계좌를
 * 기본으로 두면 「오늘 뭐 샀나」를 물었을 때 대체로 빈 화면이 뜬다.
 */
export function createCisRouter(client: KiwoomClient): Router {
  const router = Router();

  const acc = (v: unknown): AccountId =>
    ACCOUNT_IDS.includes(String(v) as AccountId) ? (String(v) as AccountId) : "trade";

  /** 계좌 목록과 성질 — 화면이 탭을 그리는 재료 */
  router.get("/accounts", (_req, res) => {
    res.json({ accounts: ACCOUNT_IDS.map((id) => ACCOUNTS[id]) });
  });

  /**
   * **데스크** — 계좌 넷을 한 줄로 (2026-09-04).
   *
   * 벤티지: "내부에 메뉴 구성도 좀 세련되게 바꿔줬으면 좋겠다. 트레이딩 룸처럼 꾸며주던가."
   *
   * 전엔 계좌를 고르고 나서야 그 계좌의 평가액이 보였다 — **넷을 견주려면 네 번 눌러야
   * 했다.** 그런데 이 장부의 물음은 처음부터 「어느 항로가 낫나」다. 한 번에 보여야 한다.
   *
   * 값은 **한 번의 시세 조회**로 낸다. 네 계좌의 보유 종목을 합쳐 `priceMap` 에 한 번
   * 넣는다(ka10095 는 50종목씩 받는다) — 계좌마다 따로 부르면 조회가 네 배가 된다.
   */
  router.get("/desk", async (_req, res, next) => {
    try {
      const accounts = await Promise.all(ACCOUNT_IDS.map((id) => loadAccount(id)));
      const px = await priceMap(client, accounts.flatMap((a) => a.positions.map((p) => p.code)));
      const priceOf = (code: string) => px.get(code) ?? null;
      const date = today();

      const rows = accounts.map((a) => {
        const p = profileOf(a.id);
        const e = equityOf(a, priceOf);
        /*
         * 오늘 얼마나 움직였나 — **어제 찍은 평가액**과 견준다. 곡선의 마지막 점이
         * 오늘이면 그 앞을 쓴다(하루에 여러 번 찍히므로).
         */
        const curve = a.equityCurve;
        const prev = [...curve].reverse().find((c) => c.date < date) ?? null;
        const dayPnl = prev ? e.equity - prev.equity : null;

        return {
          id: a.id,
          name: p.name,
          hint: p.hint,
          seed: p.seed,
          etfOnly: p.etfOnly,
          riskCap: p.riskCap,
          cadence: p.cadence,
          style: p.style ?? "swing",
          equity: Math.round(e.equity),
          cash: Math.round(a.cash),
          debt: Math.round(e.debt),
          positions: a.positions.length,
          /* 시드 대비 — 계좌마다 시드가 달라 금액으로는 못 견준다 */
          totalPct: p.seed > 0 ? Number((((e.equity - p.seed) / p.seed) * 100).toFixed(2)) : 0,
          dayPnl: dayPnl === null ? null : Math.round(dayPnl),
          dayPct:
            dayPnl !== null && prev && prev.equity > 0
              ? Number(((dayPnl / prev.equity) * 100).toFixed(2))
              : null,
          startedAt: a.startedAt,
          /* 퇴직연금만 뜻이 있다 — 규정을 지키고 있는지가 카드에서 바로 보여야 한다 */
          risk: p.riskCap < 100 ? riskMix(a, priceOf) : null,
        };
      });

      res.json({ date, rows });
    } catch (err) {
      next(err);
    }
  });

  /** 지금 계좌 상태 — 보유·현금·빚·목표 진척 */
  router.get("/account", async (req, res, next) => {
    try {
      const id = acc(req.query.account);
      const a = await loadAccount(id);
      const cfg = await getCisConfig();
      const px = await priceMap(client, a.positions.map((p) => p.code));
      const priceOf = (code: string) => px.get(code) ?? null;
      const e = equityOf(a, priceOf);
      const profile = profileOf(id);

      res.json({
        profile,
        cash: Math.round(a.cash),
        misu: Math.round(a.misu),
        credit: Math.round(a.credit),
        ...e,
        startedAt: a.startedAt,
        positions: a.positions.map((p) => {
          const now = priceOf(p.code);
          const value = (now ?? p.avg) * p.qty;
          return {
            ...p,
            price: now,
            value: Math.round(value),
            pnl: now !== null ? Math.round((now - p.avg) * p.qty) : null,
            pnlPct: now !== null ? Number((((now - p.avg) / p.avg) * 100).toFixed(2)) : null,
          };
        }),
        /* 퇴직연금만 뜻이 있지만 늘 보낸다 — 화면이 계좌마다 다른 모양을 받으면 다루기 어렵다 */
        risk: riskMix(a, priceOf),
        goal: goalProgress(e.equity, cfg.goals, profile.seed),
        curve: a.equityCurve,
      });
    } catch (err) {
      next(err);
    }
  });

  /** 매매일지 — 체결 원장 */
  router.get("/fills", async (req, res, next) => {
    try {
      const a = await loadAccount(acc(req.query.account));
      const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 2000);
      res.json({ fills: [...a.fills].reverse().slice(0, limit), total: a.fills.length });
    } catch (err) {
      next(err);
    }
  });

  /** 하루치 일지 (아침·점심·저녁) */
  router.get("/day", async (req, res, next) => {
    try {
      const date = String(req.query.date ?? "").trim() || today();
      res.json(await loadDay(date, acc(req.query.account)));
    } catch (err) {
      next(err);
    }
  });

  /** 복기 노트 목록 */
  router.get("/days", async (req, res, next) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 60, 1), 400);
      const id = acc(req.query.account);
      const days = await listDays(limit, id);
      res.json({ days, state: readState(days) });
    } catch (err) {
      next(err);
    }
  });

  /** 통계 */
  router.get("/stats", async (req, res, next) => {
    try {
      res.json(await cisStats(acc(req.query.account)));
    } catch (err) {
      next(err);
    }
  });

  /** HTS 활용법 */
  router.get("/usage", async (req, res, next) => {
    try {
      res.json({ rows: await cisUsage(acc(req.query.account)) });
    } catch (err) {
      next(err);
    }
  });

  /** 설정 */
  router.get("/config", async (_req, res, next) => {
    try {
      res.json({
        config: await getCisConfig(),
        /* 시스의 신조 — 화면 머리에 늘 박아 둔다 (벤티지: "내가 보고 항상 되새김할 수 있게") */
        creed: CIS_CREED,
        ruleLabels: RULE_LABEL,
        methodLabels: METHOD_LABEL,
        aiReady: cisAiReady(),
        /*
         * 고를 수 있는 모델. AI 가 여기서 하는 일은 **주어진 사실을 문장으로
         * 옮기는 것**뿐이라 값비싼 추론이 필요 없다 — 싼 것부터 온다.
         */
        aiModels: cisAiModels(),
      });
    } catch (err) {
      next(err);
    }
  });

  router.put("/config", async (req, res, next) => {
    try {
      const next2 = await saveCisConfig(req.body ?? {});
      /* 시각을 당겼으면 오늘 것을 다시 시도할 수 있어야 한다 */
      resetCisTried();
      res.json({ config: next2 });
    } catch (err) {
      next(err);
    }
  });

  /**
   * 손으로 돌리기.
   *
   * `force` 는 이미 쓴 시간대를 덮어쓴다 — 화면에서 「다시 쓰기」를 눌렀을 때만이다.
   * 아침 글이 저녁에 바뀌면 일지의 뜻이 사라지므로 기본은 거절이다.
   */
  router.post("/run", async (req, res, next) => {
    try {
      const slot = String(req.body?.slot ?? "");
      if (!["morning", "noon", "evening"].includes(slot)) {
        res.status(400).json({ error: "slot 은 morning·noon·evening 중 하나여야 합니다." });
        return;
      }
      const id2 = acc(req.body?.account);
      const force = req.body?.force === true;

      /*
       * **뒤에서 돌린다** (2026-08-31 — "프로그래스 바가 안뜨고 백그라운드 작업이
       * 아니라 브라우저 멈추더라").
       *
       * 주도주 스캔과 종목별 신호등이 각각 수십 초라, 동기로 돌리면 그동안 요청이
       * 안 끝나 화면이 멈춘 것처럼 보였다. 작업 id 를 바로 돌려주고 화면은
       * /run-progress 를 물어 단계를 그린다 — 리포트 발행과 같은 문법이다.
       */
      const { id, job } = createJob(
        `CIS ${profileOf(id2).name} ${slot === "morning" ? "아침" : slot === "noon" ? "점심" : "저녁"}`,
        CIS_STEPS,
        "cis",
      );
      void runSlot(client, slot as "morning" | "noon" | "evening", id2, force, reporterFor(job))
        .then((r) => {
          job.status = r.ok ? "done" : "error";
          job.report = r;
          if (!r.ok) job.error = r.skipped;
        })
        .catch((e: Error) => {
          job.status = "error";
          job.error = e.message;
        });
      res.json({ jobId: id });
    } catch (err) {
      next(err);
    }
  });

  /** 진행 상황 — 화면이 이걸 물어 단계를 그린다 */
  router.get("/run-progress/:id", (req, res) => {
    const job = getJob(String(req.params.id));
    if (!job) {
      res.status(404).json({ error: "그 작업을 찾을 수 없습니다(끝난 지 오래됐거나 서버가 다시 떴습니다)." });
      return;
    }
    res.json(job);
  });

  /**
   * 계좌 초기화 — 장부와 일지를 처음으로 되돌린다.
   *
   * 규칙을 바꿔 가며 시험할 때 필요하다. 옛 규칙으로 산 종목이 남아 있으면
   * 새 규칙의 성적이 오염된다.
   *
   * ⚠️ 되돌릴 수 없어 `confirm: "초기화"` 를 요구한다 — 실수로 눌러 몇 달치
   * 기록을 잃는 일을 막는다.
   */
  router.post("/reset", async (req, res, next) => {
    try {
      if (String(req.body?.confirm ?? "") !== "초기화") {
        res.status(400).json({ error: '확인 문구가 필요합니다 (confirm: "초기화").' });
        return;
      }
      const id = acc(req.body?.account);
      const a = await resetAccount(id);
      const removed = await clearJournal(id);
      clearWatchEvents(id);
      res.json({ ok: true, account: id, seed: a.cash, journalRemoved: removed });
    } catch (err) {
      next(err);
    }
  });

  /**
   * 장중 감시 — 지금 보고 있나, 그동안 뭘 했나.
   *
   * 사건만 돌려준다. 「10:31 감시함, 아무 일 없음」은 기록할 값이 아니다 —
   * 상시 기록은 보유 줄의 흔들림(worstPct/bestPct)에 새겨진다.
   */
  /**
   * 연금 계좌를 지금 굴린다 — 주 1회가 기본이고 이건 손으로 부르는 자리다.
   *
   * 무겁다(ETF 분석 한 판) — 백그라운드로 돌리고 진행률을 준다. 하루 세 번
   * 일지와 같은 문법이다.
   */
  router.post("/pension-run", async (req, res, next) => {
    try {
      const id = acc(req.body?.account);
      if (profileOf(id).cadence === "daily") {
        res.status(400).json({ error: "연금 계좌가 아닙니다." });
        return;
      }
      const { id: jobId, job } = createJob(`CIS ${profileOf(id).name} 주간 배분`, CIS_STEPS, "cis");
      void runPension(client, id, req.body?.force === true, reporterFor(job))
        .then((r) => {
          job.status = r.ok ? "done" : "error";
          job.report = r;
          if (!r.ok) job.error = r.skipped;
        })
        .catch((e: Error) => {
          job.status = "error";
          job.error = e.message;
        });
      res.json({ jobId });
    } catch (err) {
      next(err);
    }
  });

  router.get("/watch", (req, res) => {
    res.json({
      ...watchStatus(),
      events: watchEvents(acc(req.query.account), 60),
      /*
       * 자동 실행이 실패한 것 — **화면이 말해야 한다.** 콘솔에만 두면
       * 「아침 일지가 왜 없지」에 아무도 답할 수 없다.
       */
      failures: cisSchedulerState(),
    });
  });

  /** 주간 복기 (AI) — 며칠치를 놓고 어느 규칙이 나빴나 */
  /**
   * **규칙 백테스트** (2026-09-02) — 조회 0회.
   *
   * 벤티지: "지금의 CIS를 더 똑똑하게 만들 방법있어?"
   *
   * CIS 는 아직 한 번도 켜진 적이 없어서(`data/cis` 폴더가 없다) 성적 기록이
   * 없고, 그래서 손절 -7%·익절 +15%·보유 10일·점수 60 이 전부 짐작이다.
   *
   * 표본(2.8만 관측)과 전종목 일봉 OHLC 로 「이 규칙으로 굴렸으면 어땠나」를
   * 돌린다. 표본에는 d1·d5·d20 뿐이라 중간 경로를 모르지만, **일봉에는
   * 고가·저가가 있어서** 손절이 언제 걸렸는지를 실제로 셀 수 있다.
   *
   * 몸통(`rules`)으로 값을 바꿔 가며 돌려 볼 수 있다 — 안 주면 지금 설정.
   */
  router.post("/backtest", async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as { rules?: Partial<CisRules>; limit?: number };
      const cfg = await getCisConfig();
      /* 화면이 값을 안 주면 지금 CIS 설정으로 — 「지금 규칙이 어떤가」가 첫 물음이다 */
      const rules = { ...cfg.rules, ...(body.rules ?? {}) };
      const limit = Math.min(Math.max(Number(body.limit) || 300, 20), 1000);
      const r = await cisBacktest(rules, undefined, limit);
      if (!r) {
        res.status(404).json({
          error: "검증 표본이 없습니다 — 설정 > 시뮬레이터에서 「원장으로 표본 다시 만들기」를 먼저 누르세요.",
        });
        return;
      }
      res.json(r);
    } catch (err) {
      next(err);
    }
  });

  router.post("/review", async (req, res, next) => {
    try {
      const id = acc(req.body?.account);
      const cfg = await getCisConfig();
      const days = await listDays(20, id);
      res.json(await weeklyReview(days, cfg.rules));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
