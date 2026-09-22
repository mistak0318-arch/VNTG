import { useEffect, useRef, useState } from "react";

/**
 * **왜 안 나오는지 말해 준다** (2026-09-22 — 벤티지: "이거 바로 안나오면 토스트 알림 같은걸로
 * 왜 안나오는지 로딩 걸린이유 좀 알려줄수있어?").
 *
 * 선물 시트가 「불러오는 중…」으로 멎어 있었다. 서버를 찔러 보니 멀쩡했는데(일봉 89건 82ms),
 * **화면은 그걸 말할 방법이 없었다** — 기다리는 중인지, 실패했는지, 실패했다면 왜인지가
 * 죄다 같은 글자 하나로 뭉뚱그려져 있었다. 실패해도 `catch(() => setX([]))` 로 사유가 버려졌다.
 *
 * 두 갈래로 알린다:
 *   · **그 자리에** — 「불러오는 중… 9초째 · 서버가 아직 답이 없습니다」. 눈이 이미 거기 있다.
 *   · **토스트로** — 느려지거나(문턱) 실패한 순간 한 번. 다른 데를 보고 있어도 알게.
 *
 * 토스트는 **한 번만** 띄운다. 30초 멎어 있다고 다섯 번 뜨면 그게 더 방해다.
 */

/** 화면이 직접 띄우는 토스트 — `NotifyToasts` 가 이 사건을 듣는다 */
export interface LocalToast {
  title: string;
  body?: string;
  level?: "info" | "warn";
}

export const LOCAL_TOAST_EVENT = "vntg:toast";

/**
 * 토스트 하나를 띄운다.
 *
 * 서버 알림(`/api/notify`)과 **같은 자리에 뜨지만 다른 것**이다 — 이건 알림함에 안 쌓인다.
 * 화면이 지금 겪고 있는 일(느림·실패)을 말할 뿐이라 나중에 다시 볼 값이 아니다.
 */
export function showToast(t: LocalToast): void {
  window.dispatchEvent(new CustomEvent<LocalToast>(LOCAL_TOAST_EVENT, { detail: t }));
}

/** 이보다 오래 걸리면 「느리다」고 본다 */
const SLOW_MS = 6_000;

/**
 * 불러오는 동안의 사정을 한 줄로.
 *
 * @param label  사람이 읽을 이름 — 「선물 차트」처럼. 토스트 제목에 쓴다.
 * @param loading 아직 기다리는 중인가
 * @param error  실패했으면 그 사유(없으면 null)
 * @returns 화면에 덧붙일 한 줄(기다린 지 얼마 안 됐으면 null)
 */
export function useLoadWatch(label: string, loading: boolean, error?: string | null): string | null {
  const [note, setNote] = useState<string | null>(null);
  const startedAt = useRef<number>(0);
  /** 이번 기다림에서 토스트를 이미 띄웠나 */
  const told = useRef(false);

  useEffect(() => {
    if (error) {
      setNote(null);
      if (!told.current) {
        told.current = true;
        showToast({ title: `${label} — 못 받았습니다`, body: error, level: "warn" });
      }
      return;
    }
    if (!loading) {
      /* 끝났으면 다음 기다림을 위해 초기화한다 — 새로고침할 때마다 다시 알려야 한다 */
      startedAt.current = 0;
      told.current = false;
      setNote(null);
      return;
    }
    if (startedAt.current === 0) startedAt.current = Date.now();
    /*
     * 1초마다 경과를 다시 그린다. **문턱을 넘긴 뒤에만** 글자가 생기므로, 잘 도는 화면에서는
     * 아무것도 안 보이고 초당 렌더도 안 일어난다(대부분의 조회는 1초 안에 끝난다).
     */
    const tick = () => {
      const sec = Math.round((Date.now() - startedAt.current) / 1000);
      if (sec * 1000 < SLOW_MS) return;
      setNote(`${sec}초째 · 서버가 아직 답이 없습니다`);
      if (!told.current) {
        told.current = true;
        showToast({
          title: `${label} — 느립니다`,
          body: `${sec}초째 기다리는 중입니다. 서버가 밀렸거나 자료 출처가 응답하지 않는 것입니다.`,
          level: "info",
        });
      }
    };
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
  }, [label, loading, error]);

  return note;
}
