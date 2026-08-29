import { useEffect, useState } from "react";
import { api, type AuthConfigView, type OtpMethod } from "../api";

/**
 * 로그인 설정 (2026-08-29 요청).
 *
 * ## 여기서 정하는 것
 *
 *   · 잠금을 켤지 — **끄면 지금까지처럼** 아무나 열 수 있다
 *   · 아이디·비밀번호 (비밀번호는 해시로만 저장돼 다시 볼 수 없다)
 *   · 처음 보는 기기에 6자리를 물을지, 묻는다면 **구글 OTP 인지 메일인지**
 *   · 한 번 로그인이 몇 시간 가는지
 *   · 지금 기억하고 있는 기기 목록 (하나씩 끊을 수 있다)
 *
 * ## 순서에 뜻이 있다
 *
 * 위에서부터 「문이 잠겼나 → 열쇠는 뭔가 → 두 번째 열쇠 → 누가 들어와 있나」다.
 * 제일 아래 「문단속」은 로그인과 별개로 **서버가 어디까지 열려 있나**를 보여 준다 —
 * 이건 화면에서 못 바꾸고 `.env` 를 고쳐야 해서, 상태만 알려 주고 방법을 적는다.
 */

const HOUR_CHOICES = [
  { h: 4, label: "4시간" },
  { h: 12, label: "12시간" },
  { h: 24, label: "하루" },
  { h: 168, label: "일주일" },
  { h: 720, label: "한 달" },
];

