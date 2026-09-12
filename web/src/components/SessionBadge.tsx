import { useEffect, useState } from "react";
import { api, type MarketStatus } from "../api";
import { sessionOf, type MarketKind, type Session } from "../marketSession";

/**
 * **장중인가 아닌가** 표 하나 (2026-09-08 — 벤티지 "장이 시작된 건지 끝난 건지를 모르겠네").
 *
 * 열려 있으면 점이 뛴다. 닫혀 있으면 잿빛으로 가만히 있다 — **한눈에 갈리는 게 요점**이라
 * 글자보다 움직임이 먼저 눈에 들어와야 한다.
 *
 * `kind="kr"` 만 서버 판정이다. 나머지는 시계로 센다(휴장일은 모른다).
 */

/* 국내장 상태 — 화면 수십 곳이 하나를 나눠 쓴다. 훅마다 폴링하면 분당 수십 번이 된다 */
let krState: MarketStatus | null = null;
let krTimer: ReturnType<typeof setInterval> | null = null;
const krSubs = new Set<(s: MarketStatus | null) => void>();
function krPull(): void {
  void api
    .marketStatus()
    .then((s) => {
      krState = s;
      for (const fn of krSubs) fn(s);
    })
    .catch(() => undefined);
}
function useKrStatus(on: boolean): MarketStatus | null {
  const [s, setS] = useState<MarketStatus | null>(krState);
  useEffect(() => {
    if (!on) return;
    krSubs.add(setS);
    setS(krState);
    if (!krTimer) {
      krPull();
      krTimer = setInterval(krPull, 60_000);
    }
    return () => {
      krSubs.delete(setS);
      if (krSubs.size === 0 && krTimer) {
        clearInterval(krTimer);
        krTimer = null;
      }
    };
  }, [on]);
  return s;
}

function krSession(s: MarketStatus | null): Session {
  if (!s) return { state: "closed", label: "…", hint: "국내장 상태를 받는 중" };
  if (s.state === "holiday") return { state: "closed", label: "휴장", hint: "오늘은 국내 증시 휴장일입니다" };
  if (s.state === "open") return { state: "open", label: "정규장", hint: "국내 정규장 09:00~15:30 — 지금 체결이 돕니다" };
  /*
   * 15:30~16:00 **거래 공백** (2026-09-14 개편, 2026-09-12에 미리 넣음).
   *
   * 9/14 부터 정규장이 끝나고 애프터마켓이 열리기까지 30분이 빈다 — 어느 시장도 안 연다.
   * 「마감」이라고만 적으면 20:00 뒤와 생김새가 같아서, 잠깐 쉬는 건지 오늘이 끝난 건지를
   * 모른다. 9/13 까지는 서버가 이 국면을 아예 안 주므로 표가 예전 그대로다.
   */
  if (s.session === "공백") {
    return { state: "closed", label: "휴식", hint: "정규장은 끝났고 애프터마켓(16:00)은 아직입니다 — 지금은 어느 시장도 안 엽니다" };
  }
  /* 서버의 live 는 시간외(프리 08:00~09:00 · 애프터)를 포함한다 */
  if (s.live) {
    if (s.state === "pre") {
      return { state: "pre", label: "프리 (NXT)", hint: "NXT 시간외 거래 중입니다 — 정규장은 아닙니다" };
    }
    /* 9/14 부터 애프터엔 KRX 도 있다 — `venue` 가 그걸 말한다(그 전엔 "nxt") */
    const both = s.venue === "krx+nxt";
    return {
      state: "after",
      label: both ? "애프터 (KRX·NXT)" : "애프터 (NXT)",
      hint: both
        ? "KRX 애프터마켓 16:00~20:00 (NXT 도 함께) 거래 중입니다 — 정규장은 아닙니다"
        : "NXT 시간외 거래 중입니다 — 정규장은 아닙니다",
    };
  }
  if (s.state === "pre") return { state: "closed", label: "장 전", hint: "아직 안 열렸습니다 — 지금 값은 어제 종가입니다" };
  return { state: "closed", label: "마감", hint: "국내장이 닫혔습니다 — 지금 값은 종가입니다" };
}

export function SessionBadge({ kind, className }: { kind: MarketKind | "kr"; className?: string }) {
  const kr = useKrStatus(kind === "kr");
  /*
   * 1분에 한 번 다시 센다 — 개장·마감 시각을 넘겨도 표가 그대로면 거짓말이 된다.
   * 시계만 보는 계산이라 값이 없어도 도는 데 문제가 없다.
   */
  const [, tick] = useState(0);
  useEffect(() => {
    if (kind === "kr") return;
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, [kind]);

  const s = kind === "kr" ? krSession(kr) : sessionOf(kind);
  return (
    <span className={`sess ${s.state} ${className ?? ""}`} title={s.hint}>
      <i />
      {s.label}
    </span>
  );
}
