import { Router } from "express";
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

  return router;
}
