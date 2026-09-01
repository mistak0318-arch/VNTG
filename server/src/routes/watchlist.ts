import { Router } from "express";
import type { KiwoomClient } from "../kiwoomClient.js";
import { getKiwoomGroupStocks, listKiwoomGroups } from "../kiwoomWatchlist.js";
import { getMarketSnapshot } from "../marketSnapshot.js";
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
import { AUTO_GROUPS } from "../watchlist.js";
import { lastBandSync, syncScoreBands } from "../scoreBandSync.js";

export function createWatchlistRouter(client: KiwoomClient): Router {
  const router = Router();

  /**
   * 관심종목 통합(_AL) 시세 (2026-08-26) — 「관심종목에 NXT 값이 안 들어온다」.
   *
   * 화면 실시간 오버레이(0B)는 KRX 체결이라 NXT 프리(08:00~08:50)·애프터
   * (15:30~20:00)엔 조용하다. ka10095 는 여러 종목을 한 번에 받으므로,
   * `_AL` 로 통합 현재가·등락률만 가볍게 얹는다. 화면은 5초로 묻는다.
   */
  router.get("/quotes", async (_req, res, next) => {
    try {
      const items = await listWatchlist();
      const codes = [...new Set(items.map((i) => i.code).filter((c) => /^\d{6}$/.test(c)))];
      if (codes.length === 0) {
        res.json({ quotes: {} });
        return;
      }
      const { data } = await client.request<Record<string, unknown>>(
        "/api/dostk/stkinfo",
        "ka10095",
        { stk_cd: codes.map((c) => `${c}_AL`).join("|") },
      );
      const rows = Array.isArray(data.atn_stk_infr)
        ? (data.atn_stk_infr as Record<string, unknown>[])
        : [];
      const num = (v: unknown) => {
        const n = Number(String(v ?? "").replace(/[+,\s]/g, ""));
        return Number.isFinite(n) ? n : 0;
      };
      const quotes: Record<string, { price: number; changeRate: number }> = {};
      for (const r of rows) {
        const code = String(r.stk_cd ?? "").replace(/_(AL|NX)$/i, "");
        const price = Math.abs(num(r.cur_prc));
        if (code && price > 0) quotes[code] = { price, changeRate: num(r.flu_rt) };
      }
      res.json({ quotes });
    } catch (err) {
      next(err);
    }
  });

  /** 상태 목록 — 화면이 서버와 같은 말을 쓰게 한다 */
  router.get("/statuses", (_req, res) => {
    res.json({ statuses: WATCH_STATUSES });
  });

  /**
   * 섹터 집중도 (2026-08-25) — 「다 초록인데 전부 반도체」를 잡는 안전벨트.
   *
   * 관심종목 전체와 보유 표시분의 업종 분포를 스냅샷에서 세어 준다. 신호등이
   * 종목 하나하나는 봐도 **묶음이 한 방향으로 쏠렸는지**는 아무도 안 보고 있었다.
   * 조회는 0 — 이미 있는 전종목 스냅샷과 관심종목 목록만 겹쳐 센다.
   */
  router.get("/concentration", async (_req, res, next) => {
    try {
      const [items, snap] = await Promise.all([listWatchlist(), getMarketSnapshot(client)]);
      const dist = (rows: { code: string }[]) => {
        const bySector = new Map<string, number>();
        let counted = 0;
        for (const r of rows) {
          const s = snap.byCode.get(r.code)?.sector;
          if (!s) continue;
          counted += 1;
          bySector.set(s, (bySector.get(s) ?? 0) + 1);
        }
        return {
          total: counted,
          top: [...bySector.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([sector, count]) => ({
              sector,
              count,
              pct: counted > 0 ? (count / counted) * 100 : 0,
            })),
        };
      };
      const stocks = items.filter((i) => !i.divider);
      res.json({
        all: dist(stocks),
        holding: dist(stocks.filter((i) => i.status === "holding")),
      });
    } catch (err) {
      next(err);
    }
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
      /*
       * **자동 그룹이 무엇인지 같이 보낸다** (2026-09-01).
       *
       * 화면이 목록을 하드코딩하면 서버가 그룹을 늘렸을 때(점수대 넷이 그랬다)
       * 화면만 모르는 상태가 된다 — 자물쇠가 안 그려지고, 사용자는 고칠 수 있는
       * 줄 알고 고치다가 서버 오류를 본다.
       */
      res.json({ groups: await listGroups(), autoGroups: AUTO_GROUPS });
    } catch (err) {
      next(err);
    }
  });

  /** 점수대 그룹을 지금 맞춘다 — 조회 0회(저장된 회차·원장만 읽는다) */
  router.post("/groups/sync-bands", async (_req, res, next) => {
    try {
      res.json(await syncScoreBands());
    } catch (err) {
      next(err);
    }
  });

  /** 마지막 동기화가 언제·무엇이었나 */
  router.get("/groups/sync-bands", (_req, res) => {
    res.json({ last: lastBandSync() });
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

  /**
   * **일괄 처리** (2026-09-01 — "관심종목이 많으니깐 편집이 힘들다").
   *
   * 42종목을 하나씩 지우려면 요청이 42번 나가고, 그때마다 파일을 읽고 쓴다.
   * 중간에 하나가 실패하면 **어디까지 됐는지도 모른다.**
   *
   * 여기서는 한 번에 받아 한 번에 쓴다. 어느 종목이 처리됐는지도 돌려준다 —
   * 「42개 눌렀는데 40개만 지워졌다」를 화면이 알 수 있어야 한다.
   *
   * ⚠️ `/:code` 라우트보다 **먼저** 등록해야 한다. 아래 있으면 "bulk" 가
   * 종목코드로 먹힌다.
   */
  router.post("/bulk", async (req, res, next) => {
    try {
      const body = req.body as {
        codes?: string[];
        /** remove = 목록에서 뺀다 · group = 그룹을 넣거나 뺀다 · status = 상태 바꾼다 */
        action?: "remove" | "group" | "status";
        group?: string;
        status?: string;
      };
      const codes = (Array.isArray(body.codes) ? body.codes : [])
        .map((c) => String(c).trim())
        .filter(Boolean)
        /* 한 번에 200개까지 — 그보다 많으면 실수로 전체를 지우는 것에 가깝다 */
        .slice(0, 200);
      if (codes.length === 0) {
        res.status(400).json({ error: "종목이 없습니다" });
        return;
      }

      const done: string[] = [];
      const failed: string[] = [];
      for (const code of codes) {
        try {
          if (body.action === "remove") {
            await removeWatchItem(code);
          } else if (body.action === "group" && typeof body.group === "string") {
            await toggleWatchGroup(code, body.group);
          } else if (body.action === "status" && typeof body.status === "string") {
            await updateWatchItem(code, { status: body.status as WatchStatus });
          } else {
            failed.push(code);
            continue;
          }
          done.push(code);
        } catch {
          failed.push(code);
        }
      }
      invalidateTrackingCache();
      /* 마지막 상태를 한 번만 읽어 돌려준다 — 화면이 다시 받을 필요가 없다 */
      res.json({ done, failed, items: await listWatchlist() });
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
