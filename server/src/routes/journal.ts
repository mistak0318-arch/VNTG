import { Router } from "express";
import type { KiwoomClient } from "../kiwoomClient.js";
import { trackTrades } from "../tradeTrack.js";
import {
  MISTAKE_TAGS,
  MOOD_TAGS,
  journalStats,
  listEntries,
  removeEntry,
  saveEntry,
} from "../tradeJournal.js";

/** 복기 노트 */
export function createJournalRouter(client: KiwoomClient): Router {
  const router = Router();

  router.get("/", async (_req, res, next) => {
    try {
      res.json({
        entries: await listEntries(90),
        stats: await journalStats(),
        mistakeTags: MISTAKE_TAGS,
        moodTags: MOOD_TAGS,
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
  router.get("/track", async (req, res, next) => {
    try {
      const days = Number(req.query.days) || undefined;
      res.json(await trackTrades(client, { days }));
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
