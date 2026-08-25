import { Router } from "express";
import type { KiwoomClient } from "../kiwoomClient.js";
import { getKiwoomGroupStocks, listKiwoomGroups } from "../kiwoomWatchlist.js";
import { getTrackedWatchlist, invalidateTrackingCache, invalidateTracking } from "../watchTracking.js";
import {
  addGroup,
  addWatchItem,
  listGroups,
  listWatchlist,
  removeGroup,
  removeWatchItem,
  renameGroup,
  reorderGroups,
  DEFAULT_GROUP,
  reorderWatch,
  addDivider,
  toggleWatchGroup,
  updateWatchItem,
  WATCH_STATUSES,
  type WatchStatus,
} from "../watchlist.js";

export function createWatchlistRouter(client: KiwoomClient): Router {
  const router = Router();

  /** 상태 목록 — 화면이 서버와 같은 말을 쓰게 한다 */
  router.get("/statuses", (_req, res) => {
    res.json({ statuses: WATCH_STATUSES });
  });

  router.get("/", async (_req, res, next) => {
    try {
      res.json({ items: await listWatchlist() });
    } catch (err) {
      next(err);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const { code, name, addedPrice, memo, group, groups } = req.body ?? {};
      if (typeof code !== "string" || !code) {
        res.status(400).json({ error: "code는 필수입니다." });
        return;
      }
      /*
       * **`groups` 를 반드시 넘긴다.**
       *
       * 화면(`WatchAddSheet`)은 내가 고른 그룹들을 `groups` 배열로 보내는데,
       * 예전엔 여기서 `group` 단수만 꺼내 쓰고 배열을 **통째로 버렸다.**
       * 그래서 어느 그룹을 골라도 항상 기본 그룹으로 들어갔다.
       * `addWatchItem` 은 처음부터 둘 다 받게 돼 있었다 — 중간에서 잃어버린 것이다.
       */
      const items = await addWatchItem({
        code,
        name: typeof name === "string" ? name : code,
        addedPrice: Number(addedPrice) || 0,
        memo: typeof memo === "string" ? memo : "",
        group: typeof group === "string" ? group : undefined,
        groups: Array.isArray(groups)
          ? groups.filter((g): g is string => typeof g === "string" && g.trim().length > 0)
          : undefined,
      });
      invalidateTrackingCache();
      res.json({ items });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:code", async (req, res, next) => {
    try {
      const items = await removeWatchItem(req.params.code);
      invalidateTrackingCache();
      res.json({ items });
    } catch (err) {
      next(err);
    }
  });

  router.patch("/:code", async (req, res, next) => {
    try {
      const { memo, addedPrice, group, status } = req.body ?? {};
      const items = await updateWatchItem(req.params.code, {
        memo: typeof memo === "string" ? memo : undefined,
        addedPrice: addedPrice === undefined ? undefined : Number(addedPrice),
        group: typeof group === "string" ? group : undefined,
        // 모르는 값은 watchlist 쪽에서 걸러 낸다 — 여기서 두 번 검사하면 규칙이 두 군데가 된다
        status: typeof status === "string" ? (status as WatchStatus) : undefined,
      });
      invalidateTrackingCache();
      res.json({ items });
    } catch (err) {
      next(err);
    }
  });

  // 키움 MTS/HTS에 등록된 관심종목 그룹 (읽기 전용)
  router.get("/kiwoom/groups", async (_req, res, next) => {
    try {
      res.json({ groups: await listKiwoomGroups(client) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/kiwoom/groups/:code", async (req, res, next) => {
    try {
      res.json({ items: await getKiwoomGroupStocks(client, req.params.code) });
    } catch (err) {
      next(err);
    }
  });

  // 마이페이지용 — 관심종목 + 수급/정배열 추적 지표
  router.get("/tracking", async (req, res, next) => {
    try {
      const force = req.query.force === "1";
      res.json({ items: await getTrackedWatchlist(client, force) });
    } catch (err) {
      next(err);
    }
  });

  // ---------------- 관심종목 그룹 ----------------

  router.get("/groups", async (_req, res, next) => {
    try {
      res.json({ groups: await listGroups() });
    } catch (err) {
      next(err);
    }
  });

  router.post("/groups", async (req, res, next) => {
    try {
      const name = typeof req.body?.name === "string" ? req.body.name : "";
      res.json({ groups: await addGroup(name) });
    } catch (err) {
      next(err);
    }
  });

  /*
   * 순서 바꾸기. `/groups/:name` 보다 **먼저** 등록해야 한다 —
   * 아래 patch 가 `:name` 을 무엇이든 받으므로 "reorder" 를 그룹 이름으로 먹어 버린다.
   */
  router.put("/groups/reorder", async (req, res, next) => {
    try {
      const order = Array.isArray(req.body?.order)
        ? (req.body.order as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      res.json({ groups: await reorderGroups(order) });
    } catch (err) {
      next(err);
    }
  });

  router.patch("/groups/:name", async (req, res, next) => {
    try {
      const to = typeof req.body?.name === "string" ? req.body.name : "";
      res.json({ groups: await renameGroup(decodeURIComponent(req.params.name), to) });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/groups/:name", async (req, res, next) => {
    try {
      const groups = await removeGroup(decodeURIComponent(req.params.name));
      invalidateTrackingCache();
      res.json({ groups });
    } catch (err) {
      next(err);
    }
  });

  /** 그룹 하나를 넣거나 뺀다 (표에서 칩 토글) */
  /**
   * 그룹 안 **종목 순서**를 바꾼다 — 화면이 보이는 순서를 통째로 보낸다.
   *
   * ⚠️ `/:code/...` 보다 **위**에 둔다. 아래 있으면 `reorder` 가 종목코드로 먹힌다.
   */
  router.put("/reorder", async (req, res, next) => {
    try {
      const group = String(req.body?.group ?? "").trim() || DEFAULT_GROUP;
      const codes = Array.isArray(req.body?.codes) ? req.body.codes.map(String) : [];
      const items = await reorderWatch(group, codes);
      /* 순서가 바뀌었으니 추적 캐시도 버린다 — 안 그러면 새로고침에 옛 순서가 돌아온다 */
      invalidateTracking();
      res.json({ items });
    } catch (err) {
      next(err);
    }
  });

  /** 구분선 한 줄 넣기 — 종목 사이를 눈으로 가르는 빈 줄 */
  router.post("/divider", async (req, res, next) => {
    try {
      const group = String(req.body?.group ?? "").trim() || DEFAULT_GROUP;
      const label = String(req.body?.label ?? "").trim().slice(0, 20);
      const items = await addDivider(group, label);
      invalidateTracking();
      res.json({ items });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:code/groups/:group", async (req, res, next) => {
    try {
      res.json({ items: await toggleWatchGroup(req.params.code, decodeURIComponent(req.params.group)) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
