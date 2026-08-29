import { Router } from "express";
import type { Request } from "express";
import {
  authConfig,
  authState,
  beginTotp,
  clearTotp,
  confirmTotp,
  forgot,
  login,
  logout,
  removeDevice,
  resetPassword,
  revokeAll,
  setEnabled,
  setOptions,
  setPassword,
  setUsername,
  totpNow,
  verifyOtp,
} from "../auth.js";

/**
 * 로그인 창구.
 *
 * ## ⚠️ 이 라우터만 문지기 앞에 선다
 *
 * `requireAuth` 가 `/api/auth/*` 를 통과시키므로, **여기 있는 것은 로그인 없이도
 * 부를 수 있다.** 그래서 설정을 바꾸는 것들(비밀번호·켜기·기기 삭제·구글 OTP)은
 * 각자 「지금 로그인돼 있나」를 다시 확인한다 — 안 그러면 잠가 놓은 문 옆에
 * 손잡이를 하나 더 달아 두는 꼴이다.
 *
 * 로그인 없이 되어야 하는 것은 셋뿐이다: `state`(칸을 띄울지 판단), `login`/`otp`,
 * 그리고 **비밀번호 찾기**(못 들어가는 사람이 쓰는 것이라 로그인을 요구할 수 없다).
 * 찾기 쪽은 대신 auth.ts 에서 「등록된 한 주소로만 보낸다 + 1분에 한 번」으로 조인다.
 */
