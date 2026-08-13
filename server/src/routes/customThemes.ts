import { Router } from "express";
import {
  createTheme,
  evaluateThemes,
  listThemes,
  removeTheme,
  toggleStock,
  updateTheme,
} from "../customThemes.js";
import type { KiwoomClient } from "../kiwoomClient.js";
import { getThemeStocks } from "../marketOverview.js";
import { listWatchlist } from "../watchlist.js";

export function createCustomThemeRouter(client: KiwoomClient): Router {
  const router = Router();

  /** 등락률까지 계산해서 준다 */
  router.get("/", async (req, res, next) => {
    try {
      res.json(await evaluateThemes(client, req.query.force === "1"));
    } catch (err) {
      next(err);
    }
  });

  /** 편집용 원본 (계산 없이 빠르게) */
  router.get("/raw", async (_req, res, next) => {
    try {
      res.json({ themes: await listThemes() });
    } catch (err) {
      next(err);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const body = req.body ?? {};
      res.json({
        themes: await createTheme({
          name: body.name,
          memo: body.memo,
          codes: body.codes,
          color: body.color,
          source: body.source === "infostock" ? "infostock" : "manual",
        }),
      });
    } catch (err) {
      next(err);
    }
  });

  router.patch("/:id", async (req, res, next) => {
    try {
      res.json({ themes: await updateTheme(req.params.id, req.body ?? {}) });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:id", async (req, res, next) => {
    try {
      res.json({ themes: await removeTheme(req.params.id) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/stocks/:code", async (req, res, next) => {
    try {
      res.json({ themes: await toggleStock(req.params.id, req.params.code) });
    } catch (err) {
      next(err);
    }
  });

  /**
   * 키움 테마에서 복사해서 시작.
   * 빈 화면에서 종목을 하나씩 찾는 것보다, 기존 테마를 불러와 빼고 더하는 게 빠르다.
   */
  router.post("/from-theme/:themeCode", async (req, res, next) => {
    try {
      const rows = await getThemeStocks(client, req.params.themeCode);
      const name = String(req.body?.name ?? "").trim();
      if (!name) throw new Error("테마 이름을 입력하세요.");
      res.json({
        themes: await createTheme({
          name,
          memo: String(req.body?.memo ?? ""),
          codes: rows.map((r) => r.code),
        }),
      });
    } catch (err) {
      next(err);
    }
  });

  /** 관심종목에서 한 번에 만들기 */
  router.post("/from-watchlist", async (req, res, next) => {
    try {
      const group = req.body?.group ? String(req.body.group) : null;
      const items = await listWatchlist();
      const picked = group ? items.filter((w) => (w.group ?? "기본") === group) : items;
      const name = String(req.body?.name ?? "").trim();
      if (!name) throw new Error("테마 이름을 입력하세요.");
      if (picked.length === 0) throw new Error("담을 관심종목이 없습니다.");
      res.json({
        themes: await createTheme({
          name,
          memo: String(req.body?.memo ?? ""),
          codes: picked.map((w) => w.code),
        }),
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
