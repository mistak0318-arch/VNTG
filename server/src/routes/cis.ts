import { Router } from "express";
import type { KiwoomClient } from "../kiwoomClient.js";
import { equityOf, loadAccount, riskMix, today } from "../cisAccount.js";
import { ACCOUNTS, ACCOUNT_IDS, profileOf, type AccountId } from "../cisAccounts.js";
import { getCisConfig, goalProgress, saveCisConfig, RULE_LABEL } from "../cisConfig.js";
import { listDays, loadDay } from "../cisJournal.js";
import { readState } from "../cisPersona.js";
import { priceMap, runSlot } from "../cisRun.js";
import { cisStats, cisUsage } from "../cisStats.js";
import { cisAiReady, weeklyReview } from "../cisAi.js";
import { resetCisTried } from "../cisScheduler.js";

/**
 * CIS 일지 API.
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
        ruleLabels: RULE_LABEL,
        aiReady: cisAiReady(),
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
      const result = await runSlot(
        client,
        slot as "morning" | "noon" | "evening",
        acc(req.body?.account),
        req.body?.force === true,
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  /** 주간 복기 (AI) — 며칠치를 놓고 어느 규칙이 나빴나 */
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
