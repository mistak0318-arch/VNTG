import { useEffect, useRef, useState } from "react";
import { api, type LoginNeedsOtp } from "../api";
import { clearNeedLogin, onNeedLogin } from "../loginState";

/**
 * 로그인 문 (2026-08-29 요청 — 「새로운 환경에서는 로그인 + 이메일 OTP」).
 *
 * ## 언제 나오나
 *
 * 앱이 뜨면 제일 먼저 서버에 「잠겨 있나, 나는 들어와 있나」를 묻는다. 잠금이
 * 꺼져 있으면(기본값) 이 화면은 **아예 안 그린다** — 지금까지처럼 바로 앱이다.
 *
 * 보는 도중에 세션이 끝나면 열려 있던 화면이 401 을 받고, 그 신호로 여기가 뜬다
 * ([loginState](../loginState.ts)).
 *
 * ## 세 걸음
 *
 *   ① 아이디·비밀번호. 알던 기기면 여기서 끝이다.
 *   ② 처음 보는 기기면 6자리 — 구글 OTP 앱이거나 메일이거나(설정에서 고른다).
 *      이때 **기기 이름**을 같이 받는다. 나중에 설정에서 「이건 잃어버린 폰이다」를
 *      알아보려면 이름이 있어야 한다.
 *   ③ 비밀번호를 잊었으면 메일로 6자리를 받아 새로 정한다. 해시는 되돌릴 수 없어서
 *      「찾기」가 아니라 사실 「새로 정하기」다.
 *
 * ## 들어온 뒤에 왜 새로고침하나
 *
 * 앱은 뜰 때 서버에서 설정을 받아 놓고 그린다(main.tsx). 잠긴 상태로 떴다면 그
 * 요청들이 전부 막혔으므로 화면이 기본값으로 서 있다. 들어오자마자 그 위에
 * 데이터를 얹으면 어디는 채워지고 어디는 안 채워진 얼룩덜룩한 상태가 된다.
 * **한 번 새로 뜨는 편이 확실하다** — 로그인은 자주 하는 일이 아니다.
 */

type Step =
  | { kind: "password" }
  | { kind: "otp"; ticket: string; sentTo: string; method: "email" | "totp" }
  | { kind: "forgot" }
  | { kind: "reset"; ticket: string; sentTo: string };

