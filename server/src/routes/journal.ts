import { getCreed, setCreed } from "../journalCreed.js";
import { Router } from "express";
import type { KiwoomClient } from "../kiwoomClient.js";
import { trackTrades } from "../tradeTrack.js";
import { diaryOfDay, ordersOfDay, summarize } from "../journalOrders.js";
import {
  MISTAKE_TAGS,
  MOOD_TAGS,
  REASON_TAGS,
  WATCH_TAGS,
  journalStats,
  listEntries,
  listEntriesGraded,
  removeEntry,
  saveEntry,
  prevDayReview,
  journalPositions,
} from "../tradeJournal.js";

/** 복기 노트 */
export function createJournalRouter(client: KiwoomClient): Router {
  const router = Router();

  router.get("/", async (_req, res, next) => {
    try {
      res.json({
        /* 열 때 밀린 예측을 채점한다 — 채점할 게 없으면 조회 0회 (2026-08-27) */
        entries: await listEntriesGraded(client, 90),
        stats: await journalStats(),
        mistakeTags: MISTAKE_TAGS,
        moodTags: MOOD_TAGS,
        reasonTags: REASON_TAGS,
        watchTags: WATCH_TAGS,
      });
    } catch (err) {
      next(err);
    }
  });

  router.put("/", async (req, res, next) => {
    try {
      await saveEntry(client, req.body ?? {});
      res.json({ entries: await listEntries(90), stats: await journalStats() });
    } catch (err) {
      next(err);
    }
  });

  /*
   * 내 판단 추적 — **`/:date` 보다 먼저 등록해야 한다.**
   * 아래 delete 는 `:date` 를 쓰지만 get 이 하나라도 `/:something` 이 되면
   * 「track」이 날짜로 읽힌다. 신호등 라우터에서 그걸로 한 번 당했다.
   */
  /**
   * 11번 「오늘의 주문·체결」 — 지금 로그에서 바로 (2026-09-10). 저장본과 별개로, 화면이
   * 열릴 때 그날 것을 다시 본다. `POST /orders/sync` 는 그날 저널에 박아 둔다(주문 메뉴의
   * 「복기 노트에 담기」).
   */
  router.get("/orders", async (req, res, next) => {
    try {
      const date =
        typeof req.query.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
          ? req.query.date
          : new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
      const [rows, diary] = await Promise.all([ordersOfDay(date), diaryOfDay(date, client)]);
      res.json({ date, rows, summary: summarize(rows), diary });
    } catch (err) {
      next(err);
    }
  });
  router.post("/orders/sync", async (req, res, next) => {
    try {
      const date =
        typeof req.body?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.body.date)
          ? req.body.date
          : new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
      const entries = await saveEntry(client, { date });
      const e = entries.find((x) => x.date === date);
      res.json({ date, count: e?.orders?.length ?? 0, summary: summarize(e?.orders ?? []) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/track", async (req, res, next) => {
    try {
      const days = Number(req.query.days) || undefined;
      res.json(await trackTrades(client, { days }));
    } catch (err) {
      next(err);
    }
  });

  /*
   * **전일 매매복기** (2026-11-25) — 어제 산 것이 오늘 어떻게 됐나.
   * `:date` 보다 **위**에 둔다. 아래에 두면 `/prev-review` 가 날짜로 잡힌다.
   */
  /** 내 종목 현황 — 보유/정리 + 어제 대비 변화 (2026-11-25) */
  router.get("/positions", async (req, res, next) => {
    try {
      const date = String(req.query.date ?? "") || new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
      res.json(await journalPositions(date));
    } catch (err) {
      next(err);
    }
  });

  router.get("/prev-review", async (req, res, next) => {
    try {
      const date = String(req.query.date ?? "") || new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
      res.json(await prevDayReview(date));
    } catch (err) {
      next(err);
    }
  });

  /*
   * **#매일읽기** (2026-11-25) — 내 원칙·매수전략·매도전략. 복기 노트 안에서 매일 읽는다.
   * `:date` 보다 위에 둔다(아래면 `/creed` 가 날짜로 잡힌다).
   */
  router.get("/creed", async (_req, res, next) => {
    try {
      res.json(await getCreed());
    } catch (err) {
      next(err);
    }
  });
  router.put("/creed", async (req, res, next) => {
    try {
      res.json(await setCreed(String((req.body as { text?: string })?.text ?? "")));
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:date", async (req, res, next) => {
    try {
      await removeEntry(req.params.date);
      res.json({ entries: await listEntries(90), stats: await journalStats() });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
