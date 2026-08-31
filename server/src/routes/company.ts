import { Router } from "express";
import { cachedBrief, companyBrief, companyFacts } from "../companyInfo.js";

/**
 * 6자리만 남긴다.
 *
 * 키움은 자리에 따라 `A005930`(접두)이나 `005930_AL`(접미)로도 준다. DART 와 한투는
 * 순수 6자리만 받으므로 여기서 눕혀 놓지 않으면 「없는 회사」가 된다.
 */
function code6(v: string): string {
  const m = String(v ?? "").match(/\d{6}/);
  return m ? m[0] : "";
}

/**
 * 종목 정보 — 「이 회사가 뭐 하는 데더라」.
 *
 * ## 길이 셋인 이유
 *
 * 화면이 열릴 때 도는 것과 **버튼을 눌러야 도는 것**을 라우트 수준에서 갈라 놨다.
 * 한 라우트에 `?run=1` 같은 걸 달면, 언젠가 화면 어딘가에서 실수로 켜져
 * 종목을 훑기만 해도 토큰이 나가게 된다. **비싼 길은 POST 로만** 열어 둔다 —
 * 실수로 GET 을 부를 수는 있어도 실수로 POST 를 부르기는 어렵다.
 *
 *   GET  /:code/facts   정적 사실. DART 1콜 + 한투 1콜, 30일 캐시
 *   GET  /:code/brief   **이미 엮어 둔 것만.** 조회 0회, AI 0회
 *   POST /:code/brief   AI 엮기 실행 ← 버튼
 */
export function createCompanyRouter(): Router {
  const router = Router();

  router.get("/:code/facts", async (req, res, next) => {
    try {
      const code = code6(req.params.code);
      res.json({ facts: await companyFacts(code, req.query.force === "1") });
    } catch (err) {
      next(err);
    }
  });

  /** 캐시만 본다 — 없으면 `brief: null`. 화면은 그때 버튼을 보여 준다 */
  router.get("/:code/brief", async (req, res, next) => {
    try {
      const code = code6(req.params.code);
      res.json({ brief: await cachedBrief(code) });
    } catch (err) {
      next(err);
    }
  });

  /**
   * 엮기 실행.
   *
   * 같은 날 이미 엮은 것이 있으면 **다시 안 부르고** 그것을 돌려준다
   * (`force: true` 면 부른다). 화면이 `ran` 으로 「방금 돈 것인가」를 구별해
   * 「오늘 것을 다시 씁니다 — 비용 0」을 보여 줄 수 있다.
   */
  router.post("/:code/brief", async (req, res, next) => {
    try {
      const code = code6(req.params.code);
      const body = req.body as { name?: string; force?: boolean; price?: number | null };
      const name = String(body?.name ?? "").trim();
      if (!name) {
        res.status(400).json({ error: "종목명(name)이 필요합니다" });
        return;
      }
      const out = await companyBrief(code, name, {
        run: true,
        force: Boolean(body?.force),
        price: typeof body?.price === "number" ? body.price : null,
      });
      res.json(out);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
