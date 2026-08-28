import { useEffect, useRef } from "react";

/**
 * 뒤로가기로 시트를 닫는다 (2026-08-28 요청).
 *
 * 폰에서 차트나 상세 시트를 열고 **뒤로가기를 누르면 시트가 아니라 페이지가**
 * 넘어갔다 — 보던 화면을 잃는다. 시트를 여는 것도 사람에겐 「들어간 것」이라
 * 뒤로가기가 「나오는 것」이어야 맞다.
 *
 * ## 어떻게
 *
 * 시트가 열릴 때 히스토리에 **한 칸을 쌓는다**(`pushState`). 뒤로가기가 오면
 * 그 칸이 빠지고 `popstate` 가 오므로 그때 닫는다. 해시는 안 건드린다 —
 * 이 앱의 라우팅이 해시라, 해시를 바꾸면 탭이 같이 움직인다.
 *
 * ✕ 나 바깥을 눌러 닫으면 쌓아 둔 칸을 우리가 뺀다(`history.back()`).
 * 안 그러면 그 칸이 남아 다음 뒤로가기가 아무 일도 안 하는 「먹통 한 번」이 된다.
 *
 * ## ⚠️ 두 가지 함정 (둘 다 실제로 밟았다)
 *
 * **① 우리가 부른 back 을 사용자의 뒤로가기로 착각한다.** 억제 플래그를 인스턴스에
 * 두면 못 막는다 — 정리 단계의 back 이 부르는 popstate 를 **새로 붙은 인스턴스**가
 * 잡아 시트를 즉시 닫았다. 그래서 억제는 **모듈 단위**다.
 *
 * **② `history.back()` 은 비동기다.** 정리에서 곧바로 부르면, StrictMode(개발)의
 * 마운트→해제→마운트 사이에 순서가 뒤집혀 **두 번째로 쌓은 칸이 대신 빠진다.**
 * 실측에서 시트를 여는데 history.length 가 오히려 줄었고(49→48), 그 상태로 뒤로가기를
 * 누르니 시트가 아니라 페이지가 넘어갔다. 그래서 정리의 back 을 **한 틱 미루고**,
 * 그 사이에 다시 마운트되면 **취소하고 그 칸을 물려받는다**(다시 push 하지 않는다).
 * 운영에서도 시트를 빠르게 여닫으면 같은 경합이 나므로 StrictMode 만의 이야기가 아니다.
 */

/** 우리가 부른 back 이 만든 popstate 를 몇 번 무시할지 — 모든 인스턴스가 함께 본다 */
let suppress = 0;
/** 아직 실행 안 된 「칸 빼기」 — 곧바로 다시 마운트되면 취소하고 물려받는다 */
let pendingBack: ReturnType<typeof setTimeout> | null = null;

export function useSheetBack(open: boolean, close: () => void): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  /** 뒤로가기로 이미 닫혔나 — 그러면 정리 단계에서 칸을 뺄 필요가 없다 */
  const poppedRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    poppedRef.current = false;

    if (pendingBack !== null) {
      /* 방금 해제된 인스턴스의 칸이 아직 살아 있다 — 그걸 그대로 쓴다 */
      clearTimeout(pendingBack);
      pendingBack = null;
    } else {
      window.history.pushState({ vntgSheet: true }, "");
    }

    const onPop = () => {
      if (suppress > 0) {
        suppress -= 1; // 우리가 부른 back — 사용자의 뒤로가기가 아니다
        return;
      }
      poppedRef.current = true;
      closeRef.current();
    };
    window.addEventListener("popstate", onPop);

    return () => {
      window.removeEventListener("popstate", onPop);
      /* 뒤로가기로 닫혔으면 그 칸은 이미 빠졌다 */
      if (poppedRef.current) return;
      if (!window.history.state?.vntgSheet) return;
      pendingBack = setTimeout(() => {
        pendingBack = null;
        suppress += 1;
        window.history.back();
      }, 0);
    };
  }, [open]);
}
