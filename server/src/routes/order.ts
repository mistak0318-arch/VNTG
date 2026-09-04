import { Router, type NextFunction, type Request, type Response } from "express";
import { verifyCredentials } from "../auth.js";
import type { KiwoomClient } from "../kiwoomClient.js";
import {
  appendLog,
  clientIp,
  closeSession,
  executePrepared,
  fills,
  openOrders,
  openSession,
  orderAccount,
  orderStatus,
  ordersEnabled,
  prepareCancel,
  prepareOrder,
  readLog,
  sessionOf,
  setOrderPassword,
  setUiLock,
  checkPassword,
  noteAccess,
  getSettings,
  saveSettings,
  forgetPassword,
  type OrderVenue,
} from "../orders.js";
import { readOrderStops, setOrderStop } from "../orderStops.js";
import {
  deviceCheckPossible,
  deviceOf,
  finishDeviceCheck,
  listDevices,
  noteDeviceUse,
  removeDevice as removeOrderDevice,
  renameDevice,
  startDeviceCheck,
} from "../orderDevices.js";
import { sendTelegram } from "../telegram.js";

/**
 * /api/order — 주문 창구 (2026-09-03). 겹은 orders.ts 머리글.
 *
 *   GET  /status            언제나 — 화면이 「왜 안 열리나」를 설명하려면 이것만은 열려 있어야 한다
 *   POST /session           앱 아이디·비밀번호 **재입력** → 주문 세션 쿠키(vntg_o). DELETE 로 닫는다
 *   ── 아래는 주문 세션이 없으면 전부 404 (있는지도 모르게) ──
 *   POST /password          주문 비밀번호 정하기/바꾸기
 *   GET  /open /fills /account /log
 *   POST /prepare → POST /execute       주문서(30초) → 비밀번호와 함께 실행
 *   POST /cancel/prepare → /execute     취소도 같은 두 단계
 *   POST /lock              화면 잠금 켜기/끄기 (비밀번호)
 *
 * L7: 상태 바꾸는 요청은 POST 만, `X-VNTG-Order: 1` 헤더가 있어야 하고, Origin 이 오면 우리 호스트여야 한다.
 * 브라우저가 다른 사이트에서 폼을 던져도 이 헤더는 못 붙인다(단순 요청이 아니라 CORS 프리플라이트에서 죽는다).
 */