export function LoginGate({ children }: { children: React.ReactNode }) {
  /** null = 아직 물어보는 중 — 그동안은 아무것도 안 그린다(칸이 깜빡이는 게 더 나쁘다) */
  const [locked, setLocked] = useState<boolean | null>(null);
  const [step, setStep] = useState<Step>({ kind: "password" });
  const [id, setId] = useState("");
  const [pw, setPw] = useState("");
  const [code, setCode] = useState("");
  const [newPw, setNewPw] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  /* 처음 한 번 — 잠겨 있나. 아이디는 서버가 아는 것을 미리 채워 준다 */
  useEffect(() => {
    let alive = true;
    api
      .authState()
      .then((s) => {
        if (!alive) return;
        setLocked(s.enabled && !s.authed);
        setId(s.username);
      })
      .catch(() => alive && setLocked(false)); // 못 물어봤으면 막지 않는다
    return () => {
      alive = false;
    };
  }, []);

  /* 보던 중에 세션이 끝난 경우 */
  useEffect(() => onNeedLogin((v) => v && setLocked(true)), []);

  /* 칸이 뜨면 바로 칠 수 있게 */
  useEffect(() => {
    if (locked) inputRef.current?.focus();
  }, [locked, step.kind]);

  if (locked === null) return null;
  if (!locked) return <>{children}</>;

  const done = () => {
    clearNeedLogin();
    window.location.reload();
  };

  /** 어느 걸음이든 같은 껍데기를 쓴다 — 오가면서 카드가 튀지 않게 */
  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch {
      setError("서버에 닿지 못했습니다");
    } finally {
      setBusy(false);
    }
  };

  const submitPassword = () =>
    run(async () => {
      const r = await api.login(id, pw);
      if ("otpRequired" in r) {
        const o = r as LoginNeedsOtp;
        setStep({ kind: "otp", ticket: o.ticket, sentTo: o.sentTo, method: o.method });
        setPw("");
        setCode("");
      } else if (r.ok) done();
      else setError(r.error);
    });

  const submitOtp = () =>
    run(async () => {
      if (step.kind !== "otp") return;
      const r = await api.loginOtp(step.ticket, code, deviceName);
      if (r.ok) done();
      else setError(r.error ?? "확인에 실패했습니다");
    });

  const askReset = () =>
    run(async () => {
      const r = await api.authForgot();
      if (r.ok && r.ticket) {
        setStep({ kind: "reset", ticket: r.ticket, sentTo: r.sentTo ?? "메일" });
        setCode("");
        setNewPw("");
        setNotice(null);
      } else setError(r.error ?? "메일을 보내지 못했습니다");
    });

  const submitReset = () =>
    run(async () => {
      if (step.kind !== "reset") return;
      const r = await api.authReset(step.ticket, code, newPw);
      if (r.ok) {
        setStep({ kind: "password" });
        setCode("");
        setNewPw("");
        setPw("");
        setNotice("비밀번호를 새로 정했습니다. 다시 로그인하세요.");
      } else setError(r.error ?? "재설정에 실패했습니다");
    });

  const backToPassword = () => {
    setStep({ kind: "password" });
    setError(null);
    setCode("");
  };

  return (
    <div className="login-wrap">
      {/* 배경 — 순수 장식이라 화면낭독기는 건너뛴다 */}
      <div className="login-bg" aria-hidden="true">
        <div className="login-grid" />
        <div className="login-glow login-glow-a" />
        <div className="login-glow login-glow-b" />
        <Ticker />
      </div>

      <div className="login-card">
        <div className="login-mark">
          <span className="login-mark-v">V</span>NTG
        </div>
        <div className="login-sub">개인용 시세 분석</div>

        {step.kind === "password" && (
          <>
            <input
              ref={inputRef}
              className="login-input"
              value={id}
              onChange={(e) => setId(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void submitPassword()}
              placeholder="아이디"
              autoComplete="username"
              autoCapitalize="off"
              autoCorrect="off"
            />
            <input
              type="password"
              className="login-input"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void submitPassword()}
              placeholder="비밀번호"
              autoComplete="current-password"
            />
            <button className="login-go" disabled={busy || !id || !pw} onClick={submitPassword}>
              {busy ? "확인 중…" : "로그인"}
            </button>
            <button className="login-link" onClick={() => setStep({ kind: "forgot" })}>
              비밀번호를 잊었어요
            </button>
          </>
        )}

        {step.kind === "otp" && (
          <>
            <p className="login-lead">
              처음 보는 기기입니다.
              <br />
              {step.method === "totp" ? (
                <>
                  <b>구글 OTP 앱</b>에 뜬 6자리를 입력하세요.
                </>
              ) : (
                <>
                  <b>{step.sentTo}</b> 로 보낸 6자리를 입력하세요.
                </>
              )}
            </p>
            <input
              ref={inputRef}
              /* 숫자 자판이 뜨게 — 폰에서 6자리 치는데 문자 자판이면 두 번 손이 간다 */
              inputMode="numeric"
              className="login-input login-code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              onKeyDown={(e) => e.key === "Enter" && code.length === 6 && void submitOtp()}
              placeholder="000000"
              autoComplete="one-time-code"
            />
            <input
              className="login-input"
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value.slice(0, 30))}
              onKeyDown={(e) => e.key === "Enter" && code.length === 6 && void submitOtp()}
              placeholder="이 기기 이름 (예: 갤럭시 폰)"
            />
            <button className="login-go" disabled={busy || code.length !== 6} onClick={submitOtp}>
              {busy ? "확인 중…" : "확인하고 이 기기 기억하기"}
            </button>
            <button className="login-link" onClick={backToPassword}>
              ← 처음부터 다시
            </button>
          </>
        )}

        {step.kind === "forgot" && (
          <>
            <p className="login-lead">
              등록된 메일로 <b>6자리</b>를 보냅니다.
              <br />
              받은 숫자로 비밀번호를 새로 정할 수 있습니다.
            </p>
            <button className="login-go" disabled={busy} onClick={askReset}>
              {busy ? "보내는 중…" : "확인 메일 보내기"}
            </button>
            <button className="login-link" onClick={backToPassword}>
              ← 처음부터 다시
            </button>
          </>
        )}

        {step.kind === "reset" && (
          <>
            <p className="login-lead">
              <b>{step.sentTo}</b> 로 보낸 6자리와
              <br />새 비밀번호를 입력하세요.
            </p>
            <input
              ref={inputRef}
              inputMode="numeric"
              className="login-input login-code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="000000"
              autoComplete="one-time-code"
            />
            <input
              type="password"
              className="login-input"
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void submitReset()}
              placeholder="새 비밀번호 (4자 이상)"
              autoComplete="new-password"
            />
            <button
              className="login-go"
              disabled={busy || code.length !== 6 || newPw.length < 4}
              onClick={submitReset}
            >
              {busy ? "바꾸는 중…" : "비밀번호 바꾸기"}
            </button>
            <p className="login-warn">바꾸면 모든 기기가 로그아웃됩니다.</p>
            <button className="login-link" onClick={backToPassword}>
              ← 처음부터 다시
            </button>
          </>
        )}

        {error && <div className="login-error">{error}</div>}
        {notice && !error && <div className="login-notice">{notice}</div>}
      </div>
    </div>
  );
}

/**
 * 배경에 흐르는 봉차트.
 *
 * 한 번만 만들고 CSS 로 흘린다 — 매 프레임 자바스크립트가 도는 배경은 로그인 칸을
 * 치는 동안에도 계속 전기를 먹는다. 값은 아무 의미 없는 난수라 **시세처럼 보이는
 * 무늬**일 뿐이고, 진짜 숫자로 오해할 여지가 없게 축도 눈금도 안 붙인다.
 */
function Ticker() {
  const bars = useRef<{ h: number; y: number; up: boolean }[]>();
  if (!bars.current) {
    let p = 50;
    bars.current = Array.from({ length: 40 }, () => {
      const next = Math.max(12, Math.min(88, p + (Math.random() - 0.48) * 16));
      const up = next >= p;
      const bar = { h: Math.max(3, Math.abs(next - p) * 1.6 + 4), y: Math.min(p, next), up };
      p = next;
      return bar;
    });
  }
  return (
    <div className="login-ticker">
      {bars.current.map((b, i) => (
        <i
          key={i}
          className={b.up ? "up" : "down"}
          style={{ height: `${b.h}%`, bottom: `${b.y}%` }}
        />
      ))}
    </div>
  );
}
