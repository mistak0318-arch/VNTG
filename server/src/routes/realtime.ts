import { Router } from "express";
import type { KiwoomClient } from "../kiwoomClient.js";
import { RealtimeClient } from "../realtimeClient.js";
import { dualEnabled, getRealtime, peekRealtime, secondInfo, shouldRun, subscribedCount } from "../realtimeHub.js";

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

  /**
   * SSE 푸시 (2026-08-25) — **폴링 없이 틱이 오는 대로 민다.**
   *
   * `/latest` 폴링은 값의 나이가 폴링 주기(1.5초)만큼이었다. 이 스트림은 키움
   * 프레임이 도착하는 그 순간 브라우저로 흘려서 틱→화면이 0.5초 안이다.
   *
   *   GET /api/realtime/stream?keys=0B:005930,0B:000660[&sub=1]
   *
   * 기본은 **읽기 전용**(구독 안 걸음 — 목록 오버레이용). `sub=1` 이면 임시구독을
   * 건다(호가창처럼 그 종목을 지금 보는 화면용). 키당 250ms 로 눌러 보낸다 —
   * 체결이 몰릴 때 브라우저에 초당 수백 이벤트를 던지면 그쪽이 먼저 죽는다.
   * 연결 직후에 들고 있는 최신값을 한 번 쏟아 화면이 바로 차게 한다.
   */
  router.get("/stream", async (req, res, next) => {
    try {
      const wantSub = String(req.query.sub ?? "") === "1";
      const keys = String(req.query.keys ?? "")
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean)
        .slice(0, wantSub ? 40 : 120);
      if (keys.length === 0 || !RealtimeClient.enabled) {
        res.status(400).json({ error: "keys 가 없거나 실시간이 꺼져 있습니다" });
        return;
      }
      const { client: rt, store } = await getRealtime(client);
      await rt.connect();

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      /*
       * ⚠️ 첫 바이트를 **즉시** 보낸다. Node 는 본문 첫 write 까지 헤더를 물고
       * 있어서, 초기값이 하나도 없으면(장 마감 뒤 등) 15초 하트비트까지
       * 브라우저가 「연결 중」에 매달렸다 — 실측으로 걸렸다.
       */
      res.write(": hi\n\n");

      const want = new Set(keys);
      const send = (key: string, at: number, values: Record<string, string>) => {
        res.write(`data: ${JSON.stringify({ key, at, values })}\n\n`);
      };

      // 들고 있는 값 먼저 — 첫 틱이 올 때까지 빈 화면이면 스트림이 느려 보인다
      for (const key of keys) {
        const [type, item] = key.split(":");
        if (!type || !item) continue;
        if (wantSub) rt.subscribeTransient(type, item);
        const got = store?.getLatest(type, item);
        if (got) send(key, got.at, got.values as Record<string, string>);
      }

      /* 키당 마지막 전송 시각 — 250ms 스로틀. 눌린 틱은 다음 틱이 대신한다(누적값이라 무손실) */
      const lastSent = new Map<string, number>();
      const off = rt.onFrame((f) => {
        const frame = f as { trnm?: string; data?: { type?: string; item?: string; values?: Record<string, string> }[] };
        if (frame.trnm !== "REAL" || !Array.isArray(frame.data)) return;
        const now = Date.now();
        for (const d of frame.data) {
          if (!d.type || !d.item || !d.values) continue;
          const key = `${d.type}:${String(d.item).replace(/_(AL|NX)$/, "")}`;
          if (!want.has(key)) continue;
          if (now - (lastSent.get(key) ?? 0) < 250) continue;
          lastSent.set(key, now);
          send(key, now, d.values);
        }
      });

      // 끊김 감지용 심장박동 — 프록시가 조용한 연결을 자르는 걸 막는 겸
      const beat = setInterval(() => res.write(`: beat ${rt.healthy ? 1 : 0}\n\n`), 15_000);
      req.on("close", () => {
        clearInterval(beat);
        off();
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * 두 번째 웹소켓 탐침 (2026-08-25 — 정원 200 을 넘을 길이 있나).
   *
   * 문서에 없어서 실측만이 답이다: **같은 토큰으로 소켓을 하나 더** 열어
   * LOGIN → REG 가 받아지는지, 그리고 **기존 소켓이 쫓겨나는지**를 잰다.
   * 프로세스 안에서 같은 토큰 캐시를 쓴다 — 밖에서 토큰을 새로 받으면
   * 서버 REST 가 통째로 죽는다(8005).
   *
   * 진단용 일회성 — 성공하면 realtimeHub 를 두 연결로 재설계하는 근거가 되고,
   * 실패해도 그 답 자체가 결론이다.
   */
  /**
   * **NXT 시간대 실시간이 오는가** — `_AL`(통합) 구독 실측 (2026-08-31 요청).
   *
   * 실시간 구독은 지금 6자리 KRX 단독 코드로 건다. 그래서 NXT 프리마켓(08:00~08:50)·
   * 애프터마켓(15:40~20:00)에는 체결 프레임이 안 온다 — 실측으로 `keys: 0` 이었다.
   * 그런데 **슈퍼신호등 편입(15:45)과 종가배팅이 바로 그 시간대 매수를 전제로 한다.**
   *
   * REST TR 에서는 `_AL` 이 통합값을 준다는 게 확인됐지만 **웹소켓 REAL 도 그런지는
   * 모른다.** 추측으로 전체 구독을 바꾸면 멀쩡한 정규장 실시간을 깨뜨릴 수 있으므로,
   * 한 종목만 잠깐 걸어 보고 **프레임이 실제로 오는지**만 본다.
   *
   * `subscribeTransient` 를 쓰므로 상시 구독(관심종목·순위)을 밀어내지 않는다.
   */
  router.post("/probe-nxt", async (req, res, next) => {
    try {
      const code = String(req.body?.code ?? "005930").replace(/[^0-9A-Za-z]/g, "");
      const waitMs = Math.min(60_000, Math.max(5_000, Number(req.body?.waitMs) || 25_000));
      const { client: rt, store } = await getRealtime(client);

      const bare = code;
      const al = `${code}_AL`;
      const before = {
        bare: store.getLatest("0B", bare)?.at ?? null,
        al: store.getLatest("0B", al)?.at ?? null,
        regErrors: rt.registrationErrors.length,
      };

      rt.subscribeTransient("0B", al);
      await new Promise((r) => setTimeout(r, waitMs));

      const after = {
        bare: store.getLatest("0B", bare)?.at ?? null,
        al: store.getLatest("0B", al)?.at ?? null,
      };
      const errs = rt.registrationErrors.slice(before.regErrors);

      res.json({
        code,
        waitedMs: waitMs,
        /** `_AL` 로 프레임이 왔나 — 이 값이 이 실측의 결론이다 */
        alFrames: after.al !== null && after.al !== before.al,
        /** 그 사이 KRX 단독으로도 왔나 (비교용) */
        bareFrames: after.bare !== null && after.bare !== before.bare,
        before,
        after,
        /** 구독이 거절됐으면 여기 남는다 */
        newRegErrors: errs,
        note:
          "alFrames 가 true 면 _AL 구독으로 NXT 시간대 체결을 받을 수 있다는 뜻이다. " +
          "false 라도 그 시각에 그 종목 체결이 없었을 수 있으니 거래가 있는 종목·시간에 다시 재라.",
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/probe-second", async (_req, res, next) => {
    try {
      const { client: rt } = await getRealtime(client);
      const firstBefore = { state: rt.state, healthy: rt.healthy };
      const token = await client.accessToken();
      const log: string[] = [];
      // Node 22 내장 WebSocket — realtimeClient 와 같은 물건이다 (ws 패키지 아님)
      const ws = new WebSocket("wss://api.kiwoom.com:10000/api/dostk/websocket");

      const result = await new Promise<Record<string, unknown>>((resolve) => {
        const done = (why: string) => {
          try {
            ws.close();
          } catch {
            /* 이미 닫혔으면 그만 */
          }
          resolve({
            why,
            log,
            firstBefore,
            firstAfter: { state: rt.state, healthy: rt.healthy, lastSeen: rt.lastSeen },
          });
        };
        const timer = setTimeout(() => done("8초 관찰 끝"), 8000);
        ws.onopen = () => {
          log.push("(2번 소켓 연결됨)");
          ws.send(JSON.stringify({ trnm: "LOGIN", token }));
        };
        ws.onmessage = (ev: MessageEvent) => {
          const text = typeof ev.data === "string" ? ev.data : String(ev.data);
          log.push(`← ${text.slice(0, 300)}`);
          try {
            const f = JSON.parse(text) as { trnm?: string; return_code?: number };
            if (f.trnm === "LOGIN" && f.return_code === 0) {
              // 로그인 통과 — 종목 하나를 걸어 REG 응답을 본다
              ws.send(
                JSON.stringify({ trnm: "REG", grp_no: "1", refresh: "1", data: [{ item: ["005930"], type: ["0B"] }] }),
              );
            }
            if (f.trnm === "LOGIN" && f.return_code !== undefined && f.return_code !== 0) {
              clearTimeout(timer);
              done("LOGIN 거절");
            }
          } catch {
            /* JSON 아니어도 로그에는 남았다 */
          }
        };
        ws.onclose = (ev: { code?: number }) => {
          log.push(`(2번 소켓 닫힘 ${ev.code ?? "?"})`);
        };
        ws.onerror = () => {
          log.push("(소켓 오류)");
          clearTimeout(timer);
          done("소켓 오류");
        };
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

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
      /*
       * **정원이 어떻게 차 있나** (2026-09-02).
       *
       * `subscribed` 가 200 을 넘으면 키움이 REG 를 통째로 거절하는데(105115),
       * **누가 넘겼는지**를 알아야 고칠 자리가 정해진다 — 스케줄러(`keep`)면
       * 정원 배분을 줄여야 하고 화면(`transient`)이면 밀어내기가 안 도는 것이다.
       */
      seats: peekRealtime().client?.seats ?? null,
      /*
       * 2번 연결 (2026-08-25 이중화) — 정원 190→380. null 이면 안 떠 있는 것
       * (밤 국면이거나 REALTIME_DUAL=0 롤백). 문제가 보이면 .env 한 줄이 롤백이다.
       */
      second: secondInfo(),
      dual: dualEnabled(),
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
      /*
       * 읽기 전용 모드 (2026-08-25, `sub=0`) — **목록 화면 오버레이용.**
       *
       * 시세분석·관심종목은 줄이 백 개다. 보통 모드로 백 개를 물으면 임시구독
       * 백 개가 정원(10자리)을 짓밟는다. 읽기 전용은 **구독을 안 걸고 이미 온 값만**
       * 준다 — 어차피 그 줄들(거래대금 상위·관심종목)은 스케줄러가 KEEP 으로 걸어
       * 뒀으니, 값이 있으면 오고 없으면 null 이다. null 은 화면이 REST 값을 그대로
       * 쓰면 된다. 키 상한도 그래서 넉넉하다(120).
       */
      const readOnly = String(req.query.sub ?? "") === "0";
      const keys = String(req.query.keys ?? "")
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean)
        .slice(0, readOnly ? 120 : 40);
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
          읽기 전용(sub=0)은 안 건다 — 목록 오버레이가 정원을 먹으면 안 된다.
        */
        if (!readOnly) rt.subscribeTransient(type, item);
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
