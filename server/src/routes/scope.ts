import { Router } from "express";
import type { KiwoomClient } from "../kiwoomClient.js";
import { scopeDetail, scopeList, scopeRemove, setScopeNote } from "../scope.js";

/**
 * /api/scope — **현미경**(매수 직전) 화면의 창구 (2026-09-07).
 *
 * 종목을 **넣는** 창구는 여기 없다 — 관심종목의 그룹 담기가 그 일을 한다(어느 화면의
 * 담기 시트에서든 「현미경」에 체크). 여기는 보고, 메모하고, 빼는 것까지다.
 * 주문도 여기서 안 나간다 — 「뭘 살지 고르는」 화면이지 사는 화면이 아니다.
 */
export function createScopeRouter(client: KiwoomClient): Router {
  const router = Router();

  router.get("/", async (_req, res, next) => {
    try {
      res.json(await scopeList(client));
    } catch (e) {
      next(e);
    }
  });

  router.get("/:code", async (req, res, next) => {
    try {
      const d = await scopeDetail(client, String(req.params.code));
      if (!d) {
        res.status(404).json({ error: "현미경에 없는 종목입니다" });
        return;
      }
      res.json(d);
    } catch (e) {
      next(e);
    }
  });

  router.put("/:code/note", async (req, res, next) => {
    try {
      const note = typeof req.body?.note === "string" ? req.body.note : "";
      res.json({ note: await setScopeNote(String(req.params.code), note) });
    } catch (e) {
      next(e);
    }
  });

  router.delete("/:code", async (req, res, next) => {
    try {
      res.json({ ok: await scopeRemove(String(req.params.code)) });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
