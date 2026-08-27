import { Router } from "express";
import {
  addAccount,
  BROKERS,
  evaluateAccounts,
  listAccounts,
  removeAccount,
  removeHolding,
  setCash,
  upsertHolding,
} from "../manualAccounts.js";
import type { KiwoomClient } from "../kiwoomClient.js";
import { peekSnapshot } from "../marketSnapshot.js";
import { listThemes } from "../customThemes.js";

const ACNT_RESOURCE = "/api/dostk/acnt";

function toWon(v: unknown): number {
  const n = Number(String(v ?? "").replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? Math.abs(n) : 0;
}

export function createAccountRouter(client: KiwoomClient): Router {
  const router = Router();

  // 예수금상세현황 (kt00001) - qry_tp 3:추정조회
  router.get("/deposit", async (_req, res, next) => {
    try {
      const { data } = await client.request(ACNT_RESOURCE, "kt00001", { qry_tp: "3" });
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  // 계좌평가현황 (kt00004) - qry_tp 0:전체
  router.get("/summary", async (_req, res, next) => {
    try {
      const { data } = await client.request(ACNT_RESOURCE, "kt00004", {
        qry_tp: "0",
        dmst_stex_tp: "KRX",
      });
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  // 계좌평가잔고내역 (kt00018) - 보유종목 리스트 + 총평가/총손익
  router.get("/holdings", async (req, res, next) => {
    try {
      const contYn = typeof req.query.cont_yn === "string" ? req.query.cont_yn : undefined;
      const nextKey = typeof req.query.next_key === "string" ? req.query.next_key : undefined;
      const { data, contYn: respContYn, nextKey: respNextKey } = await client.request(
        ACNT_RESOURCE,
        "kt00018",
        { qry_tp: "1", dmst_stex_tp: "KRX" },
        { contYn, nextKey },
      );
      res.json({ ...data, cont_yn: respContYn, next_key: respNextKey });
    } catch (err) {
      next(err);
    }
  });

  /**
   * 보유 집중도 (2026-08-27 전수 점검에서 제안) — 「지금 어디에 몰려 있나」.
   *
   * 잔고(kt00018)를 업종·내 테마로 묶어 비중을 낸다. 업종은 시장 스냅샷의 배정을
   * 그대로 쓴다(peek — 배지 폴링처럼 여기서 스캔을 유발하지 않는다. 캐시가 아직
   * 없으면 「미분류」로 나올 뿐이다). 테마 비중은 한 종목이 여러 테마에 속할 수
   * 있어 합이 100%를 넘을 수 있다 — 화면이 그 사실을 같이 말한다.
   */
  router.get("/concentration", async (_req, res, next) => {
    try {
      const { data } = await client.request<Record<string, unknown>>(ACNT_RESOURCE, "kt00018", {
        qry_tp: "1",
        dmst_stex_tp: "KRX",
      });
      const raw = (data.acnt_evlt_remn_indv_tot ?? []) as Record<string, unknown>[];
      const snap = peekSnapshot();
      const themes = await listThemes().catch(() => []);

      const stocks = raw
        .map((r) => {
          const code = String(r.stk_cd ?? "")
            .replace(/^A/, "")
            .replace(/_AL$/, "");
          const value = toWon(r.evlt_amt);
          return {
            code,
            name: String(r.stk_nm ?? ""),
            value,
            sector: snap?.byCode.get(code)?.sector ?? "미분류",
            themes: themes.filter((t) => t.codes.includes(code)).map((t) => t.name),
          };
        })
        .filter((s) => s.value > 0)
        .sort((a, b) => b.value - a.value);
      const total = stocks.reduce((a, b) => a + b.value, 0);

      const group = (keysOf: (s: (typeof stocks)[number]) => string[]) => {
        const m = new Map<string, { value: number; count: number }>();
        for (const s of stocks) {
          for (const k of keysOf(s)) {
            const cur = m.get(k) ?? { value: 0, count: 0 };
            cur.value += s.value;
            cur.count += 1;
            m.set(k, cur);
          }
        }
        return [...m.entries()]
          .map(([name, v]) => ({
            name,
            value: v.value,
            count: v.count,
            weight: total > 0 ? (v.value / total) * 100 : 0,
          }))
          .sort((a, b) => b.value - a.value);
      };

      res.json({
        total,
        stocks: stocks.map((s) => ({
          ...s,
          weight: total > 0 ? (s.value / total) * 100 : 0,
        })),
        bySector: group((s) => [s.sector]),
        byTheme: group((s) => s.themes),
      });
    } catch (err) {
      next(err);
    }
  });

  // ---------------- 수동 계좌 (키움 외 증권사, 직접 입력) ----------------

  router.get("/manual/brokers", (_req, res) => {
    res.json({ brokers: BROKERS });
  });

  /** 평가금액·수익률은 저장값이 아니라 조회 시점에 계산한다 */
  router.get("/manual", async (_req, res, next) => {
    try {
      res.json({ accounts: await evaluateAccounts(client) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/manual", async (req, res, next) => {
    try {
      const { broker, name } = req.body ?? {};
      await addAccount(String(broker ?? ""), String(name ?? ""));
      res.json({ accounts: await evaluateAccounts(client) });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/manual/:id", async (req, res, next) => {
    try {
      await removeAccount(req.params.id);
      res.json({ accounts: await evaluateAccounts(client) });
    } catch (err) {
      next(err);
    }
  });

  /** 예수금 입력 — 수동 계좌는 현금을 받아올 방법이 없어 직접 적는다 */
  router.put("/manual/:id/cash", async (req, res, next) => {
    try {
      await setCash(req.params.id, Number(req.body?.cash));
      res.json({ accounts: await evaluateAccounts(client) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/manual/:id/holdings", async (req, res, next) => {
    try {
      const { code, name, avgPrice, qty } = req.body ?? {};
      await upsertHolding(req.params.id, {
        code: String(code ?? ""),
        name: String(name ?? code ?? ""),
        avgPrice: Number(avgPrice) || 0,
        qty: Number(qty) || 0,
      });
      res.json({ accounts: await evaluateAccounts(client) });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/manual/:id/holdings/:code", async (req, res, next) => {
    try {
      await removeHolding(req.params.id, req.params.code);
      res.json({ accounts: await evaluateAccounts(client) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