export function LoginSettingsPanel() {
  const [cfg, setCfg] = useState<AuthConfigView | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /* 비밀번호 바꾸기 */
  const [curPw, setCurPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [nameDraft, setNameDraft] = useState("");

  /* 구글 OTP 등록 중 */
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [setupCode, setSetupCode] = useState("");

  const load = () => {
    api
      .authConfig()
      .then((c) => {
        setCfg(c);
        setNameDraft(c.username);
      })
      .catch((e: Error) => setErr(e.message));
  };
  useEffect(load, []);

  /** 눌렀을 때 결과 한 줄을 남긴다 — 조용히 성공하면 눌린 건지 알 수 없다 */
  const run = async (label: string, fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await fn();
      setMsg(`${label} 완료`);
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : `${label} 실패`);
    } finally {
      setBusy(false);
    }
  };

  if (!cfg) return <div className="empty">{err ?? "불러오는 중…"}</div>;

  const mailBlocked = !cfg.mailReady;

  return (
    <div className="login-set">
      {/* ── 잠금 ─────────────────────────────────────────────── */}
      {cfg.isFirstPassword && (
        <div className="login-set-warn">
          아직 <b>처음 준 비밀번호(0000)</b> 그대로입니다. 아래에서 바꿔 주세요.
        </div>
      )}

      <div className="login-set-row">
        <div>
          <b>로그인 잠금</b>
          <span className="login-set-hint">
            켜면 이 서버의 모든 데이터가 로그인 뒤로 들어갑니다. 집 안에서
            <code>192.168.x.x</code> 로 바로 들어오는 길도 함께 막힙니다.
          </span>
        </div>
        <button
          className={cfg.enabled ? "login-set-on" : "login-set-off"}
          disabled={busy}
          onClick={() =>
            void run(cfg.enabled ? "잠금 끄기" : "잠금 켜기", () => api.authEnable(!cfg.enabled))
          }
        >
          {cfg.enabled ? "켜짐" : "꺼짐"}
        </button>
      </div>

      {/* ── 아이디·비밀번호 ──────────────────────────────────── */}
      <h4 className="login-set-h">아이디 · 비밀번호</h4>
      <div className="login-set-form">
        <label>
          아이디
          <div className="login-set-inline">
            <input value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} />
            <button
              disabled={busy || nameDraft === cfg.username || !nameDraft}
              onClick={() => void run("아이디 변경", () => api.authSetUsername(nameDraft))}
            >
              바꾸기
            </button>
          </div>
        </label>

        <label>
          지금 비밀번호
          <input type="password" value={curPw} onChange={(e) => setCurPw(e.target.value)} />
        </label>
        <label>
          새 비밀번호
          <input
            type="password"
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
            placeholder="4자 이상"
          />
        </label>
        {newPw.length > 0 && newPw.length < 8 && (
          <p className="login-set-note">
            짧은 비밀번호입니다. 다섯 번 틀리면 문이 점점 느려져(최대 10분) 기계로
            훑기는 어렵지만, 그래도 길수록 두꺼운 벽입니다.
          </p>
        )}
        <button
          className="login-set-go"
          disabled={busy || newPw.length < 4 || !curPw}
          onClick={() =>
            void run("비밀번호 변경", async () => {
              await api.authSetPassword(curPw, newPw);
              setCurPw("");
              setNewPw("");
            })
          }
        >
          비밀번호 바꾸기
        </button>
        <p className="login-set-note">
          비밀번호는 <b>되돌릴 수 없게</b>(scrypt 해시) 저장돼 서버도 원문을 모릅니다.
          잊었으면 로그인 화면의 「비밀번호를 잊었어요」로 메일 확인 후 새로 정하세요.
        </p>
      </div>

      {/* ── 2단계 ────────────────────────────────────────────── */}
      <h4 className="login-set-h">처음 보는 기기</h4>
      <div className="login-set-row">
        <div>
          <b>새 기기에서 6자리 더 묻기</b>
          <span className="login-set-hint">
            알던 기기(180일 기억)에서는 안 묻습니다. 브라우저를 지우면 다시 처음 보는
            기기가 됩니다.
          </span>
        </div>
        <button
          className={cfg.otpForNewDevice ? "login-set-on" : "login-set-off"}
          disabled={busy}
          onClick={() =>
            void run("설정 변경", () =>
              api.authOptions({ otpForNewDevice: !cfg.otpForNewDevice }),
            )
          }
        >
          {cfg.otpForNewDevice ? "묻기" : "안 묻기"}
        </button>
      </div>

      {cfg.otpForNewDevice && (
        <>
          <div className="login-set-methods">
            {(
              [
                {
                  key: "totp" as OtpMethod,
                  title: "구글 OTP 앱",
                  desc: "앱에 뜬 6자리. 인터넷도 메일함도 필요 없고 즉시입니다.",
                  ready: cfg.totpReady,
                  blocked: !cfg.totpReady,
                  blockNote: "먼저 아래에서 등록하세요",
                },
                {
                  key: "email" as OtpMethod,
                  title: "이메일",
                  desc: cfg.mailReady ? `${cfg.mailTo} 로 보냅니다.` : "메일 설정이 없습니다.",
                  ready: cfg.mailReady,
                  blocked: mailBlocked,
                  blockNote: ".env 의 메일 설정이 필요합니다",
                },
              ] as const
            ).map((m) => (
              <button
                key={m.key}
                className={`login-set-method${cfg.otpMethod === m.key ? " on" : ""}${
                  m.blocked ? " blocked" : ""
                }`}
                disabled={busy || m.blocked}
                onClick={() => void run("방식 변경", () => api.authOptions({ otpMethod: m.key }))}
              >
                <b>{m.title}</b>
                <span>{m.blocked ? m.blockNote : m.desc}</span>
              </button>
            ))}
          </div>

          {/* 구글 OTP 등록 */}
          <div className="login-set-totp">
            {cfg.totpReady && !setup ? (
              <div className="login-set-inline">
                <span className="login-set-ok">구글 OTP 등록됨</span>
                <button
                  disabled={busy}
                  onClick={() => void run("구글 OTP 해제", () => api.authTotpClear())}
                >
                  해제
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run("새 키 발급", async () => setSetup(await api.authTotpBegin()))
                  }
                >
                  다시 등록
                </button>
              </div>
            ) : !setup ? (
              <button
                className="login-set-go"
                disabled={busy}
                onClick={() =>
                  void run("설정 키 발급", async () => setSetup(await api.authTotpBegin()))
                }
              >
                구글 OTP 등록하기
              </button>
            ) : null}

            {setup && (
              <div className="login-set-setup">
                <p className="login-set-note">
                  <b>폰에서 보고 있다면</b> 아래 링크를 누르세요 — 인증 앱이 바로 열립니다.
                  <br />
                  <b>PC라면</b> 앱에서 「설정 키 입력」을 골라 아래 키를 옮겨 적으세요.
                </p>
                <a className="login-set-uri" href={setup.uri}>
                  인증 앱에서 열기
                </a>
                <div className="login-set-secret">
                  {setup.secret.replace(/(.{4})/g, "$1 ").trim()}
                </div>
                <button
                  className="login-set-copy"
                  onClick={() => {
                    void navigator.clipboard?.writeText(setup.secret);
                    setMsg("설정 키를 복사했습니다");
                  }}
                >
                  키 복사
                </button>
                <p className="login-set-note">
                  앱에 넣은 뒤 <b>거기 뜬 6자리</b>를 넣어야 등록이 끝납니다. 확인을
                  통과해야 켜지므로, 잘못 옮겨 적었는데 켜져 버리는 일은 없습니다.
                </p>
                <div className="login-set-inline">
                  <input
                    inputMode="numeric"
                    value={setupCode}
                    placeholder="000000"
                    onChange={(e) => setSetupCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  />
                  <button
                    disabled={busy || setupCode.length !== 6}
                    onClick={() =>
                      void run("구글 OTP 등록", async () => {
                        await api.authTotpConfirm(setupCode);
                        setSetup(null);
                        setSetupCode("");
                      })
                    }
                  >
                    확인
                  </button>
                  <button
                    onClick={() => {
                      setSetup(null);
                      setSetupCode("");
                    }}
                  >
                    취소
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {/* ── 세션 ─────────────────────────────────────────────── */}
      <h4 className="login-set-h">로그인 유지</h4>
      <div className="login-set-hours">
        {HOUR_CHOICES.map((c) => (
          <button
            key={c.h}
            className={cfg.sessionHours === c.h ? "on" : ""}
            disabled={busy}
            onClick={() => void run("유지 시간 변경", () => api.authOptions({ sessionHours: c.h }))}
          >
            {c.label}
          </button>
        ))}
      </div>
      <p className="login-set-note">
        짧을수록 안전하고 자주 물어봅니다. 알던 기기라면 다시 물어도 비밀번호 한 번이라
        하루 정도가 무난합니다.
      </p>

      {/* ── 기기 ─────────────────────────────────────────────── */}
      <h4 className="login-set-h">기억하고 있는 기기 ({cfg.devices.length})</h4>
      {cfg.devices.length === 0 ? (
        <p className="login-set-note">아직 없습니다.</p>
      ) : (
        <ul className="login-set-devs">
          {cfg.devices.map((d) => (
            <li key={d.id}>
              <div>
                <b>
                  {d.name}
                  {d.current && <span className="login-set-cur">지금 이 기기</span>}
                </b>
                <span className="login-set-hint">
                  {d.ua.slice(0, 60)}
                  <br />
                  추가 {d.addedAt.slice(0, 10)} · 마지막 {d.lastSeenAt.slice(0, 10)}
                </span>
              </div>
              <button
                disabled={busy}
                onClick={() => void run("기기 해제", () => api.authRemoveDevice(d.id))}
              >
                해제
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        className="login-set-danger"
        disabled={busy}
        onClick={() => void run("전체 해제", () => api.authRevokeAll())}
      >
        모든 기기·세션 끊기
      </button>
      <p className="login-set-note">
        서명 열쇠를 새로 뽑아 <b>나가 있는 모든 쿠키를 무효로</b> 만듭니다. 지금 이
        브라우저도 로그아웃됩니다. 어딘가에 세션이 남아 있는 것 같을 때 쓰세요.
      </p>

      {/* ── 문단속 ───────────────────────────────────────────── */}
      <h4 className="login-set-h">서버 문단속</h4>
      <p className="login-set-note">
        로그인과 별개로 <b>서버가 어디까지 열려 있는지</b>입니다. 여기서는 못 바꾸고
        미니PC의 <code>server/.env</code> 를 고친 뒤 서버를 다시 켜야 합니다.
      </p>
      <ul className="login-set-door">
        <li className={cfg.door.corsRestricted ? "ok" : "bad"}>
          <b>{cfg.door.corsRestricted ? "출처 제한됨" : "출처 전면 허용"}</b>
          <span className="login-set-hint">
            {cfg.door.corsRestricted ? (
              <>허용: {cfg.door.corsOrigins.join(", ")}</>
            ) : (
              <>
                <code>ALLOWED_ORIGINS</code> 가 비어 있어 <b>아무 웹사이트의 자바스크립트나</b>{" "}
                이 API를 부를 수 있습니다. <code>ALLOWED_ORIGINS=https://vntgts.com</code> 를
                넣으세요.
              </>
            )}
          </span>
        </li>
        <li className={cfg.door.loopbackOnly ? "ok" : "bad"}>
          <b>{cfg.door.loopbackOnly ? "이 기계에서만 접속" : `모든 주소에서 접속 가능`}</b>
          <span className="login-set-hint">
            {cfg.door.loopbackOnly ? (
              <>
                <code>BIND_HOST={cfg.door.bindHost}</code> — 터널만 통과합니다.
              </>
            ) : (
              <>
                <code>BIND_HOST={cfg.door.bindHost}</code> — 같은 공유기의 아무 기기나{" "}
                <code>192.168.x.x</code> 로 닿습니다. 터널을 쓴다면{" "}
                <code>BIND_HOST=127.0.0.1</code> 로 좁히세요.
                {cfg.enabled && <> (지금은 로그인 잠금이 그 길도 막고 있습니다.)</>}
              </>
            )}
          </span>
        </li>
      </ul>

      {msg && <div className="login-set-msg">{msg}</div>}
      {err && <div className="login-set-err">{err}</div>}
    </div>
  );
}