export function createOrderRouter(main: KiwoomClient): Router {
  const router = Router();

  /** 값을 안 보낸 칸인가 — null·빈 문자열·없음을 한 자리에서 가른다 */
  const blank = (v: unknown): boolean => v === null || v === undefined || v === "";

  /* 세션 열기 실패 횟수 — 주소별. 다섯 번이면 15분 */
  const fails = new Map<string, { n: number; until: number }>();

  router.get("/status", async (req, res, next) => {
    try {
      res.json(await orderStatus(req));
    } catch (e) {
      next(e);
    }
  });

  function sameOrigin(req: Request): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  function mutating(req: Request, res: Response): boolean {
    if (req.headers["x-vntg-order"] !== "1" || !sameOrigin(req)) {
      res.status(404).json({ error: "not found" });
      return false;
    }
    return true;
  }

  router.post("/session", async (req, res) => {
    if (!mutating(req, res)) return;
    if (!ordersEnabled()) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const ip = clientIp(req);
    const f = fails.get(ip);
    if (f && f.until > Date.now()) {
      res.status(429).json({ error: `잠시 뒤에 — ${Math.ceil((f.until - Date.now()) / 60_000)}분` });
      return;
    }
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    const r = await verifyCredentials(String(username ?? ""), String(password ?? ""));
    if (r === "disabled") {
      res.status(403).json({ error: "앱 로그인(설정 › 보안)을 먼저 켜야 주문 메뉴가 열린다 — 주문은 로그인 없이는 안 된다" });
      return;
    }
    if (r === "bad") {
      const n = (f?.n ?? 0) + 1;
      fails.set(ip, { n, until: n >= 5 ? Date.now() + 15 * 60_000 : 0 });
      await appendLog({ kind: "session", ip, msg: `주문 메뉴 열기 실패 ${n}회` });
      if (n === 1 || n % 5 === 0) {
        void sendTelegram(`🔐 주문 메뉴 열기 실패 ${n}회 · ${ip}`, "order").catch(() => undefined);
      }
      res.status(401).json({ error: "아이디 또는 비밀번호가 다릅니다" });
      return;
    }
    fails.delete(ip);

    /*
     * **등록된 기기인가** (2026-09-04). 아이디·비밀번호는 「아는 것」이라 새어 나가면 어디서든
     * 쓸 수 있다. 기기는 「가진 것」이라 성질이 다르다 — 둘 다 알아도 등록 안 된 기기에서는
     * 주문 메뉴가 안 열린다. 메일이 없으면 확인할 길이 없으므로 요구하지 않는다.
     */
    const cfg = await getSettings();
    if (cfg.requireTrustedDevice && deviceCheckPossible() && (await deviceOf(req)) === null) {
      await appendLog({ kind: "session", ip, msg: "등록 안 된 기기 — 메일 확인 필요" });
      res.status(403).json({
        needDevice: true,
        error: "이 기기는 주문에 등록돼 있지 않습니다 — 메일로 확인하세요",
      });
      return;
    }

    await openSession(req, res);
    await noteDeviceUse(req, false);
    /* 처음 보는 주소면 그 자리에서 알린다 — 기록만 남기면 사고 뒤에야 안다 */
    void noteAccess(ip, "주문 메뉴를 열었습니다");
    /*
     * 메뉴를 연 것은 **기록에만** 남긴다 (2026-09-04). 하루에도 여러 번 여는 일이라
     * 텔레그램에 실으면 방이 그것으로 찬다 — 그 방은 「돈이 움직였다」를 보는 곳이다.
     * 다만 **처음 보는 주소**에서 열렸으면 그건 아래 noteAccess 가 따로 보낸다.
     */
    await appendLog({
      kind: "session",
      ip,
      msg: `주문 메뉴 열림 · ${String(req.headers["user-agent"] ?? "?").slice(0, 60)}`,
    });
    res.json({ ok: true });
  });

  router.delete("/session", (req, res) => {
    closeSession(req, res);
    res.json({ ok: true });
  });

  /*
   * 기기 등록은 **주문 세션 밖**이다 — 세션을 열려면 등록이 필요하고, 등록하려면 여기를
   * 지나야 하기 때문이다. 대신 아이디·비밀번호를 먼저 맞힌 사람만 온다(아래에서 다시 본다).
   */
  router.post("/device/start", async (req, res) => {
    if (!mutating(req, res)) return;
    if (!ordersEnabled()) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    /* 아무나 확인 메일을 쏘게 두지 않는다 — 메일 폭탄도 사고다 */
    if ((await verifyCredentials(String(username ?? ""), String(password ?? ""))) !== "ok") {
      res.status(401).json({ error: "아이디 또는 비밀번호가 다릅니다" });
      return;
    }
    const r = await startDeviceCheck(req);
    if ("error" in r) {
      res.status(400).json({ error: r.error });
      return;
    }
    res.json(r);
  });

  router.post("/device/verify", async (req, res) => {
    if (!mutating(req, res)) return;
    const { ticket, code, name } = (req.body ?? {}) as { ticket?: string; code?: string; name?: string };
    const r = await finishDeviceCheck(req, res, String(ticket ?? ""), String(code ?? ""), String(name ?? ""));
    if (!r.ok) {
      res.status(400).json({ error: r.error });
      return;
    }
    await appendLog({ kind: "session", ip: clientIp(req), msg: `주문 기기 등록 — ${r.device.name}` });
    res.json({ ok: true, device: r.device });
  });

  /* ── 여기부터 주문 세션 필수 ── */
  router.use((req: Request, res: Response, next: NextFunction) => {
    if (!ordersEnabled() || sessionOf(req) === null) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (req.method !== "GET" && !mutating(req, res)) return;
    next();
  });

  router.post("/password", async (req, res) => {
    try {
      const { next: nextPw, current } = (req.body ?? {}) as { next?: string; current?: string };
      await setOrderPassword(String(nextPw ?? ""), current === undefined ? null : String(current));
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "실패" });
    }
  });

  router.get("/open", async (_req, res) => {
    try {
      res.json({ rows: await openOrders() });
    } catch (e) {
      res.status(502).json({ error: e instanceof Error ? e.message : "조회 실패", rows: [] });
    }
  });

  router.get("/fills", async (_req, res) => {
    try {
      res.json({ rows: await fills() });
    } catch (e) {
      res.status(502).json({ error: e instanceof Error ? e.message : "조회 실패", rows: [] });
    }
  });

  router.get("/account", async (_req, res) => {
    try {
      /* 손절선을 같이 준다 — 잔고 줄마다 칸이 하나 붙는다 (2026-09-04) */
      const [acct, stops] = await Promise.all([orderAccount(), readOrderStops()]);
      res.json({ ...acct, stops });
    } catch (e) {
      res.status(502).json({ error: e instanceof Error ? e.message : "조회 실패" });
    }
  });

  /**
   * 계좌 자리의 손절선 (2026-09-04) — 벤티지: "주문메뉴의 계좌에서 해야지."
   *
   * 주문을 내지 않으므로 주문 비밀번호를 안 묻는다. 다만 **주문 세션 안**이라
   * 아이디·비밀번호를 다시 넣은 사람만 고칠 수 있고, POST + 헤더 검사도 그대로다.
   */
  router.post("/stop", async (req, res) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const stops = await setOrderStop(String(b.code ?? ""), Number(b.stop) || 0, String(b.name ?? ""));
      res.json({ stops });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "실패" });
    }
  });

  router.get("/log", async (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const rows = (await readLog(limit)).filter((r) => r.kind !== "raw");
    res.json({ rows });
  });

  router.post("/prepare", async (req, res) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const r = await prepareOrder(
        main,
        {
          side: b.side === "sell" ? "sell" : "buy",
          code: String(b.code ?? ""),
          name: String(b.name ?? ""),
          qty: Number(b.qty),
          price: blank(b.price) ? null : Number(b.price),
          /* 스톱지정가 발동가 (2026-09-04). 안 쓰는 구분이면 비워서 온다 */
          condPrice: blank(b.condPrice) ? null : Number(b.condPrice),
          /* 안 보내면 예전처럼 보통(지정가) — 옛 화면이 남아 있어도 동작이 안 바뀐다 */
          tradeType: String(b.tradeType ?? "0"),
          venue: String(b.venue ?? "KRX") as OrderVenue,
        },
        clientIp(req),
      );
      res.json(r);
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "실패" });
    }
  });

  router.post("/cancel/prepare", async (req, res) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const r = await prepareCancel(
        {
          ordNo: String(b.ordNo ?? ""),
          code: String(b.code ?? ""),
          name: String(b.name ?? ""),
          qty: Number(b.qty) || 0,
          venue: String(b.venue ?? "KRX") as OrderVenue,
        },
        clientIp(req),
      );
      res.json(r);
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "실패" });
    }
  });

  /* 주문·취소 실행이 같은 문을 쓴다 — nonce 가 어느 쪽 주문서인지 안다 */
  const execute = async (req: Request, res: Response) => {
    try {
      const { nonce, password, remember } = (req.body ?? {}) as {
        nonce?: string;
        password?: string;
        remember?: boolean;
      };
      const r = await executePrepared(String(nonce ?? ""), String(password ?? ""), clientIp(req), {
        /* 「기억하기」는 **이 세션에만** 찍힌다 — 세션이 닫히면 같이 사라진다 */
        session: sessionOf(req),
        remember: Boolean(remember),
      });
      await noteDeviceUse(req, r.ticket.kind === "order");
      res.json({ ok: true, ordNo: r.ordNo, msg: r.msg, kind: r.ticket.kind, remembered: r.remembered });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "실패" });
    }
  };
  router.post("/execute", execute);
  router.post("/cancel/execute", execute);

  /** 주문 화면 설정 — 한도(orderGuard)는 여기서 못 고친다. 그건 파일을 직접 열어야 한다 */
  router.get("/settings", async (_req, res, next) => {
    try {
      res.json({ settings: await getSettings() });
    } catch (e) {
      next(e);
    }
  });

  router.post("/settings", async (req, res) => {
    try {
      const settings = await saveSettings((req.body ?? {}) as Record<string, never>);
      /* 기억하기를 끄면 **지금 열려 있는 기억도** 끊는다 — 껐는데 이번 판만 살아 있으면 껐다고 못 한다 */
      if (!settings.rememberPassword) forgetPassword(req);
      res.json({ settings });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "실패" });
    }
  });

  /** 기억을 지금 끊는다 (설정의 「지금 잊기」) */
  router.post("/forget", (req, res) => {
    forgetPassword(req);
    res.json({ ok: true });
  });

  router.get("/devices", async (req, res, next) => {
    try {
      res.json({ devices: await listDevices(req), mailReady: deviceCheckPossible() });
    } catch (e) {
      next(e);
    }
  });

  router.post("/devices/rename", async (req, res) => {
    try {
      const { id, name } = (req.body ?? {}) as { id?: string; name?: string };
      await renameDevice(String(id ?? ""), String(name ?? ""));
      res.json({ devices: await listDevices(req) });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "실패" });
    }
  });

  router.post("/devices/remove", async (req, res) => {
    try {
      const { id } = (req.body ?? {}) as { id?: string };
      await removeOrderDevice(String(id ?? ""));
      await appendLog({ kind: "session", ip: clientIp(req), msg: "주문 기기 삭제" });
      res.json({ devices: await listDevices(req) });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "실패" });
    }
  });

  router.post("/lock", async (req, res) => {
    try {
      const { locked, password } = (req.body ?? {}) as { locked?: boolean; password?: string };
      // 잠그는 건 누구나(빨리 막아야 하니까), 푸는 건 비밀번호
      if (!locked) {
        const r = await checkPassword(String(password ?? ""));
        if (!r.ok) {
          res.status(401).json({ error: r.error });
          return;
        }
      }
      await setUiLock(Boolean(locked));
      /* 잠갔으면 기억도 끊는다 — 잠근 사람은 「지금부터 아무것도 안 나간다」를 기대한다 */
      if (locked) forgetPassword(req);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "실패" });
    }
  });

  return router;
}
