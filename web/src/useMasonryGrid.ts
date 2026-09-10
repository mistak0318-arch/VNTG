import { useEffect, type RefObject } from "react";

/**
 * **격자를 벽돌 쌓기처럼** (2026-09-10 — 벤티지: "PC에서 볼 때 이 구조 너무 이상한 거 아니야?").
 *
 * 시황 대시보드는 3열 격자다. 한 줄에 스무 줄짜리 글로벌 카드와 여섯 줄짜리 카드가 나란히 서면 **줄 높이가
 * 긴 쪽에 맞춰져** 짧은 카드 밑이 통째로 비고, 다음 카드는 다음 줄로 밀려 혼자 남았다. CSS 격자는 줄 높이를
 * 한 값으로 맞추는 물건이라 그렇다.
 *
 * 그래서 줄을 **8px 짜리 잔줄**로 바꾸고, 카드마다 제 높이만큼 몇 줄을 걸칠지(`grid-row: span N`)를 재서
 * 준다. 자동 배치는 앞 카드 다음의 **첫 빈 칸**을 찾으므로 긴 카드 옆 빈자리에 다음 카드가 올라온다 —
 * 벽돌 쌓기가 된다. 카드 차례(`order`)는 그대로 먹는다. 높이는 내용이 오면 바뀌므로 ResizeObserver 로 따라간다.
 * 한 열(폰)에서는 잔줄이 뜻이 없어 끈다.
 */
/**
 * row 는 잔줄 높이, gap 은 카드 사이 세로 여백(카드의 margin-bottom 으로 준다 — 격자 row-gap 은 0).
 * 예전엔 row-gap 12 를 격자에 두고 (h+gap)/(row+gap) 로 셌는데 한 칸이 20px 이라 카드 밑에 최대 20px 이 남았다
 * (2026-09-10 실측 13~28px). 4px 잔줄 + margin 이면 오차가 4px 안이다.
 */
export function useMasonryGrid(ref: RefObject<HTMLElement | null>, minWidth = 700, row = 4, gap = 12): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const mq = window.matchMedia(`(min-width: ${minWidth}px)`);
    const apply = () => {
      const on = mq.matches;
      el.classList.toggle("masonry", on);
      for (const child of Array.from(el.children) as HTMLElement[]) {
        if (!on) {
          child.style.gridRowEnd = "";
          continue;
        }
        /* 안쪽 높이 — 자식 자체가 span 으로 늘어난 높이를 다시 재면 계속 커진다. 첫 자식(카드 본체)으로 잰다 */
        const box = child.getBoundingClientRect();
        const inner = child.firstElementChild ? (child.firstElementChild as HTMLElement).getBoundingClientRect() : null;
        const h = child.classList.contains("ov-card") ? child.scrollHeight : (inner ? inner.height : box.height);
        const span = Math.max(1, Math.ceil((h + gap) / row));
        child.style.gridRowEnd = `span ${span}`;
      }
    };
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(apply);
    };
    const ro = new ResizeObserver(schedule);
    const observeAll = () => {
      ro.disconnect();
      ro.observe(el);
      for (const child of Array.from(el.children)) {
        ro.observe(child);
        if (child.firstElementChild) ro.observe(child.firstElementChild);
      }
    };
    observeAll();
    const mo = new MutationObserver(() => {
      observeAll();
      schedule();
    });
    mo.observe(el, { childList: true, subtree: true });
    mq.addEventListener("change", schedule);
    schedule();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
      mq.removeEventListener("change", schedule);
      el.classList.remove("masonry");
      for (const child of Array.from(el.children) as HTMLElement[]) child.style.gridRowEnd = "";
    };
  }, [ref, minWidth, row, gap]);
}
