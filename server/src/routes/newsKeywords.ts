import { Router } from "express";
import { collectNewsKeywords, keywordFlow, type KeywordHit } from "../newsKeywords.js";
import { buzzBoard } from "../buzzRadar.js";

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
       * ⚠️ **뉴스와 같은 창으로 견준다** (2026-08-30).
       *
       * 예전엔 채널 쪽을 12시간 고정으로 봤다 — 「채널이 먼저 말하니 시차를 두고
       * 보자」는 뜻이었는데, 화면에서는 그 사실이 안 보였다. 위에서 3시간을 고르고
       * 아래 「양쪽」 배지는 12시간짜리를 쓰니 **같은 3시간인데 왜 다르냐**는
       * 물음이 나왔다. 자가 다르면 비교가 아니다.
       *
       * 채널은 표본이 적어 30분짜리 창은 쓸모가 없으므로 **최소 1시간**으로 올린다.
       */
      const hours = Math.max(1, Math.round(flow.windowMin / 60));
      const buzzTerms = new Map<string, number>();
      let buzzReady = false;
      try {
        const b = await buzzBoard(hours);
        if (b.baselineDays >= 3) {
          buzzReady = true;
          for (const r of b.rows) if (r.alerted) buzzTerms.set(r.term, r.ratio);
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
