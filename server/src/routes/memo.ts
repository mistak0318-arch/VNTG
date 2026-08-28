import express, { Router } from "express";
import {
  addMemo,
  addMemoFile,
  listMemos,
  listMemoTags,
  memosOfStock,
  readMemoFile,
  removeMemo,
  removeMemoFile,
  updateMemo,
} from "../memoPad.js";

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

  /** 이 종목에 매어 둔 메모 — 종목 상세의 「메모」 탭이 읽는다 */
  router.get("/stock/:code", async (req, res, next) => {
    try {
      res.json({ items: await memosOfStock(req.params.code) });
    } catch (err) {
      next(err);
    }
  });

  router.patch("/:id", async (req, res, next) => {
    try {
      const { title, body, tags, pinned, stocks } = req.body ?? {};
      res.json({
        memo: await updateMemo(req.params.id, {
          ...(title !== undefined ? { title: String(title) } : {}),
          ...(body !== undefined ? { body: String(body) } : {}),
          ...(tags !== undefined ? { tags: Array.isArray(tags) ? tags.map(String) : [] } : {}),
          ...(pinned !== undefined ? { pinned: Boolean(pinned) } : {}),
          ...(stocks !== undefined
            ? {
                stocks: Array.isArray(stocks)
                  ? stocks.map((s: { code?: unknown; name?: unknown }) => ({
                      code: String(s?.code ?? ""),
                      name: String(s?.name ?? ""),
                    }))
                  : [],
              }
            : {}),
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

  /* ---------------- 붙임 파일 (2026-08-28) ---------------- */

  /**
   * 올리기 — **바이너리 그대로** 받는다.
   *
   * 이 앱의 다른 업로드(캘린더 이미지)는 base64 를 JSON 에 실어 보내는데, 그건
   * 크기가 3분의 1 늘어난다. 동영상까지 붙이는 자리라 그 낭비가 크다.
   * 파일 이름과 형식은 헤더로 받는다 — 이름에 한글·공백이 흔해서 URL 에 넣으면
   * 인코딩이 어긋나기 쉬우므로 **base64 로 감싸서** 보낸다.
   */
  router.post(
    "/:id/files",
    express.raw({ type: "*/*", limit: "30mb" }),
    async (req, res, next) => {
      try {
        const name = Buffer.from(String(req.header("x-file-name") ?? ""), "base64").toString("utf-8");
        const mime = String(req.header("x-file-type") ?? "application/octet-stream");
        const buf = req.body as Buffer;
        if (!Buffer.isBuffer(buf) || buf.length === 0) {
          res.status(400).json({ error: "파일이 비어 있습니다." });
          return;
        }
        res.json({ file: await addMemoFile(req.params.id, { name: name || "파일", mime, buf }) });
      } catch (err) {
        next(err);
      }
    },
  );

  /**
   * 내려받기·미리보기 — 같은 자리에서 준다.
   * `?inline=1` 이면 브라우저가 열고(이미지·PDF·영상 미리보기), 아니면 내려받는다.
   */
  router.get("/:id/files/:fileId", async (req, res, next) => {
    try {
      const { meta, buf } = await readMemoFile(req.params.id, req.params.fileId);
      const inline = req.query.inline === "1";
      res.setHeader("Content-Type", meta.mime);
      res.setHeader("Content-Length", String(buf.length));
      /*
       * 파일 이름에 한글이 흔하다 — `filename*` (RFC 5987) 로 줘야 안 깨진다.
       * 옛 브라우저용 `filename` 도 같이 두되 ASCII 로만 적는다.
       */
      res.setHeader(
        "Content-Disposition",
        `${inline ? "inline" : "attachment"}; filename="file"; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
      );
      res.end(buf);
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:id/files/:fileId", async (req, res, next) => {
    try {
      await removeMemoFile(req.params.id, req.params.fileId);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
