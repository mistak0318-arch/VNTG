import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime } from "../useRealtime";

/**
 * **지금 이 값이 실시간인가** — 어느 화면에서든 한 자리에서 (2026-09-04).
 *
 * 벤티지: "실수를 줄이기 위해서 안전장치 하나를 주자. 시세분석에 보면 연결되면 앞에 녹색
 * 버튼 하나 뜨지. 이거 다른 화면에서도 전부 다 보이게끔." + "클릭하면 상태 어떤지도 나오게."
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
 * 눌러 열면 **왜 그런지**가 나온다 — 점 하나로는 「끊겼다」까지만 말할 수 있고, 자리가
 * 모자란 것인지 소켓이 죽은 것인지는 손을 쓸 방법이 달라서 갈라 보여야 한다.
 */

interface Status {
  enabled: boolean;
  state?: string;
  healthy: boolean;
  lastSeen?: string | null;
  subscribed?: number;
  seats?: { keep: number; transient: number; total: number; max: number };
  keys?: number;
  regErrors?: string[];
}

function agoText(iso?: string | null): string {
  if (!iso) return "-";
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec}초 전`;
  if (sec < 3600) return `${Math.floor(sec / 60)}분 전`;
  return `${Math.floor(sec / 3600)}시간 전`;
}

export function LiveDot({ code, name }: { code?: string | null; name?: string | null }) {
  /*
   * 체결(`0B`) 하나만 본다. 호가·프로그램까지 보면 「무엇이 살아 있나」가 흐려지는데,
   * 사람이 묻는 건 늘 **「이 가격이 지금 값이냐」** 하나다.
   */
  const key = code ? `0B:${code}` : "";
  const rt = useRealtime(code ? [key] : [], 3000);

  const [open, setOpen] = useState(false);
  const [st, setSt] = useState<Status | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  /*
   * 상태 창구는 **열었을 때와, 종목이 없을 때**만 두드린다.
   * 종목이 없으면 `useRealtime` 이 아무것도 안 보므로(키가 비면 곧장 빈 상태로 앉는다)
   * 소켓이 멀쩡한데도 「조회」로 보인다 — 안전장치가 거짓말을 하면 없느니만 못하다.
   */
  const poll = useCallback(() => {
    void fetch("/api/realtime/status")
      .then((r) => r.json())
      .then((j: Status) => setSt(j))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (code && !open) return;
    poll();
    const t = setInterval(poll, open ? 4000 : 10_000);
    return () => clearInterval(t);
  }, [code, open, poll]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const socket = code ? rt.enabled && rt.healthy : Boolean(st?.enabled && st?.healthy);
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

  const seats = st?.seats;
  const full = seats ? seats.total >= seats.max : false;

  return (
    <div className="live-wrap" ref={boxRef}>
      <button
        type="button"
        className={`live-dot ${level}`}
        title={`${title} — 눌러서 자세히`}
        aria-label={title}
        onClick={() => setOpen((v) => !v)}
      >
        <i />
        <b>{label}</b>
      </button>

      {open && (
        <div className="live-pop">
          <div className="live-pop-h">
            <b>{label}</b>
            <span>{code ? (name ?? code) : "전체"}</span>
          </div>
          <dl className="live-pop-kv">
            <div>
              <dt>연결</dt>
              <dd>{!st ? "…" : st.enabled ? (st.healthy ? (st.state ?? "연결됨") : "끊김") : "꺼짐"}</dd>
            </div>
            <div>
              <dt>마지막 수신</dt>
              <dd>{agoText(st?.lastSeen)}</dd>
            </div>
            {code && (
              <div>
                <dt>이 종목</dt>
                <dd>{tick ? "들어오는 중" : "아직 안 물림"}</dd>
              </div>
            )}
            {seats && (
              <div>
                <dt>구독 자리</dt>
                <dd className={full ? "negative" : ""}>
                  {seats.total} / {seats.max}
                </dd>
              </div>
            )}
          </dl>
          <p className="live-pop-note">
            {level === "on"
              ? "지금 보는 값은 체결이 오는 대로 바뀝니다."
              : level === "wait"
                ? full
                  ? "구독 자리가 다 찼습니다 — 이 종목은 3초 조회로 채웁니다. 탭을 좀 닫으면 자리가 납니다."
                  : "방금 열어 아직 안 물렸습니다 — 잠시 뒤 초록으로 바뀝니다. 그때까지는 3초 조회입니다."
                : "실시간이 끊겨 3초 조회로 채웁니다. 값이 멈춰 보이면 새로고침하세요."}
          </p>
          {st?.regErrors && st.regErrors.length > 0 && (
            <p className="live-pop-err">등록 오류 {st.regErrors.length}건 — {st.regErrors[0]}</p>
          )}
        </div>
      )}
    </div>
  );
}
