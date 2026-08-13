import { Router } from "express";
import type { KiwoomClient } from "../kiwoomClient.js";
import { addNote, listAllNotes, listNotes, removeNote, updateNote } from "../stockNotes.js";

export function createNotesRouter(client: KiwoomClient): Router {
  const router = Router();

  /** 최근 메모 전체 — 마이페이지·리포트에서 훑어볼 용도 */
  router.get("/recent", async (req, res, next) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 30, 100);
      res.json({ items: await listAllNotes(limit) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:code", async (req, res, next) => {
    try {
      res.json(await listNotes(req.params.code));
    } catch (err) {
      next(err);
    }
  });

  router.post("/:code", async (req, res, next) => {
    try {
      const { name, text } = req.body ?? {};
      res.json(await addNote(client, req.params.code, String(name ?? ""), String(text ?? "")));
    } catch (err) {
      next(err);
    }
  });

  router.patch("/:code/:id", async (req, res, next) => {
    try {
      res.json(await updateNote(req.params.code, req.params.id, String(req.body?.text ?? "")));
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:code/:id", async (req, res, next) => {
    try {
      res.json(await removeNote(req.params.code, req.params.id));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
