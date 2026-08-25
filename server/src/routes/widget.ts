import { Router } from "express";
import type { KiwoomClient } from "../kiwoomClient.js";
import { widgetSummary } from "../widget.js";

/**
 * 위젯·워치 전용 — **한 번 부르면 화면 하나.**
 *
 * 바탕화면 위젯(Glance)이나 워치 타일이 쓸 자리다. 그런 데서는 조회를 여럿 부르면
 * 배터리가 먼저 죽는다. 한 덩어리를 받아 그대로 그린다.
 *
 * ⚠️ 이 앱은 **조회 전용**이다. 위젯도 마찬가지다 — 여기에 주문을 넣는 길은 없다.
 */
export function createWidgetRouter(client: KiwoomClient): Router {
  const router = Router();

  router.get("/summary", async (req, res, next) => {
    try {
      const limit = Number(req.query.limit) || 5;
      res.json(await widgetSummary(client, limit));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
