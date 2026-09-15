import { useEffect, useRef } from "react";

/**
 * **내 태그가 바뀌었다는 알림** (2026-09-15 — 벤티지: "내 태그 담기 누르고 테마 MAP 가서 내 태그랑 마이페이지
 * 내 태그 가니까 반영이 안 되어 있네?").
 *
 * 서버는 매번 파일을 새로 읽으니 잘못이 없었다. 화면이 문제였다 — 탭은 떠 있는 채로 남아서(언마운트되지
 * 않는다) 「내 태그」 판과 MAP 의 내 태그가 **처음 한 번만** 받아 두고 다시 묻지 않았다. 다른 자리(구성종목
 * 시트 「＋ 내 태그」, 종목 상세 #태그)에서 바꾸면 그걸 알 길이 없었다.
 *
 * 바꾼 쪽이 `notifyMyTagsChanged()` 를 부르고, 보여 주는 쪽이 `useMyTagsChanged` 로 받아 다시 읽는다.
 */
const EVENT = "vntg:mytags-changed";

export function notifyMyTagsChanged(): void {
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function useMyTagsChanged(onChange: () => void): void {
  const ref = useRef(onChange);
  ref.current = onChange;
  useEffect(() => {
    const on = () => ref.current();
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
}
