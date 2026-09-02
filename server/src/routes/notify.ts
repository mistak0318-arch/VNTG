import { Router } from "express";
import {
  clearRead,
  getNoticeConfig,
  listNotices,
  markRead,
  NOTICE_GROUPS,
  NOTICE_SOURCES,
  saveNoticeConfig,
  type NoticeConfig,
  type NoticeGroup,
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
          /* 화면 탭은 묶음으로 거른다 (2026-09-02) — kind 는 옛 호출을 위해 남긴다 */
          group:
            typeof req.query.group === "string" && req.query.group !== "all"
              ? (req.query.group as NoticeGroup)
              : undefined,
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

  /*
   * **알림 센터 설정** (2026-09-02) — 벤티지: "알림센터에서 받을만한 것들 좀
   * 추리고 on off 할수있는 구조로 가자"
   *
   * 출처(`source`) 단위로 끈다. `kind`(stock/market/system)는 **성격**이라
   * system 하나에 마감 뒤 정리·표본·원장·신호등 분석이 다 들어 있어서
   * 「표본 알림만 끄기」가 안 된다.
   *
   * 목록(`sources`)도 서버가 준다 — 화면이 하드코딩하면 출처를 늘렸을 때
   * 화면만 모르는 상태가 된다.
   */
  router.get("/config", async (_req, res, next) => {
    try {
      res.json({ sources: NOTICE_SOURCES, groups: NOTICE_GROUPS, config: await getNoticeConfig() });
    } catch (err) {
      next(err);
    }
  });

  router.put("/config", async (req, res, next) => {
    try {
      res.json({ config: await saveNoticeConfig(req.body as NoticeConfig) });
    } catch (err) {
      next(err);
    }
  });

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
