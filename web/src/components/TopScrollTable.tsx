import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * 옆으로 긴 표 **위에** 가로 스크롤 바 하나.
 *
 * 벤티지(2026-09-08): "표가 너무 길어서 기타법인 보려면 옆으로 밀어야 되는데 PC에서는
 * 마우스로 하기가 쉽지가 않네" — 표의 스크롤 바는 표 **바닥**에만 붙어서, 열두 줄짜리
 * 표는 바닥까지 내려가야 잡을 수 있었다. 위에 같은 폭의 바를 하나 더 두고 둘을 묶는다.
 *
 * 표가 화면에 다 들어오면 바를 감춘다. 폰은 손가락으로 밀면 되니 바가 애초에 안 보인다
 * (overflow 스크롤 바 자체가 안 그려진다).
 */
export function TopScrollTable({ className, children }: { className?: string; children: ReactNode }) {
  const top = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0); // 표 실제 폭 — 0 이면 바가 필요 없다
  const syncing = useRef(false); // 한쪽 scroll 이 다른 쪽을 움직이면 되돌아오는 이벤트를 끊는다

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => setWidth(el.scrollWidth > el.clientWidth + 1 ? el.scrollWidth : 0);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const table = el.firstElementChild;
    if (table) ro.observe(table);
    return () => ro.disconnect();
  }, []);

  const follow = (from: HTMLDivElement | null, to: HTMLDivElement | null) => {
    if (!from || !to || syncing.current) return;
    syncing.current = true;
    to.scrollLeft = from.scrollLeft;
    requestAnimationFrame(() => (syncing.current = false));
  };

  return (
    <>
      {width > 0 && (
        <div className="tscroll" ref={top} onScroll={() => follow(top.current, wrap.current)}>
          <div style={{ width }} />
        </div>
      )}
      <div
        className={`data-table-wrap ${className ?? ""}`}
        ref={wrap}
        onScroll={() => follow(wrap.current, top.current)}
      >
        {children}
      </div>
    </>
  );
}
