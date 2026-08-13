import { Router } from "express";
import {
  commitParsedEvents,
  parseCalendarImage,
  visionReady,
  type ParsedEvent,
} from "../calendarVision.js";
import {
  availableVisionModels,
  availableVisionProviders,
  type VisionProvider,
} from "../vision.js";

export function createCalendarVisionRouter(): Router {
  const router = Router();

  router.get("/status", (_req, res) => {
    res.json({
      ready: visionReady(),
      providers: availableVisionProviders(),
      models: availableVisionModels(),
    });
  });

  /**
   * 이미지 → 일정 후보.
   * 여기서는 저장하지 않는다. 인식이 틀릴 수 있으므로 사용자가 화면에서 확인한 뒤
   * /commit 으로 넣는다.
   */
  router.post("/parse", async (req, res, next) => {
    try {
      const image = String(req.body?.image ?? "");
      const mimeType = String(req.body?.mimeType ?? "image/png");
      const prefer = req.body?.provider as VisionProvider | undefined;
      const model = req.body?.model ? String(req.body.model) : undefined;
      if (!image) throw new Error("이미지가 없습니다.");
      res.json(await parseCalendarImage(image, mimeType, prefer, model));
    } catch (err) {
      next(err);
    }
  });

  router.post("/commit", async (req, res, next) => {
    try {
      const events = (req.body?.events ?? []) as ParsedEvent[];
      const fileName = String(req.body?.fileName ?? "upload");
      if (events.length === 0) throw new Error("추가할 일정이 없습니다.");
      const all = await commitParsedEvents(events, fileName);
      res.json({ added: events.length, events: all });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
