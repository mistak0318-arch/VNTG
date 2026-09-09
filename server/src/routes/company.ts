import { Router } from "express";
import { cachedBrief, companyBrief, companyFacts } from "../companyInfo.js";
import { creditInfo } from "../orders.js";
import { naverBoard } from "../naverBoard.js";

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

  /**
   * **신용으로 살 수 있는 종목인가** (2026-09-08 — 벤티지 "종목상세에 종목명 앞에 코스피 써놨잖아
   * 그 옆에 주문메뉴처럼 신용 관련 아이콘도 하나 넣어줄래?").
   *
   * 주문 라우터가 아니라 **여기**다. kt20017 은 계좌가 아니라 종목의 성질이라(키움 앱도 로그인
   * 없이 보여 준다) 주문 세션을 요구할 이유가 없다. 주문 앱키가 없으면 `allowed: null` —
   * 화면은 그때 아무것도 안 단다. 한 시간 캐시라 상세를 여닫아도 조회가 늘지 않는다.
   */
  router.get("/:code/credit", async (req, res, next) => {
    try {
      res.json(await creditInfo(code6(req.params.code)));
    } catch (err) {
      next(err);
    }
  });

  /**
   * **네이버 종목토론실** (2026-09-09 — 벤티지 "종목상세 마지막 탭에 네이버 종목토론실
   * 연결해서 보여줄 수 있나?").
   *
   * 화면이 열려 있을 때만 부른다 — 배경 수집기는 두지 않는다(종목이 3,900개다).
   * `offset` 은 앞 쪽 응답의 `next` 를 그대로 돌려주는 자리다.
   */
  router.get("/:code/board", async (req, res, next) => {
    try {
      const offset = typeof req.query.offset === "string" ? req.query.offset : undefined;
      res.json(await naverBoard(code6(req.params.code), offset));
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
