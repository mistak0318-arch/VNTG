import { useEffect, useState, type ReactNode } from "react";

/**
 * **뼈대 먼저, 한 번에 펼치기** — 화면 공용 (2026-09-23, 벤티지: "다른 메뉴들도 다다다닥 뜨는 부분들이 있는데
 * 얘네들도 개선가능해? 지금 고친 방향 괜찮아서").
 *
 * 패널 여럿이 각자 조회해 도착 순서대로 툭툭 나타나며 아래를 밀어내는 화면(시트·시황·브리핑·아침·달력…)에
 * 같은 처방: 자식은 **곧바로 마운트돼 조회를 시작**하되(`.sd-wait` 는 높이 0·투명), 문이 열릴 때까지 회색
 * 뼈대를 보이고 열리면 한 번에 페이드로 편다(`.sd-ready`). 그 뒤에 오는 것은 `.sd-blk > *` 페이드가 받는다.
 *
 *   · `ready` 를 주면 그 값이 true 되는 순간 연다(시트: 시세 머리가 왔을 때)
 *   · 안 주면 `wait` ms 뒤에 연다 — 서버 캐시라 대부분 그 안에 오고, 늦는 건 페이드로 따라온다
 *   · 한 번 열리면 다시 안 닫는다(자식이 다시 조회해도 뼈대로 돌아가지 않는다)
 *   · 종목이 바뀌는 화면은 `resetKey` 로 다시 닫는다
 *
 * 뼈대 모양은 `bars` (높이 px 목록) — 그 화면의 첫 화면과 얼추 비슷하게.
 */
export function Unveil({
  ready,
  wait = 700,
  bars = [56, 180, 40, 120],
  resetKey,
  className = "",
  children,
}: {
  ready?: boolean;
  wait?: number;
  bars?: number[];
  resetKey?: string | number;
  className?: string;
  children: ReactNode;
}) {
  const [timed, setTimed] = useState(false);
  useEffect(() => {
    setTimed(false);
    const t = setTimeout(() => setTimed(true), wait);
    return () => clearTimeout(t);
  }, [wait, resetKey]);
  const [opened, setOpened] = useState(false);
  const open = ready === undefined ? timed : ready;
  useEffect(() => {
    setOpened(false);
  }, [resetKey]);
  useEffect(() => {
    if (open) setOpened(true);
  }, [open]);
  const show = opened || open;
  return (
    <>
      {!show && (
        <div className="sd-skel" aria-hidden="true">
          {bars.map((h, i) => (
            <i key={i} style={{ height: h }} />
          ))}
        </div>
      )}
      <div className={`sd-body ${show ? "sd-ready" : "sd-wait"} ${className}`.trim()}>{children}</div>
    </>
  );
}
