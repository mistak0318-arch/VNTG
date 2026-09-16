import { VI_HOLD_SEC, type ViNow, type ViToday } from "../useViNow";

/**
 * **VI 딱지** — 「지금 이 종목 단일가다」 (2026-09-14).
 *
 * ## 외부는 어떻게 하나
 *
 * 증권사 HTS 는 VI 를 **따로 찾아 들어가는 화면**(키움 0193 「변동성완화장치 발동종목현황」)으로
 * 두고, 현재가 창에는 정적/동적 구분과 발동·해제 시각을 적는다. 우리가 이미 그 화면
 * (`ViPanel`)은 갖고 있었는데, **보고 있던 표에는 아무 표시가 없었다** — 시세분석에서
 * 급등주를 보다가 「왜 체결이 안 되지」 할 때 답이 화면에 없었다.
 *
 * ## 우리가 더 하는 것 — 남은 시간
 *
 * VI 단일가는 **2분**이다. HTS 는 발동 시각만 적지만, 사람이 정말 알고 싶은 것은
 * 「언제 풀리나」다. 발동 시각과 지금 시각의 차로 남은 초를 적는다.
 * 3분이 지나도 해제 줄이 안 오면 훅이 스스로 지운다(`useViNow` 주석).
 *
 * ## 색은 방향이다
 *
 * 급등해서 걸린 것(상방)과 급락해서 걸린 것(하방)은 전혀 다른 사건이다. 우리 표 전체가
 * 쓰는 그 색(빨강 상승·파랑 하락)을 그대로 쓴다. 색만으로 말하지 않게 ▲▼ 도 같이 둔다.
 */
export function ViMark({ vi, compact = false }: { vi: ViNow; compact?: boolean }) {
  const left = Math.max(0, VI_HOLD_SEC - vi.agoSec);
  const mmss = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  const arrow = vi.dir === "up" ? "▲" : vi.dir === "down" ? "▼" : "";
  const cls = vi.dir === "up" ? "up" : vi.dir === "down" ? "down" : "";
  const title =
    `VI 발동 중 — ${vi.apply || "구분 모름"}` +
    (vi.gap !== null ? ` · ${vi.dir === "up" ? "급등" : "급락"} ${vi.gap > 0 ? "+" : ""}${vi.gap}%` : "") +
    (vi.price > 0 ? ` · 발동가 ${vi.price.toLocaleString("ko-KR")}` : "") +
    (vi.base > 0 ? ` (기준 ${vi.base.toLocaleString("ko-KR")})` : "") +
    ` · ${hhmm(vi.firedAt)} 발동` +
    (left > 0 ? ` · 약 ${mmss} 뒤 해제(단일가 2분)` : " · 곧 해제") +
    "\n\nVI 중에는 2분간 단일가로만 체결됩니다 — 지정가를 걸어도 그 시간에는 안 나갑니다.";
  return (
    <span className={`vi-mark ${cls}${compact ? " compact" : ""}`} title={title}>
      VI{arrow}
      {!compact && left > 0 && <i>{mmss}</i>}
    </span>
  );
}

/**
 * **오늘 VI 걸렸던** 표 — 풀린 뒤에도 하루 남는다 (2026-09-17). 걸려 있는 동안은 위 `ViMark` 가 대신 뜬다.
 * 방향은 시가대비 등락(ka10054)으로 — 급등에 걸린 건지 급락에 걸린 건지.
 */
export function ViTodayMark({ v }: { v: ViToday }) {
  const dir = v.openChangeRate > 0 ? "up" : v.openChangeRate < 0 ? "down" : "";
  const arrow = dir === "up" ? "▲" : dir === "down" ? "▼" : "";
  const hm = v.releaseTime.length >= 4 ? `${v.releaseTime.slice(0, 2)}:${v.releaseTime.slice(2, 4)}` : "";
  const title =
    `오늘 VI 발동 ${v.count}회 — 시가대비 ${v.openChangeRate > 0 ? "+" : ""}${v.openChangeRate.toFixed(2)}%` +
    (v.motionPrice > 0 ? ` · 발동가 ${v.motionPrice.toLocaleString("ko-KR")}` : "") +
    (hm ? ` · 마지막 해제 ${hm}` : "") +
    "\n\n지금은 풀려 있습니다. 급하게 움직인 종목이라 추격은 조심.";
  return (
    <span className={`vi-mark today ${dir}`} title={title}>
      VI{arrow}
      {v.count > 1 && <i>×{v.count}</i>}
    </span>
  );
}

function hhmm(t: string): string {
  return t.length >= 6 ? `${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}` : t;
}
