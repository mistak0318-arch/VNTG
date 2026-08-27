import { Router } from "express";
import {
  listStars,
  markRead,
  readAtOf,
  ROOM_LABELS,
  roomMessages,
  roomsSummary,
  toggleStar,
} from "../telegramArchive.js";

/** VNTG 방 뷰어 — 발신 아카이브를 텔레그램처럼 보는 API (2026-08-27) */
export function createTelegramFeedRouter(): Router {
  const router = Router();

  router.get("/rooms", async (_req, res, next) => {
    try {
      res.json({ rooms: await roomsSummary() });
    } catch (err) {
      next(err);
    }
  });

  router.get("/room/:channel", async (req, res, next) => {
    try {
      const ch = req.params.channel;
      if (!(ch in ROOM_LABELS)) {
        res.status(404).json({ error: "없는 방입니다" });
        return;
      }
      const limit = Number(req.query.limit) || 80;
      res.json({
        channel: ch,
        label: ROOM_LABELS[ch],
        messages: await roomMessages(ch, limit),
        /* 읽음 처리(POST /read) 전의 값 — 화면이 「여기까지 읽음」 선을 긋는 기준 */
        readAt: await readAtOf(ch),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/room/:channel/read", async (req, res, next) => {
    try {
      await markRead(req.params.channel);
      /*
       * 폰 텔레그램도 읽음으로 (2026-08-27 — "그거까지 하면 진짜 안 읽은 것만
       * 가릴 수 있을 것 같아"). MTProto 세션이 있는 기기(미니PC)에서만 되고,
       * 실패해도 뷰어 읽음은 이미 됐다 — 결과만 알려준다.
       */
      let phoneRead = false;
      try {
        const { chatIdFor } = await import("../telegram.js");
        const { markChatRead } = await import("../telegramReader.js");
        const chatId = chatIdFor(req.params.channel as never);
        if (chatId) phoneRead = await markChatRead(chatId);
      } catch {
        /* 세션 없는 기기 — 조용히 */
      }
      res.json({ ok: true, phoneRead });
    } catch (err) {
      next(err);
    }
  });

  router.post("/star", async (req, res, next) => {
    try {
      const { channel, id, at, text } = req.body ?? {};
      if (!channel || !id) {
        res.status(400).json({ error: "channel·id 가 필요합니다" });
        return;
      }
      res.json(
        await toggleStar(String(channel), {
          id: String(id),
          at: String(at ?? ""),
          text: String(text ?? ""),
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  router.get("/stars", async (_req, res, next) => {
    try {
      res.json({ stars: await listStars() });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
