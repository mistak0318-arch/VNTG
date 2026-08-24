import { Router } from "express";
import type { KiwoomClient } from "../kiwoomClient.js";

const RKINFO_RESOURCE = "/api/dostk/rkinfo";
const FRGNISTT_RESOURCE = "/api/dostk/frgnistt";

function todayYyyymmdd(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

export function createRankingRouter(client: KiwoomClient): Router {
  const router = Router();

  // 당일거래량상위 (ka10030) - HTS 0130 참고. sort: 1:거래량, 2:거래회전율, 3:거래대금
  router.get("/volume", async (req, res, next) => {
    try {
      const mrktTp = typeof req.query.market === "string" ? req.query.market : "000";
      const sortTp = typeof req.query.sort === "string" ? req.query.sort : "3";
      const { data } = await client.request(RKINFO_RESOURCE, "ka10030", {
        mrkt_tp: mrktTp, // 000:전체, 001:코스피, 101:코스닥
        sort_tp: sortTp,
        mang_stk_incls: "1", // 관리종목 미포함
        crd_tp: "0",
        trde_qty_tp: "0",
        pric_tp: "0",
        trde_prica_tp: "0",
        mrkt_open_tp: "0",
        stex_tp: "3", // 통합 — 거래대금은 하루 전체(NXT 프리 + KRX 정규 + NXT 애프터)가 맞다
      });
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  // 동일순매매순위 (ka10062) - 기관/외국인 동일 방향 순매매 - HTS 0798 참고
  router.get("/same-net-trade", async (req, res, next) => {
    try {
      const mrktTp = typeof req.query.market === "string" ? req.query.market : "000";
      const trdeTp = typeof req.query.trade === "string" ? req.query.trade : "1"; // 1:순매수, 2:순매도
      /*
       * 기간을 고를 수 있어야 한다.
       *
       * 오늘~오늘로 고정해 뒀더니 **장중에 아무것도 안 나왔다.** 문서 예시도
       * 하루가 아니라 이틀 구간(11/06~11/07)이다 — 「며칠에 걸쳐 같은 방향으로
       * 샀나」를 보는 TR 이라 하루만 주면 답할 게 없는 셈이다.
       */
      /*
       * ⚠️ **오늘 날짜로 물으면 0건이 온다.** 실측이다 —
       *   오늘~오늘    0건
       *   어제~어제    100건
       *   닷새전~오늘  100건
       * 당일 집계가 장중에는 아직 없다. 그래서 기본을 **최근 5거래일**로 둔다.
       * (며칠에 걸쳐 같은 방향으로 샀나를 보는 TR 이라 하루만 주면 답할 게 없다)
       */
      const today = todayYyyymmdd();
      const ago = (n: number) => {
        const d = new Date(Date.now() + 9 * 3600 * 1000 - n * 86400_000);
        return d.toISOString().slice(0, 10).replace(/-/g, "");
      };
      const strt = typeof req.query.from === "string" && req.query.from ? req.query.from : ago(7);
      const end = typeof req.query.to === "string" && req.query.to ? req.query.to : today;
      const { data } = await client.request(RKINFO_RESOURCE, "ka10062", {
        strt_dt: strt,
        end_dt: end,
        mrkt_tp: mrktTp,
        trde_tp: trdeTp,
        sort_cnd: "2", // 2:금액
        unit_tp: "1",
        stex_tp: "1",
      });
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  // 기관외국인연속매매현황 (ka10131) - HTS 0763 참고
  router.get("/continuous-trade", async (req, res, next) => {
    try {
      const mrktTp = typeof req.query.market === "string" ? req.query.market : "001"; // 001:코스피, 101:코스닥 (전체 없음)
      const days = typeof req.query.days === "string" ? req.query.days : "1";
      const { data } = await client.request(FRGNISTT_RESOURCE, "ka10131", {
        dt: days,
        strt_dt: "",
        end_dt: "",
        mrkt_tp: mrktTp,
        netslmt_tp: "2", // 고정값
        stk_inds_tp: "0", // 0:종목
        amt_qty_tp: "0", // 0:금액
        stex_tp: "1",
      });
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
