import { useEffect, useState } from "react";
import { useRealtime } from "../useRealtime";

/**
 * **지금 이 값이 실시간인가** — 어느 화면에서든 한 자리에서 (2026-09-04).
 *
 * 벤티지: "실수를 줄이기 위해서 안전장치 하나를 주자. 시세분석에 보면 연결되면 앞에 녹색
 * 버튼 하나 뜨지. 이거 다른 화면에서도 전부 다 보이게끔 — 내가 지금 보고 있는 종목의 가격이
 * 실시간으로 받아온다는 걸 한 번에 알 수 있도록."
 *
 * 이 표시가 안전장치인 이유: **멈춘 값으로 주문을 내는 것**이 이 도구에서 가장 비싼 실수다.
 * 실시간이 끊기면 화면은 조용히 3초 폴링으로 되돌아가고, 그 폴링마저 막히면 숫자가 그대로
 * 멈춰 선다 — 멈춘 숫자는 「틀렸다」고 말해 주지 않는다. 그래서 **값이 아니라 값의 출처**를
 * 늘 같은 자리에 적는다.
 *
 * 세 가지 상태를 가른다:
 *   ● 초록  이 종목의 체결이 실시간으로 들어오는 중
 *   ● 노랑  소켓은 살아 있는데 이 종목은 아직 안 물렸다(구독 정원 밖이거나 방금 열었다)
 *   ○ 회색  실시간이 꺼졌거나 끊겼다 — 지금 보는 값은 조회로 받은 것이다
 *
 * 종목을 안 주면(`code` 없음) 소켓 자체의 상태만 본다.
 */
export function LiveDot({ code, name }: { code?: string | null; name?: string | null }) {
  /*
   * 체결(`0B`) 하나만 본다. 호가·프로그램까지 보면 「무엇이 살아 있나」가 흐려지는데,
   * 사람이 묻는 건 늘 **「이 가격이 지금 값이냐」** 하나다.
   */
  const key = code ? `0B:${code}` : "";
  const rt = useRealtime(code ? [key] : [], 3000);

  /*
   * 종목이 없을 때는 `useRealtime` 이 아무것도 안 본다(키가 비면 곧장 빈 상태로 앉는다).
   * 그러면 소켓이 멀쩡한데도 「조회」로 보인다 — 그건 거짓말이다. 그때만 상태 창구를
   * 따로 두드린다. 키움을 부르지 않는 값이라 10초에 한 번이면 넉넉하다.
   */
  const [socketOnly, setSocketOnly] = useState(false);
  useEffect(() => {
    if (code) return;
    let alive = true;
    const tick = () =>
      void fetch("/api/realtime/status")
        .then((r) => r.json())
        .then((j: { enabled?: boolean; healthy?: boolean }) => {
          if (alive) setSocketOnly(Boolean(j.enabled && j.healthy));
        })
        .catch(() => undefined);
    tick();
    const t = setInterval(tick, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [code]);

  const socket = code ? rt.enabled && rt.healthy : socketOnly;
  const tick = Boolean(key && rt.values[key]);
  const level = !socket ? "off" : code ? (tick ? "on" : "wait") : "on";

  const label = level === "on" ? "실시간" : level === "wait" ? "대기" : "조회";
  const title =
    level === "on"
      ? code
        ? `${name ?? code} 체결이 실시간으로 들어오는 중입니다`
        : "실시간 연결이 살아 있습니다"
      : level === "wait"
        ? `실시간은 살아 있지만 ${name ?? code} 는 아직 안 물렸습니다 — 값은 3초 조회로 채웁니다`
        : "실시간이 꺼졌거나 끊겼습니다 — 지금 보는 값은 조회로 받은 것입니다";

  return (
    <span className={`live-dot ${level}`} title={title} aria-label={title}>
      <i />
      <b>{label}</b>
    </span>
  );
}
