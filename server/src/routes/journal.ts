import { Router } from "express";
import type { KiwoomClient } from "../kiwoomClient.js";
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
