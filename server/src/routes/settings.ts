import { Router } from "express";
import { getHistory, getTotals, getUsage } from "../apiUsage.js";
import { summarize } from "../summarize.js";
import { getMenuPrefs, saveMenuPrefs } from "../menuPrefs.js";
import { getBoardPrefs, saveBoardPrefs } from "../boardPrefs.js";
import { getUiPrefs, patchUiPrefs } from "../uiPrefs.js";
import { getCardOrder, saveCardOrder } from "../cardOrder.js";

export function createSettingsRouter(): Router {
  const router = Router();

  router.get("/usage", async (req, res, next) => {
    try {
      const day = typeof req.query.day === "string" ? req.query.day : undefined;
      res.json(await getUsage(day));
    } catch (err) {
      next(err);
    }
  });

  /** 보관 기간 전체의 AI 비용 — 하루치만 보면 "얼마 썼나"에 답을 못 한다 */
  router.get("/usage/totals", async (req, res, next) => {
    try {
      const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 30);
      res.json(await getTotals(days));
    } catch (err) {
      next(err);
    }
  });

  router.get("/usage/history", async (req, res, next) => {
    try {
      const days = Math.min(Number(req.query.days) || 14, 30);
      res.json({ history: await getHistory(days) });
    } catch (err) {
      next(err);
    }
  });

  /** 어떤 키가 설정되어 있는지만 알려준다 (값은 절대 내보내지 않음) */
  router.get("/keys", (_req, res) => {
    res.json({
      keys: [
        { name: "KIWOOM_APP_KEY", configured: Boolean(process.env.KIWOOM_APP_KEY) },
        { name: "KIWOOM_APP_SECRET", configured: Boolean(process.env.KIWOOM_APP_SECRET) },
        { name: "DART_API_KEY", configured: Boolean(process.env.DART_API_KEY) },
        { name: "NAVER_CLIENT_ID", configured: Boolean(process.env.NAVER_CLIENT_ID) },
        { name: "NAVER_CLIENT_SECRET", configured: Boolean(process.env.NAVER_CLIENT_SECRET) },
        { name: "ANTHROPIC_API_KEY", configured: Boolean(process.env.ANTHROPIC_API_KEY) },
        { name: "TELEGRAM_BOT_TOKEN", configured: Boolean(process.env.TELEGRAM_BOT_TOKEN) },
        { name: "TELEGRAM_CHAT_ID", configured: Boolean(process.env.TELEGRAM_CHAT_ID) },
        { name: "NAVER_MAIL_USER", configured: Boolean(process.env.NAVER_MAIL_USER) },
        { name: "NAVER_MAIL_PASS", configured: Boolean(process.env.NAVER_MAIL_PASS) },
      ],
      isMock: process.env.KIWOOM_IS_MOCK === "true",
    });
  });

  /** Claude 연결 테스트 — 실제 호출이라 토큰 사용량에도 반영된다 */
  router.post("/claude/test", async (_req, res, next) => {
    try {
      const r = await summarize("'연결 성공'이라고만 답해줘.", 50);
      res.json({ ok: r.text !== null, ...r });
    } catch (err) {
      next(err);
    }
  });

  /*
   * 사이드바 메뉴 설정 — 서버에 둔다.
   * 미니PC 에서 정한 즐겨찾기를 폰에서도 그대로 봐야 한다.
   */
  router.get("/menu", async (_req, res, next) => {
    try {
      res.json(await getMenuPrefs());
    } catch (err) {
      next(err);
    }
  });

  router.put("/menu", async (req, res, next) => {
    try {
      res.json(await saveMenuPrefs(req.body));
    } catch (err) {
      next(err);
    }
  });

  /*
   * 화면 설정 **전부** — 키 하나에 값 하나.
   *
   * 설정마다 저장소를 따로 만들다 보니 급할 때는 그냥 localStorage 에 넣게 됐고
   * 그렇게 열네 개가 이 기기에만 쌓였다. 새 설정을 넣는 일이 **로컬에 넣는 것만큼
   * 쉬워야** 전역이 기본이 된다.
   *
   * PUT 은 **합친다**(덮어쓰지 않는다). 창이 여럿이면 각자 자기가 바꾼 것만 보내는데
   * 통째로 갈아치우면 다른 창이 방금 바꾼 설정이 사라진다.
   */
  router.get("/ui", async (_req, res, next) => {
    try {
      res.json(await getUiPrefs());
    } catch (err) {
      next(err);
    }
  });

  router.put("/ui", async (req, res, next) => {
    try {
      res.json({ values: await patchUiPrefs(req.body) });
    } catch (err) {
      next(err);
    }
  });

  /*
   * 보드 화면 구성 — **창끼리 덮어쓰던 것을 여기로 옮겼다.**
   * localStorage 는 창끼리 공유돼서, 창 A 가 K1 을 불러오면 창 B 의 K2 를 지웠다.
   */
  router.get("/board", async (_req, res, next) => {
    try {
      res.json(await getBoardPrefs());
    } catch (err) {
      next(err);
    }
  });

  router.put("/board", async (req, res, next) => {
    try {
      res.json(await saveBoardPrefs(req.body));
    } catch (err) {
      next(err);
    }
  });

  /* 화면 카드 배치 — 즐겨찾기와 같은 이유로 서버에 둔다 */
  router.get("/cards", async (_req, res, next) => {
    try {
      res.json(await getCardOrder());
    } catch (err) {
      next(err);
    }
  });

  router.put("/cards", async (req, res, next) => {
    try {
      res.json(await saveCardOrder(req.body));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
