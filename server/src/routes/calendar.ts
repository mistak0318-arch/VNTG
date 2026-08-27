import { Router } from "express";
import {
  ECONOMIC_SOURCE,
  VERIFIED_AT,
  economicEvents,
  installEconomicCalendar,
} from "../economicCalendar.js";
import { addSub, listSubs, maskUrl, removeSub } from "../calendarSubscription.js";
import { fetchIcs, parseCsv, parseIcs } from "../calendarImport.js";
import {
  addEvent,
  clearSource,
  listSources,
  replaceBySource,
  EVENT_KINDS,
  listEvents,
  listEventsRange,
  removeEvent,
  updateEvent,
  upcomingEvents,
  type EventKind,
} from "../calendar.js";

export function createCalendarRouter(): Router {
  const router = Router();

  router.get("/kinds", (_req, res) => {
    res.json({ kinds: EVENT_KINDS });
  });

  router.get("/", async (req, res, next) => {
    try {
      const { month, from, to } = req.query as Record<string, string | undefined>;
      // from~to 기간 조회가 우선 — 주·일 보기가 월 경계를 넘는다 (2026-08-27)
      if (from && to && /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
        res.json({ events: await listEventsRange(from, to) });
        return;
      }
      res.json({ events: await listEvents(typeof month === "string" ? month : undefined) });
    } catch (err) {
      next(err);
    }
  });

  /** 다가오는 일정 — 나중에 조간 리포트·텔레그램 알림에서 그대로 쓴다 */
  router.get("/upcoming", async (req, res, next) => {
    try {
      const days = Math.min(Number(req.query.days) || 14, 90);
      res.json({ events: await upcomingEvents(days) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const { date, time, title, kind, memo, repeat, todo } = req.body ?? {};
      const events = await addEvent({
        date: String(date ?? ""),
        time: time ? String(time) : undefined,
        title: String(title ?? ""),
        kind: (String(kind ?? "personal") as EventKind),
        memo: memo ? String(memo) : undefined,
        /* 반복과 할 일은 함께 못 쓴다 — 반복 할 일의 「완료」는 인스턴스별이어야 해서 다른 문제다 */
        repeat: ["weekly", "monthly", "yearly"].includes(String(repeat)) && !todo ? (repeat as "weekly") : undefined,
        todo: todo === true || todo === "true" ? true : undefined,
      });
      res.json({ events });
    } catch (err) {
      next(err);
    }
  });

  router.patch("/:id", async (req, res, next) => {
    try {
      res.json({ events: await updateEvent(req.params.id, req.body ?? {}) });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:id", async (req, res, next) => {
    try {
      res.json({ events: await removeEvent(req.params.id) });
    } catch (err) {
      next(err);
    }
  });

  // ---------------- 외부 가져오기 ----------------

  /** 등록된 구독 목록 (주소는 마스킹해서 내보낸다) */
  router.get("/subs", async (_req, res, next) => {
    try {
      const subs = await listSubs();
      const counts = await listSources();
      res.json({
        subs: subs.map((s) => ({
          label: s.label,
          masked: maskUrl(s.url),
          url: s.url,
          count: counts.find((c) => c.source === `ics:${s.url}`)?.count ?? 0,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/subs", async (req, res, next) => {
    try {
      const url = String(req.body?.url ?? "");
      const label = String(req.body?.label ?? "");
      await addSub(url, label);
      // 등록 즉시 한 번 받아온다
      const text = await fetchIcs(url);
      const parsed = parseIcs(text, `ics:${url}`, "personal");
      const r = await replaceBySource(`ics:${url}`, parsed);
      res.json({ added: r.added, events: r.events });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/subs", async (req, res, next) => {
    try {
      const url = String(req.query.url ?? "");
      await removeSub(url);
      res.json({ events: await clearSource(`ics:${url}`) });
    } catch (err) {
      next(err);
    }
  });

  /** 등록된 구독을 전부 다시 받아온다 */
  router.post("/sync", async (_req, res, next) => {
    try {
      const subs = await listSubs();
      const results: { label: string; added: number; error?: string }[] = [];
      for (const s of subs) {
        try {
          const text = await fetchIcs(s.url);
          const parsed = parseIcs(text, `ics:${s.url}`, "personal");
          const r = await replaceBySource(`ics:${s.url}`, parsed);
          results.push({ label: s.label, added: r.added });
        } catch (e) {
          results.push({ label: s.label, added: 0, error: e instanceof Error ? e.message : "실패" });
        }
      }
      res.json({ results, events: await listEvents() });
    } catch (err) {
      next(err);
    }
  });

  /** 파일 업로드 — 프론트에서 텍스트로 읽어 보낸다 (multer 불필요) */
  /** 경제 캘린더(FOMC·CPI·금통위·옵션만기) 내장 시드 설치 */
  router.get("/economic", (_req, res) => {
    res.json({ verifiedAt: VERIFIED_AT, events: economicEvents(), source: ECONOMIC_SOURCE });
  });

  router.post("/economic", async (_req, res, next) => {
    try {
      res.json(await installEconomicCalendar());
    } catch (err) {
      next(err);
    }
  });

  router.post("/import", async (req, res, next) => {
    try {
      const text = String(req.body?.text ?? "");
      const filename = String(req.body?.filename ?? "upload");
      const kind = (req.body?.kind ?? "personal") as EventKind;
      if (!text.trim()) throw new Error("파일 내용이 비어 있습니다.");

      const source = `file:${filename}`;
      const parsed = text.includes("BEGIN:VCALENDAR")
        ? parseIcs(text, source, kind)
        : parseCsv(text, source, kind);

      if (parsed.length === 0) {
        throw new Error("가져올 일정을 찾지 못했습니다. 형식을 확인하세요.");
      }
      const r = await replaceBySource(source, parsed);
      res.json({ added: r.added, replaced: r.removed, events: r.events });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
