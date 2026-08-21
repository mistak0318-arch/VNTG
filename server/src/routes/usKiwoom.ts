import { Router } from "express";
import type { KiwoomClient } from "../kiwoomClient.js";

/**
 * 키움 미국주식 — **되는지부터 확인하는 자리.**
 *
 * 문서(344시트)를 전수 확인해 보니 미국주식 TR 이 130개 있고, 한투·야후로는 못 하던
 * 호가·체결내역·시가총액·업종이 다 있다. 그런데 **실제로 호출해 본 적이 없다** —
 * 문서에 있다는 것과 내 계정으로 된다는 것은 다른 말이다.
 *
 * 그래서 종목 조회 하나(`usa20100`)를 먼저 낸다. 여기서 막히면 나머지는 다 무의미하다.
 *
 * ⚠️ 거래소 구분(`stex_tp`)이 **필수**다 — NA: AMEX, ND: NASDAQ, NY: NYSE.
 * 종목만 주면 안 되고 어느 거래소인지 같이 줘야 한다.
 */
export function createUsKiwoomRouter(client: KiwoomClient): Router {
  const router = Router();

  const MRKCOND = "/api/us/mrkcond";

  /** 미국주식 현재가 종목정보 (usa20100) */
  router.get("/quote/:symbol", async (req, res, next) => {
    try {
      const stex = String(req.query.stex ?? "ND").toUpperCase();
      const { data } = await client.request<Record<string, unknown>>(MRKCOND, "usa20100", {
        stex_tp: stex,
        stk_cd: String(req.params.symbol).toUpperCase(),
      });
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  /** 미국주식 10호가 (usa20101) */
  router.get("/orderbook/:symbol", async (req, res, next) => {
    try {
      const stex = String(req.query.stex ?? "ND").toUpperCase();
      const { data } = await client.request<Record<string, unknown>>(MRKCOND, "usa20101", {
        stex_tp: stex,
        stk_cd: String(req.params.symbol).toUpperCase(),
      });
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
