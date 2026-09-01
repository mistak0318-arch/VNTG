import { useState } from "react";

/**
 * 접기 — **기기별로 기억한다.**
 *
 * 벤티지가 두 번 말한 자리다: "이것들 좀 접는 구조 좀 만들어주라 칸을 많이
 * 차지해"(2026-08-31, 신호등 분석) · "접기 옵션도 넣어줘 화면 차지가 꽤
 * 되네"(2026-09-01, 조건 검색).
 *
 * ## 왜 서버가 아니라 기기별인가
 *
 * 「이 카드를 접어 둘까」는 **그 자리의 사정**이다. 큰 모니터에서는 다 펴 두고
 * 노트북에서는 접어 두는 게 자연스럽다. 서버에 두면 한쪽에서 접은 것이
 * 다른 쪽에서도 접힌다.
 *
 * ## 접혀 있어도 한 줄은 보인다
 *
 * 이 훅을 쓰는 화면은 접힌 상태에서도 **제일 중요한 한 줄**을 머리에 남긴다 —
 * 「추적 15종목」·「조건 3개」처럼. 펴 볼지 판단할 근거가 없으면 접기가 그냥
 * 숨기기가 된다.
 *
 * ## 왜 뽑았나
 *
 * `ListTrackPage` 안에 있던 것이다. 조건 검색에서도 같은 게 필요해졌는데,
 * 복사하면 열쇠 접두사(`vntg.lt.`)까지 딸려 와 서로 다른 화면의 상태가
 * 섞인다. 접두사를 인자로 받게 열어 두고 공용으로 옮겼다.
 *
 * @param key 이 카드의 이름. 화면 안에서 겹치지 않으면 된다
 * @param initial 처음 열었을 때 펴져 있나
 * @param ns 열쇠 접두사 — 화면마다 다르게 준다(`lt`·`cond`…)
 */
export function useFold(key: string, initial = false, ns = "app") {
  const storeKey = `vntg.${ns}.${key}`;
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(storeKey);
      return v === null ? initial : v === "1";
    } catch {
      return initial;
    }
  });
  /** 값을 못 박는다 — 「전체 펼치기」가 이걸 쓴다 */
  const set = (v: boolean) => {
    setOpen(v);
    try {
      localStorage.setItem(storeKey, v ? "1" : "0");
    } catch {
      /* 못 적으면 다음에 원래대로일 뿐 — 접기가 안 되는 것보다 낫다 */
    }
  };
  const toggle = () => set(!open);
  return [open, toggle, set] as const;
}
