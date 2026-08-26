import { Router } from "express";
import {
  addGroup,
  addStock,
  evaluateGroups,
  invalidateUsCache,
  reorderCachedGroup,
  listGroups,
  quoteSymbol,
  removeGroup,
  removeStock,
  reorderGroups,
  reorderStocks,
  patchCachedGroups,
  searchUs,
  stubQuoteRow,
  updateGroup,
  updateStock,
} from "../usWatchlist.js";
import { usFastQuotes } from "../usFastQuotes.js";

/** 미국 관심종목 */
export function createUsWatchRouter(): Router {
  const router = Router();

  router.get("/", async (req, res, next) => {
    try {
      res.json(await evaluateGroups(req.query.force === "1"));
    } catch (err) {
      next(err);
    }
  });

  /** 편집용 원본 (시세 없이) */
  /**
   * 빠른 시세 — 야후 spark 배치(현재가·등락률만). 4초 캐시.
   * 화면이 지금 보는 그룹의 심볼만 3초로 물어 표에 덧씌운다 — 본 시세(1분 캐시)는
   * 원화·52주 같은 무거운 값을 그대로 맡는다.
   */
  router.get("/fast", async (req, res, next) => {
    try {
      const symbols = String(req.query.symbols ?? "")
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean)
        .slice(0, 60);
      const got = await usFastQuotes(symbols);
      res.json({ quotes: Object.fromEntries(got) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/raw", async (_req, res, next) => {
    try {
      res.json({ groups: await listGroups() });
    } catch (err) {
      next(err);
    }
  });

  router.get("/search", async (req, res, next) => {
    try {
      res.json({ results: await searchUs(String(req.query.q ?? "")) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/quote/:symbol", async (req, res, next) => {
    try {
      res.json({ price: await quoteSymbol(req.params.symbol) });
    } catch (err) {
      next(err);
    }
  });

  /*
   * ⚠️ 그룹·종목 **구성** 변경은 캐시를 버리지 않는다 (2026-08-27 — "왜 이렇게
   * 딜레이?"). invalidate + evaluateGroups 는 전 종목 시세 한 바퀴(6~8초)를
   * 기다리는 길이었다. 구성만 캐시에서 수술하고(patchCachedGroups) 바로 돌려준다 —
   * 순서 변경(reorderCachedGroup)이 먼저 깐 길과 같은 원리다.
   * 수술이 안 되면(캐시 없음) 그때만 예전처럼 새로 받는다.
   */
  router.post("/groups", async (req, res, next) => {
    try {
      const name = String(req.body?.name ?? "").trim();
      if (!name) {
        res.status(400).json({ error: "그룹 이름이 필요합니다." });
        return;
      }
      const rows = await addGroup(name, String(req.body?.memo ?? ""));
      const made = rows[rows.length - 1];
      const ok = await patchCachedGroups((groups) => {
        groups.push({ id: made.id, name: made.name, memo: made.memo, changeRate: null, rising: 0, falling: 0, stocks: [] });
      });
      if (!ok) invalidateUsCache();
      res.json(await evaluateGroups());
    } catch (err) {
      next(err);
    }
  });

  router.patch("/groups/:id", async (req, res, next) => {
    try {
      await updateGroup(req.params.id, req.body ?? {});
      const ok = await patchCachedGroups((groups) => {
        const g = groups.find((x) => x.id === req.params.id);
        if (!g) return;
        if (typeof req.body?.name === "string") g.name = req.body.name.slice(0, 60);
        if (typeof req.body?.memo === "string") g.memo = req.body.memo.slice(0, 200);
      });
      if (!ok) invalidateUsCache();
      res.json(await evaluateGroups());
    } catch (err) {
      next(err);
    }
  });

  router.delete("/groups/:id", async (req, res, next) => {
    try {
      await removeGroup(req.params.id);
      const ok = await patchCachedGroups((groups) => {
        const i = groups.findIndex((x) => x.id === req.params.id);
        if (i >= 0) groups.splice(i, 1);
      });
      if (!ok) invalidateUsCache();
      res.json(await evaluateGroups());
    } catch (err) {
      next(err);
    }
  });

  router.put("/groups/order", async (req, res, next) => {
    try {
      const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
      await reorderGroups(ids);
      const rank = new Map(ids.map((id, i) => [id, i]));
      const ok = await patchCachedGroups((groups) => {
        groups.sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999));
      });
      if (!ok) invalidateUsCache();
      res.json(await evaluateGroups());
    } catch (err) {
      next(err);
    }
  });

  router.put("/groups/:id/stocks/order", async (req, res, next) => {
    try {
      const symbols = Array.isArray(req.body?.symbols) ? req.body.symbols.map(String) : [];
      await reorderStocks(req.params.id, symbols);
      /*
       * **캐시를 버리지 않는다.** 순서를 바꾼다고 가격이 변하지는 않는다.
       * 버리면 164종목 시세를 다시 받느라 ▲ 한 번에 6~8초가 걸린다 —
       * 손에 있는 값의 줄 순서만 고쳐 주면 즉시 끝난다.
       */
      await reorderCachedGroup(req.params.id, symbols);
      res.json(await evaluateGroups());
    } catch (err) {
      next(err);
    }
  });

  router.post("/groups/:id/stocks", async (req, res, next) => {
    try {
      const symbol = String(req.body?.symbol ?? "").trim();
      if (!symbol) {
        res.status(400).json({ error: "티커가 필요합니다." });
        return;
      }
      /*
       * 편입가를 안 주면 지금 가격으로 채운다. "담은 뒤로 얼마나 움직였나"를 재는 게
       * 목적이라 담은 순간의 가격이 기준으로 맞다.
       */
      const addedPrice =
        req.body?.addedPrice != null ? Number(req.body.addedPrice) : await quoteSymbol(symbol);
      const name = String(req.body?.name ?? symbol);
      await addStock(req.params.id, {
        symbol,
        name,
        addedPrice,
        memo: String(req.body?.memo ?? ""),
      });
      /* 임시 줄을 바로 꽂는다 — 본 시세(52주·원화 등)는 다음 배경 갱신이 채운다 */
      const ok = await patchCachedGroups((groups) => {
        const g = groups.find((x) => x.id === req.params.id);
        if (g && !g.stocks.some((s) => s.symbol === symbol)) {
          g.stocks.push(stubQuoteRow(symbol, name, addedPrice));
        }
      });
      if (!ok) invalidateUsCache();
      res.json(await evaluateGroups());
    } catch (err) {
      next(err);
    }
  });

  router.patch("/groups/:id/stocks/:symbol", async (req, res, next) => {
    try {
      await updateStock(req.params.id, req.params.symbol, req.body ?? {});
      const ok = await patchCachedGroups((groups) => {
        const s = groups
          .find((x) => x.id === req.params.id)
          ?.stocks.find((x) => x.symbol === req.params.symbol);
        if (!s) return;
        if (typeof req.body?.name === "string") s.name = req.body.name;
        if (typeof req.body?.memo === "string") s.memo = req.body.memo;
        if (req.body?.addedPrice != null) s.addedPrice = Number(req.body.addedPrice);
      });
      if (!ok) invalidateUsCache();
      res.json(await evaluateGroups());
    } catch (err) {
      next(err);
    }
  });

  router.delete("/groups/:id/stocks/:symbol", async (req, res, next) => {
    try {
      await removeStock(req.params.id, req.params.symbol);
      const ok = await patchCachedGroups((groups) => {
        const g = groups.find((x) => x.id === req.params.id);
        if (g) g.stocks = g.stocks.filter((s) => s.symbol !== req.params.symbol);
      });
      if (!ok) invalidateUsCache();
      res.json(await evaluateGroups());
    } catch (err) {
      next(err);
    }
  });

  return router;
}
