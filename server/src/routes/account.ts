import { Router } from "express";
import {
  addAccount,
  BROKERS,
  evaluateAccounts,
  listAccounts,
  removeAccount,
  removeHolding,
  upsertHolding,
} from "../manualAccounts.js";
import type { KiwoomClient } from "../kiwoomClient.js";

const ACNT_RESOURCE = "/api/dostk/acnt";

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
