import { Router } from "express";
import { attachExtras } from "../rankExtras.js";
import type { KiwoomClient } from "../kiwoomClient.js";
import { getMarketSnapshot } from "../marketSnapshot.js";

const RKINFO_RESOURCE = "/api/dostk/rkinfo";
const FRGNISTT_RESOURCE = "/api/dostk/frgnistt";

function todayYyyymmdd(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}


/**
 * 목록에 거를 재료를 붙여 **원래 모양 그대로** 돌려준다.
 *
 * 화면은 키움 응답을 그대로 읽으므로 **감싸지 않는다** — 감싸면 읽는 쪽을 다 고쳐야 한다.
 * 목록 자리의 줄만 바꿔 끼운다.
 */
async function withExtras(
  client: KiwoomClient,
  data: Record<string, unknown>,
  listKey: string,
): Promise<Record<string, unknown>> {
  const rows = Array.isArray(data[listKey]) ? (data[listKey] as Record<string, unknown>[]) : [];
  if (rows.length === 0) return data;
  return { ...data, [listKey]: await fillPrevDay(client, await attachExtras(client, rows)) };
}

/**
 * **새 날 아침엔 등락률이 0 으로 온다** (2026-09-22 — 벤티지: "모든 곳에 전날 데이터 들고 있어야
 * 내가 다른 데 데이터도 계속 볼수 있겠지?").
 *
 * 키움 TR 은 장 시작 전 **현재가 = 전일 종가 · 등락률 0** 으로 답한다. 시황 스냅샷은 다음 개장까지
 * 어제 값을 들고 있으므로(`marketSnapshot` 의 `traded` 판정) 그것으로 메운다.
 * **등락률이 0 인데 스냅샷은 0 이 아닐 때만** 바꾼다 — 진짜 보합은 스냅샷도 0 이라 안 건드리고,
 * 장중에는 같은 값이라 바뀌는 것이 없다. 스냅샷은 40초 캐시라 조회가 안 는다.
 *
 * 이 한 자리가 **거래상위 · 전광판 · 종목발굴** 세 화면을 같이 고친다(셋 다 `/volume` 하나를 쓴다).
 */
async function fillPrevDay(client: KiwoomClient, rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  const snap = await getMarketSnapshot(client).catch(() => null);
  if (!snap) return rows;
  const num = (v: unknown): number | null => {
    const n = Number(String(v ?? "").replace(/[,+\s]/g, ""));
    return Number.isFinite(n) ? n : null;
  };
  return rows.map((r) => {
    const code = String(r.stk_cd ?? "").replace(/[^0-9A-Za-z]/g, "").slice(0, 6);
    const s = snap.byCode.get(code);
    /*
     * **정확히 0 일 때만** 바꾼다. `withExtras` 는 기간집계 TR(ka10062·ka10131)도 지나는데 그쪽은
     * 등락률 칸이 아예 없다(`null`) — 없는 칸을 채우면 원래 없던 값을 지어내는 셈이다.
     */
    if (!s || s.changeRate === 0 || num(r.flu_rt) !== 0) return r;
    return { ...r, cur_prc: Math.abs(s.price), flu_rt: s.changeRate };
  });
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
      res.json(await withExtras(client, data, "tdy_trde_qty_upper"));
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
        stex_tp: "3", // 통합 — 표시용 표는 키움 앱(통합) 기준과 맞춘다 (2026-08-26)
      });
      /*
        시세분석의 필터가 이 탭에서도 걸리려면 **줄마다 시총·거래대금·회전율**이 있어야 한다.
        같은 화면인데 탭에 따라 필터가 쉬면 그때마다 다시 확인해야 한다.
      */
      res.json(await withExtras(client, data, "eql_nettrde_rank"));
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
        stex_tp: "3", // 통합 — 표시용 표는 키움 앱(통합) 기준과 맞춘다 (2026-08-26)
      });
      res.json(await withExtras(client, data, "orgn_frgnr_cont_trde_prst"));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
