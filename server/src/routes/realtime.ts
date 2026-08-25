import { Router } from "express";
import type { KiwoomClient } from "../kiwoomClient.js";
import { RealtimeClient } from "../realtimeClient.js";
import { getRealtime, peekRealtime, shouldRun, subscribedCount } from "../realtimeHub.js";

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
  /* 만드는 자리는 `realtimeHub` 하나다 — 여기서 또 만들면 연결이 둘이 된다 */
  const hub = () => peekRealtime();

  router.post("/connect", async (_req, res, next) => {
    try {
      const { client: rt } = await getRealtime(client);
      await rt.connect();
      res.json({ ok: true, state: rt.state });
    } catch (err) {
      next(err);
    }
  });

  router.post("/subscribe", (req, res) => {
    const type = String(req.body?.type ?? "");
    const item = String(req.body?.item ?? "");
    const { client: rt } = hub();
    if (!rt) {
      res.status(400).json({ error: "먼저 connect 하세요" });
      return;
    }
    /* 손으로 거는 자리 — 화면과 같은 갈래다. 200 정원을 넘기면 오래된 것부터 빠진다 */
    rt.subscribeTransient(type, item);
    res.json({ ok: true, state: rt.state });
  });

  /**
   * 상태 — **화면이 폴링으로 되돌릴지 정하는 근거.**
   * `healthy` 가 거짓이면 실시간을 믿지 말고 평소대로 폴링하면 된다.
   */
  router.get("/status", (_req, res) => {
    const { client: rt, store } = hub();
    res.json({
      enabled: RealtimeClient.enabled,
      state: rt?.state ?? "안 붙음",
      healthy: rt?.healthy ?? false,
      lastSeen: rt?.lastSeen ?? null,
      /*
       * **건 종목 수**와 **값이 온 종목 수**를 갈라 적는다.
       *
       * 예전엔 `keys` 하나뿐이라 「129 면 잘 걸린 건가 아닌가」를 알 수가 없었다 —
       * 거래가 뜸한 종목은 걸려 있어도 키가 안 생기기 때문이다. 둘을 나란히 두면
       * `subscribed` 는 크고 `keys` 가 작을 때 **「걸리긴 걸렸는데 안 도는 종목이
       * 많다」**로 읽히고, 둘 다 작으면 **구독이 실패한 것**이다.
       */
      subscribed: subscribedCount(),
      keys: store?.health.keys ?? 0,
      /*
       * **등록이 거절된 기록.** 비어 있어야 정상이다.
       * 여기 뭐가 있으면 「연결은 됐는데 프레임이 안 온다」의 답이 여기 있다 —
       * 상태창이 healthy 라고 말해도 등록이 통째로 거절됐을 수 있다.
       */
      regErrors: rt?.registrationErrors ?? [],
    });
  });

  router.get("/log", (_req, res) => {
    const { client: rt } = hub();
    res.json({
      state: rt?.state ?? "안 붙음",
      healthy: rt?.healthy ?? false,
      lastSeen: rt?.lastSeen ?? null,
      log: rt?.log ?? [],
    });
  });

  /**
   * 지금 값 여러 개를 **한 번에** — 화면이 1~2초로 물어보는 자리.
   *
   * ## 물어보면 알아서 구독한다
   *
   * 화면마다 「구독하기」를 따로 챙기면 반드시 빠뜨린다. 여기서 달라는 키를 보고
   * 아직 안 걸린 것을 걸어 준다 — 처음 한두 번은 `null` 이 오지만 곧 채워진다.
   * 구독 요청은 `RealtimeClient` 가 모아서 한 번에 보내므로(105110 제한) 여기서
   * 키를 몇 개 주든 요청은 한 번이다.
   *
   * ## 왜 한 번에 받나
   *
   * 칸마다 따로 물어보면 1초에 열 번이 나간다. 키를 콤마로 이어 보내면 한 번이다.
   */
  router.get("/latest", async (req, res, next) => {
    try {
      const keys = String(req.query.keys ?? "")
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean)
        .slice(0, 40);
      if (keys.length === 0) {
        res.json({ enabled: RealtimeClient.enabled, healthy: false, values: {} });
        return;
      }
      if (!RealtimeClient.enabled) {
        res.json({ enabled: false, healthy: false, values: {} });
        return;
      }
      const { client: rt, store } = await getRealtime(client);
      await rt.connect();

      const values: Record<string, { at: number; values: Record<string, string> } | null> = {};
      for (const key of keys) {
        const [type, item] = key.split(":");
        if (!type || !item) continue;
        /*
          **화면이 보는 종목**이다 — 정원(200)에 닿으면 오래 본 것부터 빠진다.
          스케줄러가 건 관심종목·순위는 안 밀린다. 밀려나면 안 되는 쪽이 정해져 있다.
        */
        rt.subscribeTransient(type, item);
        values[key] = store?.getLatest(type, item) ?? null;
      }
      res.json({ enabled: true, healthy: rt.healthy, lastSeen: rt.lastSeen, values });
    } catch (err) {
      next(err);
    }
  });

  /**
   * 하루치 시계열 — 화면이 그림을 그리는 자리.
   *
   * 오늘 것이 없으면 **파일이 남아 있는 가장 최근 장**으로 되짚는다(토요일이면 금요일).
   * 어느 날 것인지를 `day`·`stale` 로 같이 준다 — 지난 장 것을 오늘인 척 보여주면 안 된다.
   */
  router.get("/series", async (req, res, next) => {
    try {
      const type = String(req.query.type ?? "");
      const item = String(req.query.item ?? "");
      const { client: rt, store } = hub();

      /*
       * ⚠️ **장중에는 지난 장으로 되짚지 않는다.**
       *
       * 되짚기는 마감 뒤·주말에 복기하라고 만든 것이다. 그런데 장중에도 그게 돌아서,
       * 오늘 아직 안 쌓인 종목을 열면 **「8월 21일(금) 장 기준」**이 떴다 —
       * 12시에 지난 금요일 수급을 보여준 것이다. 「왜 전거래일 기준이냐」가 그래서 나왔다.
       *
       * 장중에 오늘 것이 없다는 건 **지금부터 쌓으면 되는 일**이지 지난 장을 볼 일이 아니다.
       */
      const live = shouldRun();

      /*
       * 그리고 **보고 있는 종목은 그 자리에서 구독한다.**
       *
       * 실시간은 스케줄러가 고른 종목(관심종목·거래대금 상위)만 물고 있었다. 그 밖의 종목은
       * 화면을 열어도 영영 안 쌓였다 — 거래상위에서 아무 종목이나 눌러 보는 게 이 앱을
       * 쓰는 방식인데 그때마다 빈 화면이었다.
       * 화면이 물어본 종목은 사람이 지금 보고 있는 종목이므로 구독할 값어치가 있다.
       */
      if (live && rt && type && item) rt.subscribeTransient(type, item);

      const got = store
        ? live
          ? { points: store.getSeries(type, item), day: "", stale: false }
          : await store.getSeriesOrLast(type, item)
        : { points: [], day: "", stale: false };

      res.json({
        type,
        item,
        points: got.points,
        day: got.day,
        stale: got.stale,
        /** 장중인가 — 화면이 「지금 쌓는 중」과 「지난 장」을 갈라 말할 수 있게 */
        live,
        latest: store?.getLatest(type, item) ?? null,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * 오늘 걸린 VI — **종목과 무관한 시장 전체 정보**다.
   *
   * `1h` 는 한 번만 걸면 전체 종목이 오므로, 화면은 이걸 읽기만 하면 된다.
   */
  router.get("/vi", (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 60, 1), 300);
    const { store, client: rt } = hub();
    res.json({ healthy: rt?.healthy ?? false, events: store?.getVi(limit) ?? [] });
  });

  /**
   * 무엇이 얼마나 쌓였나 — 진단용.
   *
   * 기본은 **한 줄 요약**이다. 종목이 천 개면 키 목록은 삼천 줄이라 터미널에서 못 읽는다.
   * 키별로 보려면 `?keys=1`.
   */
  router.get("/store", (req, res) => {
    const { store } = hub();
    if (req.query.keys === "1") {
      res.json({ items: store?.summary ?? [] });
      return;
    }
    res.json(store?.health ?? { day: "", keys: 0, points: 0, pending: 0, types: {} });
  });

  router.post("/close", (_req, res) => {
    hub().client?.close();
    res.json({ ok: true });
  });

  return router;
}
