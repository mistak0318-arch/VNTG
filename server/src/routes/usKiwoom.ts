import { Router } from "express";
import type { KiwoomClient } from "../kiwoomClient.js";
import { usKiwoomDetail } from "../usKiwoomDetail.js";

/**
 * 키움 미국주식.
 *
 * 문서(344시트)를 전수 확인해 보니 미국주식 TR 이 130개 있고, 한투·야후로는 못 하던
 * 호가·체결내역·시가총액·업종이 다 있다.
 *
 * ## ✅ 2026-08-25 — **내 계정으로 실제로 된다** (첫 실측)
 *
 * 문서에 있다는 것과 내 계정으로 된다는 것은 다른 말이라 탐침만 만들어 두고 있었다.
 * NVDA(ND)로 둘 다 쐈고 정상 응답을 받았다:
 *
 *   `usa20100` — 시총(`mac`)·상장주식수·52주 고저+날짜·연중 고저·**프리장 시고저**
 *                (`pre_open/high/low_pric` — 야후·한투가 안 주던 값)·
 *                **진짜 업종**(`lg_inds_cd` IT / `sm_inds_cd` 반도체 및 반도체장비)·
 *                환율(`base_exrt` 1384.10)
 *   `usa20101` — 필드 90개: 10호가 전체 + 거래대금(`trde_prica`) +
 *                **회전율**(`trde_tern_rt`) + 전일비 거래량(`pre_trde_rt`) + 호가시각
 *
 * 가격은 국내 TR 처럼 **부호가 등락 표시**다(`-209.4600` = 하락 중 209.46).
 * 쓰는 쪽에서 절댓값을 취해야 한다.
 *
 * ## 방향 — **교체가 아니라 증설이다**
 *
 * 한투가 주는 것(시간외 가격·야간선물·목표주가)은 키움에 없다 — 그건 그대로 둔다.
 * 키움만 주는 것(호가·업종·프리장 OHLC·회전율·실시간 FE)을 **얹는다.**
 * 로드맵은 TODO H절: ① 상세에 usa20100 세부 → ② 미국 호가창 → ③ 실시간 FE(228·290).
 *
 * ⚠️ 거래소 구분(`stex_tp`)이 **필수**다 — NA: AMEX, ND: NASDAQ, NY: NYSE.
 * 종목만 주면 안 되고 어느 거래소인지 같이 줘야 한다.
 */
export function createUsKiwoomRouter(client: KiwoomClient): Router {
  const router = Router();

  const MRKCOND = "/api/us/mrkcond";

  /**
   * 세부 한 덩어리 — 해외 상세 화면이 쓴다.
   * 거래소는 `usExchanges.json` 에서 자동으로 푼다(미국이 아니면 `unsupported`).
   */
  router.get("/detail/:symbol", async (req, res, next) => {
    try {
      res.json(await usKiwoomDetail(client, req.params.symbol));
    } catch (err) {
      next(err);
    }
  });

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