export function createAuthRouter(): Router {
  const router = Router();

  /** 잠금이 켜져 있는데 로그인 안 됐으면 막는다 */
  async function guard(req: Request): Promise<string | null> {
    const s = await authState(req);
    return s.authed ? null : "로그인이 필요합니다";
  }

  /* ── 로그인 없이 ──────────────────────────────────────────────────── */

  /** 화면이 뜰 때 제일 먼저 묻는 것 — 로그인 칸을 띄울지 말지 */
  router.get("/state", async (req, res, next) => {
    try {
      res.json(await authState(req));
    } catch (err) {
      next(err);
    }
  });

  router.post("/login", async (req, res, next) => {
    try {
      const r = await login(
        req,
        res,
        String(req.body?.username ?? ""),
        String(req.body?.password ?? ""),
      );
      /* 틀린 비밀번호는 401 로 — 화면이 「다시」와 「고장」을 구분해야 한다.
         2단계가 필요한 것은 실패가 아니라 다음 걸음이라 200 으로 준다. */
      if (!r.ok && !("otpRequired" in r)) return res.status(401).json(r);
      res.json(r);
    } catch (err) {
      next(err);
    }
  });

  router.post("/otp", async (req, res, next) => {
    try {
      const r = await verifyOtp(
        req,
        res,
        String(req.body?.ticket ?? ""),
        String(req.body?.code ?? ""),
        String(req.body?.deviceName ?? ""),
      );
      if (!r.ok) return res.status(401).json(r);
      res.json(r);
    } catch (err) {
      next(err);
    }
  });

  router.post("/logout", (req, res) => {
    logout(req, res);
    res.json({ ok: true });
  });

  /** 비밀번호 찾기 ① 등록된 메일로 6자리를 보낸다 */
  router.post("/forgot", async (req, res, next) => {
    try {
      const r = await forgot(req);
      if (!r.ok) return res.status(400).json(r);
      res.json(r);
    } catch (err) {
      next(err);
    }
  });

  /** 비밀번호 찾기 ② 6자리를 맞히고 새로 정한다 (모든 기기가 로그아웃된다) */
  router.post("/reset", async (req, res, next) => {
    try {
      const r = await resetPassword(
        req,
        String(req.body?.ticket ?? ""),
        String(req.body?.code ?? ""),
        String(req.body?.next ?? ""),
      );
      if (!r.ok) return res.status(400).json(r);
      res.json(r);
    } catch (err) {
      next(err);
    }
  });

  /* ── 아래는 설정 화면용. 전부 로그인 확인을 다시 한다 ───────────────── */

  router.get("/config", async (req, res, next) => {
    try {
      const bad = await guard(req);
      if (bad) return res.status(401).json({ error: bad });
      res.json(await authConfig(req));
    } catch (err) {
      next(err);
    }
  });

  /**
   * 비밀번호 바꾸기 — 지금 것을 맞혀야 한다(auth.ts 가 확인한다).
   * 잠금이 켜져 있으면 로그인도 돼 있어야 한다.
   */
  router.post("/password", async (req, res, next) => {
    try {
      const s = await authState(req);
      if (s.enabled && !s.authed) return res.status(401).json({ error: "로그인이 필요합니다" });
      const r = await setPassword(String(req.body?.current ?? ""), String(req.body?.next ?? ""));
      if (!r.ok) return res.status(400).json(r);
      res.json(r);
    } catch (err) {
      next(err);
    }
  });

  router.post("/username", async (req, res, next) => {
    try {
      const s = await authState(req);
      if (s.enabled && !s.authed) return res.status(401).json({ error: "로그인이 필요합니다" });
      const r = await setUsername(String(req.body?.username ?? ""));
      if (!r.ok) return res.status(400).json(r);
      res.json(await authConfig(req));
    } catch (err) {
      next(err);
    }
  });

  router.post("/enable", async (req, res, next) => {
    try {
      const s = await authState(req);
      /* 끄는 것은 로그인한 사람만. 켜는 것은 아직 잠금이 없을 때도 돼야 한다 */
      if (s.enabled && !s.authed) return res.status(401).json({ error: "로그인이 필요합니다" });
      const r = await setEnabled(Boolean(req.body?.on));
      if (!r.ok) return res.status(400).json(r);
      res.json(r);
    } catch (err) {
      next(err);
    }
  });

  router.put("/options", async (req, res, next) => {
    try {
      const bad = await guard(req);
      if (bad) return res.status(401).json({ error: bad });
      const r = await setOptions({
        sessionHours: req.body?.sessionHours,
        otpForNewDevice: req.body?.otpForNewDevice,
        otpMethod: req.body?.otpMethod,
      });
      if (!r.ok) return res.status(400).json(r);
      res.json(await authConfig(req));
    } catch (err) {
      next(err);
    }
  });

  /* ── 구글 OTP 등록 ────────────────────────────────────────────────── */

  /** ① 설정 키를 뽑는다. 아직 저장 안 된다 — 확인을 통과해야 켜진다 */
  router.post("/totp/begin", async (req, res, next) => {
    try {
      const bad = await guard(req);
      if (bad) return res.status(401).json({ error: bad });
      res.json(await beginTotp());
    } catch (err) {
      next(err);
    }
  });

  /** ② 앱에 뜬 숫자를 맞히면 그때 저장한다 */
  router.post("/totp/confirm", async (req, res, next) => {
    try {
      const bad = await guard(req);
      if (bad) return res.status(401).json({ error: bad });
      const r = await confirmTotp(String(req.body?.code ?? ""));
      if (!r.ok) return res.status(400).json(r);
      res.json(await authConfig(req));
    } catch (err) {
      next(err);
    }
  });

  router.delete("/totp", async (req, res, next) => {
    try {
      const bad = await guard(req);
      if (bad) return res.status(401).json({ error: bad });
      await clearTotp();
      res.json(await authConfig(req));
    } catch (err) {
      next(err);
    }
  });

  /** 「지금 앱에 뭐가 떠 있어야 하나」 — 등록이 잘 됐는지 눈으로 맞춰 볼 때 */
  router.get("/totp/now", async (req, res, next) => {
    try {
      const bad = await guard(req);
      if (bad) return res.status(401).json({ error: bad });
      res.json({ code: await totpNow() });
    } catch (err) {
      next(err);
    }
  });

  /* ── 기기 ─────────────────────────────────────────────────────────── */

  router.delete("/device/:id", async (req, res, next) => {
    try {
      const bad = await guard(req);
      if (bad) return res.status(401).json({ error: bad });
      await removeDevice(req.params.id);
      res.json(await authConfig(req));
    } catch (err) {
      next(err);
    }
  });

  /** 마지막 수단 — 열쇠를 새로 뽑아 모든 기기·세션을 무효로 */
  router.post("/revoke-all", async (req, res, next) => {
    try {
      const bad = await guard(req);
      if (bad) return res.status(401).json({ error: bad });
      await revokeAll();
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
