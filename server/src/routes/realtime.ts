import { Router } from "express";
import type { KiwoomClient } from "../kiwoomClient.js";
import { RealtimeClient } from "../realtimeClient.js";
import { RealtimeStore } from "../realtimeStore.js";

/**
 * 실시간 웹소켓 — **아직 확인 단계다.**
 *
 * 접속 규약(로그인·PING)이 문서에 없어서, 붙여 보고 서버가 하는 말을 그대로 본다.
 * `/api/realtime/log` 가 주고받은 프레임을 그대로 돌려준다 — 그걸 읽고 맞춘다.
 *
 * 확인이 끝나면 이 라우터는 저장소를 읽는 자리로 바뀐다.
 */
export function createRealtimeRouter(client: KiwoomClient): Router {
  const router = Router();
  let rt: RealtimeClient | null = null;
  let store: RealtimeStore | null = null;

  router.post("/connect", async (_req, res, next) => {
    try {
      if (!rt) {
        rt = new RealtimeClient(client);
        // 저장소는 붙기 전에 걸어 둔다 — 첫 프레임부터 받아야 한다
        store = new RealtimeStore(rt);
        await store.start();
      }
      await rt.connect();
      res.json({ ok: true, state: rt.state });
    } catch (err) {
      next(err);
    }
  });

  router.post("/subscribe", (req, res) => {
    const type = String(req.body?.type ?? "");
    const item = String(req.body?.item ?? "");
    if (!rt) {
      res.status(400).json({ error: "먼저 connect 하세요" });
      return;
    }
    rt.subscribe(type, item);
    res.json({ ok: true, state: rt.state });
  });

  /**
   * 상태 — **화면이 폴링으로 되돌릴지 정하는 근거.**
   * `healthy` 가 거짓이면 실시간을 믿지 말고 평소대로 폴링하면 된다.
   */
  router.get("/status", (_req, res) => {
    res.json({
      enabled: RealtimeClient.enabled,
      state: rt?.state ?? "안 붙음",
      healthy: rt?.healthy ?? false,
      lastSeen: rt?.lastSeen ?? null,
    });
  });

  router.get("/log", (_req, res) => {
    res.json({
      state: rt?.state ?? "안 붙음",
      healthy: rt?.healthy ?? false,
      lastSeen: rt?.lastSeen ?? null,
      log: rt?.log ?? [],
    });
  });

  /** 하루치 시계열 — 화면이 그림을 그리는 자리 */
  router.get("/series", (req, res) => {
    const type = String(req.query.type ?? "");
    const item = String(req.query.item ?? "");
    res.json({
      type,
      item,
      points: store?.getSeries(type, item) ?? [],
      latest: store?.getLatest(type, item) ?? null,
    });
  });

  /** 무엇이 얼마나 쌓였나 — 진단용 */
  router.get("/store", (_req, res) => {
    res.json({ items: store?.summary ?? [] });
  });

  router.post("/close", (_req, res) => {
    rt?.close();
    rt = null;
    res.json({ ok: true });
  });

  return router;
}
