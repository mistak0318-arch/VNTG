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
  checkPin,
  setOrderPin,
  noteAccess,
  auditAccess,
  getSettings,
  saveSettings,
  saveGuard,
  unlockAuth,
  forgetPassword,
  type OrderGuard,
  type OrderVenue,
  type WatchInput,
  type WatchLeg,
  autoWatchSummary,
  buyPower,
  cancelAutoWatch,
  clearAutoWatchHistory,
  deleteAutoWatch,
  listAutoWatches,
  positions,
  watchPrices,
  watchQuote,
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
import { ledger } from "../orderLedger.js";

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
function legsOfAny(x: unknown): WatchLeg[] | null {
  if (!Array.isArray(x) || x.length === 0) return null;
  return x.slice(0, 8).map((l) => {
    const o2 = (l && typeof l === "object" ? l : {}) as Record<string, unknown>;
    return { pct: Number(o2.pct), qtyPct: Number(o2.qtyPct), exec: (o2.exec === "limit_now" ? "limit_now" : "market") as "market" | "limit_now" };
  });
}

/** 화면이 보낸 감시 조건을 모양만 맞춘다 — 뜻이 맞는지는 prepareOrder 가 잰다 */
function watchInputOf(v: unknown): WatchInput | null {
  if (!v || typeof v !== "object") return null;
  const w = v as Record<string, unknown>;
  const numOr = (x: unknown): number | null => (x === null || x === undefined || x === "" ? null : Number(x));
  const legsOf = legsOfAny;
  /* 옛 화면이 then 을 객체 하나로 보내도 받는다 */
  const then = Array.isArray(w.then)
    ? legsOf(w.then)
    : w.then && typeof w.then === "object"
      ? [{ pct: Number((w.then as Record<string, unknown>).pct), qtyPct: 100, exec: ((w.then as Record<string, unknown>).exec === "limit_now" ? "limit_now" : "market") as "market" | "limit_now" }]
      : null;
  return {
    dir: w.dir === "ge" ? "ge" : "le",
    basis: (["price", "prevClose", "avg", "now"].includes(String(w.basis)) ? String(w.basis) : "price") as WatchInput["basis"],
    pct: numOr(w.pct),
    price: numOr(w.price),
    exec: (["market", "limit_trigger", "limit_now", "limit_fixed"].includes(String(w.exec)) ? String(w.exec) : "market") as WatchInput["exec"],
    limitPrice: numOr(w.limitPrice),
    validUntil: w.validUntil ? String(w.validUntil) : null,
    then,
    legs: legsOf(w.legs),
    dual: w.dual !== false,
    replaceId: w.replaceId ? String(w.replaceId).replace(/[^0-9a-f]/g, "").slice(0, 12) || null : null,
  };
}

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

  /* 잠금 풀기 — 세션 문 앞에서도 되어야 한다(진입 PIN 잠금이 문 앞이다). 앱 아이디·비밀번호로 */
  router.post("/unlock", async (req, res) => {
    if (!mutating(req, res)) return;
    try {
      const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
      const r = await verifyCredentials(String(username ?? ""), String(password ?? ""));
      if (r !== "ok") {
        res.status(401).json({ error: r === "disabled" ? "로그인이 꺼져 있다" : "아이디 또는 비밀번호가 틀렸다" });
        return;
      }
      await unlockAuth();
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "실패" });
    }
  });

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
    const { username, password, pin } = (req.body ?? {}) as {
      username?: string;
      password?: string;
      pin?: string;
    };

    /*
     * 문 여는 방법 두 가지 (2026-09-04). PIN 은 **기기 등록이 켜져 있을 때만** 고를 수 있으므로
     * (saveSettings 가 막는다), 여기 오는 PIN 은 이미 등록된 기기에서 온 것이다.
     */
    const entry = await getSettings();
    let r: "ok" | "bad" | "disabled";
    /*
     * **PIN 판이어도 아이디·비밀번호는 늘 받는다** (2026-09-04).
     *
     * 여태 `entryMode === "pin"` 이면 PIN 만 봤다. 그런데 새 기기를 등록한 **직후**에는
     * 화면이 아이디·비밀번호를 들고 있고(등록이 그것으로만 되므로) PIN 은 안 물어본
     * 상태다 — 그 길로 세션을 열려다 401 을 받고 「확인 실패」로 끝났다. 기기는 등록됐는데
     * 문은 안 열리는 자리가 생긴 것이다.
     *
     * 아이디·비밀번호는 PIN 보다 **약한 열쇠가 아니다.** PIN 은 등록된 기기에서 빨리 여는
     * 지름길일 뿐이고, 어느 쪽으로 들어와도 아래 기기 검사는 똑같이 지난다. 그래서 PIN 이
     * 안 왔으면 원래 길로 본다.
     */
    const byPinLike = entry.entryMode === "pin" || entry.entryMode === "pattern";
    if (byPinLike && blank(pin) && !blank(username)) {
      r = await verifyCredentials(String(username ?? ""), String(password ?? ""));
    } else if (byPinLike) {
      const pr = await checkPin(String(pin ?? ""));
      if (!pr.ok) {
        const n = (f?.n ?? 0) + 1;
        fails.set(ip, { n, until: n >= 5 ? Date.now() + 15 * 60_000 : 0 });
        await appendLog({ kind: "session", ip, msg: `PIN 으로 열기 실패 — ${pr.error}` });
        res.status(401).json({ error: pr.error });
        return;
      }
      r = "ok";
    } else {
      r = await verifyCredentials(String(username ?? ""), String(password ?? ""));
    }
    if (r === "disabled") {
      res.status(403).json({ error: "앱 로그인(설정 › 보안)을 먼저 켜야 주문 메뉴가 열린다 — 주문은 로그인 없이는 안 된다" });
      return;
    }
    if (r === "bad") {
      const n = (f?.n ?? 0) + 1;
      fails.set(ip, { n, until: n >= 5 ? Date.now() + 15 * 60_000 : 0 });
      await appendLog({ kind: "session", ip, msg: `주문 메뉴 열기 실패 ${n}회` });
      if (n === 1 || n % 5 === 0) {
        /* 로그 방으로 (2026-09-04) — 실패할 때마다 오던 줄이라 주문 방을 가장 많이 채웠다.
           진짜 위험(5회 잠금)은 그대로 주문 방으로 간다 */
        void sendTelegram(`🔐 주문 메뉴 열기 실패 ${n}회 · ${ip}`, "syslog").catch(() => undefined);
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
    const { username, password, pin } = (req.body ?? {}) as {
      username?: string;
      password?: string;
      pin?: string;
    };
    /*
     * 아무나 확인 메일을 쏘게 두지 않는다 — 메일 폭탄도 사고다.
     * ⚠️ **새 기기 등록은 PIN 으로 못 한다.** PIN 은 「이미 등록된 기기에서 빨리 여는」 열쇠지
     * 기기를 늘리는 열쇠가 아니다 — 네 자리로 새 기기를 들일 수 있으면 기기 겹이 뜻을 잃는다.
     */
    const cred = await verifyCredentials(String(username ?? ""), String(password ?? ""));
    if (cred !== "ok") {
      res.status(401).json({
        error: pin
          ? "새 기기 등록은 아이디·비밀번호로만 됩니다 (PIN 은 등록된 기기에서 여는 용도입니다)"
          : "아이디 또는 비밀번호가 다릅니다",
      });
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
      const { next: nextPw, current, kind } = (req.body ?? {}) as { next?: string; current?: string; kind?: string };
      await setOrderPassword(String(nextPw ?? ""), current === undefined ? null : String(current), kind === "pattern" ? "pattern" : "text");
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
   * **매수 가능 수량** (2026-09-07) — 현금만 · 증거금 적용 · 신용, 셋을 한 번에.
   * 조회만이라 주문 비밀번호는 안 묻지만 주문 세션 안이어야 한다(계좌 사정이 드러난다).
   */
  router.get("/buy-power", async (req, res) => {
    try {
      const code = String(req.query.code ?? "");
      const price = Number(req.query.price);
      if (!/^\d{6}$/.test(code) || !Number.isFinite(price) || price <= 0) {
        res.status(400).json({ error: "code(6자리)와 price 가 있어야 한다" });
        return;
      }
      res.json(await buyPower(code, price));
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

  /**
   * 자동감시주문 (2026-09-07 밤) — 목록·취소·종목 값. 등록은 /prepare 에 `watch` 를 실어 /execute(비밀번호)를
   * 그대로 지난다. 취소는 세션만(돈이 안 나가는 방향).
   * ⚠️ 09-07 예약을 걷어낼 때 이 라우트가 같이 잘려 나가 탭이 404 를 받았다 — 벤티지가 잡았다.
   */
  /** 잔고·수익률 현황 — 총 잔액·예수금·자산 추이·일/주/월/종목별 실현손익 (2026-09-07 밤) */
  router.get("/ledger", async (req, res) => {
    try {
      const days = Math.min(730, Math.max(7, Number(req.query.days) || 90));
      res.json(await ledger(days));
    } catch (e) {
      res.status(502).json({ error: e instanceof Error ? e.message : "조회 실패" });
    }
  });
  /** 포지션 (개편 ①) — 잔고·감시·미체결·체결을 종목 카드 하나로 */
  router.get("/positions", async (_req, res) => {
    try {
      res.json(await positions(main));
    } catch (e) {
      res.status(502).json({ error: e instanceof Error ? e.message : "조회 실패" });
    }
  });
  router.get("/watch", async (_req, res) => {
    try {
      const [rows, summary] = await Promise.all([listAutoWatches(), autoWatchSummary()]);
      const live = rows.filter((x) => x.status === "waiting").map((x) => x.ticket.code);
      const prices = await watchPrices(main, live).catch(() => ({}));
      res.json({ rows, prices, ...summary });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : "조회 실패", rows: [] });
    }
  });
  router.get("/watch/quote", async (req, res) => {
    try {
      const code = String(req.query.code ?? "");
      if (!/^\d{6}$/.test(code)) {
        res.status(400).json({ error: "code(6자리)가 있어야 한다" });
        return;
      }
      res.json(await watchQuote(main, code));
    } catch (e) {
      res.status(502).json({ error: e instanceof Error ? e.message : "조회 실패" });
    }
  });
  router.post("/watch/delete", async (req, res) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      await deleteAutoWatch(String(b.id ?? ""), clientIp(req));
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "실패" });
    }
  });
  router.post("/watch/clear", async (req, res) => {
    try {
      res.json({ ok: true, removed: await clearAutoWatchHistory(clientIp(req)) });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "실패" });
    }
  });
  router.post("/watch/cancel", async (req, res) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const row = await cancelAutoWatch(String(b.id ?? ""), clientIp(req));
      res.json({ ok: true, row });
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
          /* 신용 (2026-09-07) — 안 보내면 현금. 켜져 있는지는 prepareOrder 가 가드로 잰다 */
          credit: b.credit === true,
          loanDate: blank(b.loanDate) ? null : String(b.loanDate),
          /* 자동감시 (2026-09-07 밤) — 조건 덩어리. 값 검증은 prepareOrder 가 한다 */
          watch: watchInputOf(b.watch),
          /* 출구 계획 (개편 ①) — 즉시 매수에 붙는 단계 */
          exit: legsOfAny(b.exit),
        },
        clientIp(req),
        sessionOf(req),
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
        sessionOf(req),
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

  /**
   * 한도·규칙(orderGuard) 편집 (2026-09-08). 비밀번호를 다시 받는다 — 주문과 같은 무게.
   * 읽기는 `/status` 가 이미 guard 를 준다.
   */
  router.post("/guard", async (req, res) => {
    try {
      const { password, patch } = (req.body ?? {}) as { password?: string; patch?: Record<string, unknown> };
      const r = await checkPassword(String(password ?? ""));
      if (!r.ok) {
        res.status(401).json({ error: r.error });
        return;
      }
      const guard = await saveGuard((patch ?? {}) as Partial<OrderGuard>);
      res.json({ guard });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "실패" });
    }
  });

  /** 주문 화면 설정 — 한도(orderGuard)는 위 /guard 에서 (2026-09-08 전까지는 파일만이었다) */
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

  /**
   * 접근 점검 — **줄을 늘어놓지 않고 판정만** 준다 (2026-09-04).
   * 로그를 화면에 쏟는 건 판정을 사람에게 미루는 것이다. 기계가 훑고 다른 것만 말한다.
   */
  router.get("/audit", async (req, res, next) => {
    try {
      const hours = Math.min(168, Math.max(1, Number(req.query.hours) || 24));
      res.json(await auditAccess(hours));
    } catch (e) {
      next(e);
    }
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

  /** 진입 PIN 정하기·바꾸기 — 지금 PIN 또는 주문 비밀번호로 확인한다 */
  router.post("/pin", async (req, res) => {
    try {
      const { next: nextPin, current, kind } = (req.body ?? {}) as { next?: string; current?: string; kind?: string };
      await setOrderPin(String(nextPin ?? ""), String(current ?? ""), kind === "pattern" ? "pattern" : "pin");
      res.json({ ok: true });
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
