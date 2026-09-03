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
  type OrderVenue,
} from "../orders.js";
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
    openSession(req, res);
    await appendLog({ kind: "session", ip, msg: "주문 메뉴 열림" });
    void sendTelegram(`🔓 주문 메뉴 열림 · ${ip}\n기기: ${String(req.headers["user-agent"] ?? "?").slice(0, 60)}`, "order").catch(
      () => undefined,
    );
    res.json({ ok: true });
  });

  router.delete("/session", (req, res) => {
    closeSession(req, res);
    res.json({ ok: true });
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
      res.json(await orderAccount());
    } catch (e) {
      res.status(502).json({ error: e instanceof Error ? e.message : "조회 실패" });
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
          price: b.price === null || b.price === "" || b.price === undefined ? null : Number(b.price),
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
      const { nonce, password } = (req.body ?? {}) as { nonce?: string; password?: string };
      const r = await executePrepared(String(nonce ?? ""), String(password ?? ""), clientIp(req));
      res.json({ ok: true, ordNo: r.ordNo, msg: r.msg, kind: r.ticket.kind });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "실패" });
    }
  };
  router.post("/execute", execute);
  router.post("/cancel/execute", execute);

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
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "실패" });
    }
  });

  return router;
}
