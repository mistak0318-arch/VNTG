import { Router } from "express";
import type { KiwoomClient } from "../kiwoomClient.js";
import { flowIntradayDates, listFlowIntraday } from "../flowIntraday.js";
import { indexDetail } from "../indexDetail.js";
import {
  getProgramTrades,
  getSection,
  getSectorStocks,
  getThemeStocks,
  SECTION_NAMES,
  type SectionName,
} from "../marketOverview.js";

/**
 * 장 상태 판정 (한국 시간 기준, 공휴일은 판별하지 않음).
 *
 * ## 「거래가 도는 시간」은 정규장보다 넓다
 *
 * 넥스트레이드(NXT)가 **08:00~09:00 프리마켓**과 **15:30~20:00 애프터마켓**에 돈다.
 * 그런데 예전엔 정규장(09:00~15:30)만 `open` 으로 봤고, 화면의 실시간 갱신은
 * `state === "open"` 일 때만 돌았다. 그래서 **NXT 시간에는 값이 안 움직였다** —
 * 종목 창을 열어 놔도 멈춰 있고, 새로고침을 눌러도 그때 한 번만 받고 끝났다.
 *
 * `live` 를 따로 둔다. **「지금 체결이 나고 있나」**는 「정규장인가」와 다른 질문이다.
 * `state` 는 그대로 둬서 기존 화면(장전/장중/장마감 표시)이 안 바뀌게 한다.
 */
function marketStatus(): {
  state: "pre" | "open" | "closed" | "holiday";
  label: string;
  /** 지금 체결이 도는가 — NXT 시간외를 포함한다. 실시간 갱신은 이걸 본다 */
  live: boolean;
  /** 어느 판인가 */
  venue: "none" | "nxt" | "krx";
} {
  const now = new Date();
  const day = now.getDay();
  if (day === 0 || day === 6)
    return { state: "holiday", label: "휴장", live: false, venue: "none" };

  const minutes = now.getHours() * 60 + now.getMinutes();
  // NXT 프리마켓 08:00~09:00 · 정규장 09:00~15:30 · NXT 애프터마켓 15:30~20:00
  const nxtPre = minutes >= 8 * 60 && minutes < 9 * 60;
  const regular = minutes >= 9 * 60 && minutes <= 15 * 60 + 30;
  const nxtPost = minutes > 15 * 60 + 30 && minutes <= 20 * 60;

  if (minutes < 9 * 60) {
    return {
      state: "pre",
      label: nxtPre ? "장전 (NXT)" : "장전",
      live: nxtPre,
      venue: nxtPre ? "nxt" : "none",
    };
  }
  if (regular) return { state: "open", label: "장중", live: true, venue: "krx" };
  return {
    state: "closed",
    label: nxtPost ? "장마감 (NXT)" : "장마감",
    live: nxtPost,
    venue: nxtPost ? "nxt" : "none",
  };
}

export function createOverviewRouter(client: KiwoomClient): Router {
  const router = Router();

  router.get("/status", (_req, res) => {
    res.json(marketStatus());
  });

  // 섹션별 개별 조회 — 한 섹션이 실패해도 다른 섹션에 영향 없음
  router.get("/section/:name", async (req, res) => {
    const name = req.params.name as SectionName;
    if (!SECTION_NAMES.includes(name)) {
      res.status(404).json({ error: `알 수 없는 섹션: ${name}` });
      return;
    }
    try {
      const result = await getSection(name, client);
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : "알 수 없는 오류" });
    }
  });

  /*
   * 장중 수급 변화. 하루 누적 숫자만 보면 오전에 팔다 오후에 산 날과
   * 하루 종일 판 날이 똑같이 생긴다.
   */
  router.get("/flow-intraday", async (req, res, next) => {
    try {
      const date = typeof req.query.date === "string" ? req.query.date : undefined;
      res.json({ day: await listFlowIntraday(date), dates: await flowIntradayDates() });
    } catch (err) {
      next(err);
    }
  });

  /*
   * 코스피·코스닥 상세 — 지수 추이(일/주/월) + 일별 수급.
   * 개별 종목엔 있던 게 정작 지수엔 없었다.
   */
  router.get("/index/:code", async (req, res, next) => {
    try {
      const r = req.query.range;
      const range = r === "week" || r === "month" ? r : "day";
      res.json(await indexDetail(client, req.params.code, range));
    } catch (err) {
      next(err);
    }
  });

  // 프로그램 매매 (차익/비차익)
  router.get("/program/:market/:scope", async (req, res, next) => {
    try {
      const market = req.params.market === "kosdaq" ? "kosdaq" : "kospi";
      const scope = req.params.scope === "daily" ? "daily" : "time";
      res.json({ items: await getProgramTrades(client, market, scope) });
    } catch (err) {
      next(err);
    }
  });

  // 테마 구성종목
  router.get("/theme/:code/stocks", async (req, res, next) => {
    try {
      res.json({ items: await getThemeStocks(client, req.params.code) });
    } catch (err) {
      next(err);
    }
  });

  // 업종 구성종목
  router.get("/sector/:market/:code/stocks", async (req, res, next) => {
    try {
      const market = req.params.market === "kosdaq" ? "kosdaq" : "kospi";
      res.json({ items: await getSectorStocks(client, market, req.params.code) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
