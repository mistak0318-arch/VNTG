import { Router } from "express";
import {
  clearRead,
  listNotices,
  markRead,
  type NoticeKind,
} from "../notifyCenter.js";
import { regimeCheck, regimeConfig, saveRegimeConfig } from "../regimeWatch.js";
import type { KiwoomClient } from "../kiwoomClient.js";

/**
 * 알림함 + 장세 점검.
 *
 * 둘을 한 라우터에 둔 이유는 **장세 점검의 결과가 알림으로 나가기 때문**이다.
 * 「신호등을 재점검할 때가 됐다」는 판정이 곧 시스템 알림이다.
 */
export function createNotifyRouter(client: KiwoomClient): Router {
  const router = Router();

  /** 종 옆 배지와 목록을 한 번에 — 화면이 두 번 안 부르게 */
  router.get("/", async (req, res, next) => {
    try {
      const kind = req.query.kind;
      res.json(
        await listNotices({
          limit: Number(req.query.limit) || 50,
          kind: typeof kind === "string" && kind !== "all" ? (kind as NoticeKind) : undefined,
          unreadOnly: req.query.unread === "1",
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  /** `ids` 를 안 주면 전부 읽음으로 */
  router.post("/read", async (req, res, next) => {
    try {
      const body = req.body as { ids?: string[] };
      res.json({ marked: await markRead(body?.ids) });
    } catch (err) {
      next(err);
    }
  });

  /** 읽은 것만 비운다 — 안 읽은 것은 남는다 */
  router.post("/clear", async (_req, res, next) => {
    try {
      res.json({ removed: await clearRead() });
    } catch (err) {
      next(err);
    }
  });

  /* ---------------- 장세 점검 ---------------- */

  router.get("/regime/config", async (_req, res, next) => {
    try {
      res.json(await regimeConfig());
    } catch (err) {
      next(err);
    }
  });

  router.put("/regime/config", async (req, res, next) => {
    try {
      res.json({ config: await saveRegimeConfig(req.body ?? {}) });
    } catch (err) {
      next(err);
    }
  });

  /**
   * 지금 장세를 재 본다. `notify=1` 이면 문턱을 넘은 항목을 알림으로도 보낸다.
   * 화면에서 그냥 눌러 볼 때는 알림을 안 만든다 — 미리보기가 알림함을 채우면 안 된다.
   */
  router.post("/regime/check", async (req, res, next) => {
    try {
      const notify = (req.body as { notify?: boolean } | undefined)?.notify === true;
      res.json(await regimeCheck(client, { notify }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
