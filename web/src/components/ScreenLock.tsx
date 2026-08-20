import { useEffect, useRef, useState } from "react";
import { sha256, type LockConfig } from "../useScreenLock";

/**
 * 잠금 화면 — **뒤를 완전히 가린다.**
 *
 * 반투명으로 두면 뒤의 계좌 잔고가 비쳐서 가리는 뜻이 없어진다. 불투명하게 덮는다.
 *
 * 틀린 횟수를 세어 **점점 느리게** 만든다. 진짜 방어는 아니지만
 * 옆에서 몇 번 찍어 보는 것 정도는 성가시게 만든다.
 */
export function ScreenLock({ config, onUnlock }: { config: LockConfig; onUnlock: () => void }) {
  const [pw, setPw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [wait, setWait] = useState(0);
  const tries = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // 열리자마자 바로 칠 수 있게
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (wait > 0) return;
    if (!pw) return;

    if ((await sha256(pw)) === config.hash) {
      onUnlock();
      return;
    }
    tries.current += 1;
    setPw("");
    setError("비밀번호가 다릅니다");
    // 세 번 틀리면 기다리게 한다 — 찍어 보는 걸 성가시게
    if (tries.current >= 3) setWait(Math.min(5 * (tries.current - 2), 30));
  }

  return (
    <div className="lock">
      <form className="lock-box" onSubmit={submit}>
        <div className="lock-title">잠김</div>
        <p className="lock-note">자리를 비운 사이 화면이 잠겼습니다.</p>
        <input
          ref={inputRef}
          type="password"
          className="lock-input"
          value={pw}
          onChange={(e) => {
            setPw(e.target.value);
            setError(null);
          }}
          placeholder="비밀번호"
          autoComplete="current-password"
          disabled={wait > 0}
        />
        {error && <div className="lock-err">{error}</div>}
        {wait > 0 && <div className="lock-err">{wait}초 뒤에 다시 시도할 수 있습니다</div>}
        <button className="primary-btn" type="submit" disabled={wait > 0 || !pw}>
          열기
        </button>
        {/*
          **새로고침으로는 안 풀린다.** 잠긴 사실을 localStorage 에 남기기 때문이고,
          그게 이 기능의 요점이다 — F5 로 넘어가면 가리는 뜻이 없다.
          그러니 「새로고침하면 된다」고 적으면 거짓말이 된다.
        */}
        <p className="lock-hint">
          새로고침해도 풀리지 않습니다. 비밀번호를 잊으셨다면 브라우저의 <b>사이트 데이터
          삭제</b>로만 풀 수 있습니다(설정도 함께 지워집니다).
          <br />이 잠금은 <b>화면을 가리는 용도</b>지 보안 경계가 아닙니다 — 진짜 방어는
          Cloudflare 인증과 OS 화면 잠금입니다.
        </p>
      </form>
    </div>
  );
}
