import { useEffect, useRef, useState } from "react";
import { PIN } from "../useScreenLock";

/**
 * 잠금 화면 — **아무것도 아닌 화면처럼 보이는 것**이 요점이다.
 *
 * ## 왜 아무 말도 안 적나
 *
 * 처음에는 「잠김」이라 크게 적고 무엇이 잠겼는지, 어떻게 푸는지까지 설명했다.
 * 그런데 이 화면의 목적은 **자리를 비운 사이 남의 눈에 안 걸리는 것**이다.
 * 「잠김」이라고 적힌 검은 화면은 지나가는 사람에게 *여기 뭔가 감출 게 있다*고
 * 알려 주는 셈이라, 가리려던 것과 정확히 반대로 간다.
 *
 * 그래서 **흰 배경에 입력칸 하나**만 둔다. 로그인 화면 같기도 하고 덜 뜬 페이지
 * 같기도 한, 아무 뜻도 읽히지 않는 화면이 가장 안전하다.
 *
 * 같은 이유로 **틀렸다는 말도 안 띄운다.** 「비밀번호가 다릅니다」가 뜨면 그 순간
 * 잠금 화면인 게 드러난다. 대신 칸을 비우고 살짝 흔든다 — 치는 사람은 알아채고
 * 보는 사람은 모른다.
 *
 * ## 설명은 여기(주석)에 남긴다
 *
 * 화면에서 지운 것이지 없앤 게 아니다. 알아야 할 것은 설정 화면에 적혀 있다:
 * 네 자리 고정 PIN, 새로고침으로 안 풀림, **보안 경계가 아니라 화면 가리개**라는 것.
 */
export function ScreenLock({ onUnlock }: { onUnlock: () => void }) {
  const [pin, setPin] = useState("");
  const [shake, setShake] = useState(0);
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

  /* 네 자리가 차면 스스로 확인한다 — 「열기」 버튼도 단서가 된다 */
  useEffect(() => {
    if (pin.length < 4 || wait > 0) return;
    if (pin === PIN) {
      onUnlock();
      return;
    }
    tries.current += 1;
    setPin("");
    setShake((n) => n + 1);
    // 세 번 틀리면 잠깐 못 치게 한다. 찍어 보는 걸 성가시게 만드는 정도다
    if (tries.current >= 3) setWait(Math.min(5 * (tries.current - 2), 30));
  }, [pin, wait, onUnlock]);

  return (
    <div className="lock">
      {/*
        `key={shake}` 로 애니메이션을 다시 태운다 — 같은 요소에 클래스만 도로 붙이면
        브라우저가 「이미 그 상태」로 보고 두 번째부터 안 흔들린다.
      */}
      <input
        key={shake}
        ref={inputRef}
        type="password"
        className={`lock-input${shake > 0 ? " shake" : ""}`}
        value={pin}
        onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
        inputMode="numeric"
        autoComplete="off"
        aria-label=""
        disabled={wait > 0}
      />
    </div>
  );
}
