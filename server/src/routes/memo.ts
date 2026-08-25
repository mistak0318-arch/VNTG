import { Router } from "express";
import { addMemo, listMemos, listMemoTags, removeMemo, updateMemo } from "../memoPad.js";

/** 메모장 — 자유 메모 + 일기. 종목 메모(/api/notes)와 다른 자리다 */
export function createMemoRouter(): Router {
  const router = Router();

  router.get("/", async (req, res, next) => {
    try {
      const q = typeof req.query.q === "string" ? req.query.q : "";
      const tag = typeof req.query.tag === "string" ? req.query.tag : "";
      res.json({ items: await listMemos(q, tag) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/tags", async (_req, res, next) => {
    try {
      res.json({ tags: await listMemoTags() });
    } catch (err) {
      next(err);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const { title, body, tags } = req.body ?? {};
      if (!String(title ?? "").trim() && !String(body ?? "").trim()) {
        res.status(400).json({ error: "제목이나 내용 중 하나는 있어야 합니다." });
        return;
      }
      res.json({
        memo: await addMemo({
          title: String(title ?? ""),
          body: String(body ?? ""),
          tags: Array.isArray(tags) ? tags.map(String) : [],
        }),
      });
    } catch (err) {
      next(err);
    }
  });

  router.patch("/:id", async (req, res, next) => {
    try {
      const { title, body, tags, pinned } = req.body ?? {};
      res.json({
        memo: await updateMemo(req.params.id, {
          ...(title !== undefined ? { title: String(title) } : {}),
          ...(body !== undefined ? { body: String(body) } : {}),
          ...(tags !== undefined ? { tags: Array.isArray(tags) ? tags.map(String) : [] } : {}),
          ...(pinned !== undefined ? { pinned: Boolean(pinned) } : {}),
        }),
      });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:id", async (req, res, next) => {
    try {
      await removeMemo(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
