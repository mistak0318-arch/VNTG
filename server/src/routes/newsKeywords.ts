import { Router } from "express";
import { collectNewsKeywords, keywordFlow, type KeywordHit } from "../newsKeywords.js";
import { evaluateBuzz } from "../buzzRadar.js";

/**
 * 키워드 흐름 창구.
 *
 * ## 「양쪽 확인」이 여기서 붙는다
 *
 * 뉴스 급증 목록에, **텔레그램 채널에서도 급증한 낱말**인지를 표시해 준다.
 * 두 소스는 편향이 반대라(뉴스=느리고 공식적, 채널=빠르고 투기적) 양쪽이 같이
 * 떴다는 것은 「빠른 쪽이 먼저 말했고 느린 쪽이 확인해 준」 뜻이다.
 *
 * 채널 쪽이 꺼져 있거나(세션 없음) 기준선이 모자라면 그냥 표시를 안 한다 —
 * 없는 확인을 있는 척하지 않는다.
 */
export function createNewsKeywordRouter(): Router {
  const router = Router();

  router.get("/flow", async (req, res, next) => {
    try {
      const win = Number(req.query.window ?? 60);
      const flow = await keywordFlow(Number.isFinite(win) ? win : 60);

      /*
       * 채널 쪽은 12시간 창이 기본이다. 뉴스 창이 10분이어도 채널 12시간과 견주는 게
       * 맞다 — 채널이 **먼저** 말하는 쪽이라 시차를 두고 보는 것이 이 비교의 요점이다.
       */
      let buzzTerms = new Map<string, number>();
      let buzzReady = false;
      try {
        const b = await evaluateBuzz(12);
        if (b.baselineDays >= 3) {
          buzzReady = true;
          for (const h of b.hits) buzzTerms.set(h.term, h.ratio);
        }
      } catch {
        /* 채널 쪽이 죽어도 뉴스 흐름은 그대로 보여 준다 */
      }

      const hits = flow.hits.map((h: KeywordHit) => ({
        ...h,
        /** 채널에서도 급증했나 — null 이면 「확인할 수 없음」이지 「아니오」가 아니다 */
        buzzRatio: buzzReady ? (buzzTerms.get(h.term) ?? 0) : null,
      }));

      res.json({ ...flow, hits, buzzReady });
    } catch (err) {
      next(err);
    }
  });

  /** 지금 당장 한 바퀴 — 화면의 새로고침 단추가 부른다 */
  router.post("/collect", async (_req, res, next) => {
    try {
      res.json(await collectNewsKeywords());
    } catch (err) {
      next(err);
    }
  });

  return router;
}
