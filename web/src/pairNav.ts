/**
 * **다른 화면에서 「한미 짝」의 테마 하나를 연다** (2026-09-15 — 벤티지: 시황 「어젯밤 미국 → 국내 테마」 칩을
 * "누르면 아무 변화도 없는데?").
 *
 * 한미 짝은 테마/업종 MAP 의 서브탭이고, 열린 테마를 주소(해시)에 안 싣는다 — 시트가 페이지 안 상태다.
 * 그래서 가려는 테마를 잠깐 맡겨 두고(`sessionStorage`) 탭을 옮긴다. MAP 이 이미 떠 있으면 이벤트로,
 * 처음 뜨면 마운트할 때 집어 간다.
 */
const KEY = "vntg.pair.open";
export const PAIR_OPEN_EVENT = "vntg:pair-open";

export interface PendingPair {
  key: string;
  name: string;
}

export function openThemePair(no: number, name: string): void {
  const v: PendingPair = { key: `kr:${no}`, name };
  try {
    sessionStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* 저장이 막혀도 이벤트로는 간다 */
  }
  window.dispatchEvent(new CustomEvent(PAIR_OPEN_EVENT));
  window.location.hash = "#/map";
}

/** 맡겨 둔 테마를 꺼낸다 — 한 번 꺼내면 지운다 */
export function takePendingPair(): PendingPair | null {
  try {
    const v = sessionStorage.getItem(KEY);
    if (!v) return null;
    sessionStorage.removeItem(KEY);
    return JSON.parse(v) as PendingPair;
  } catch {
    return null;
  }
}
