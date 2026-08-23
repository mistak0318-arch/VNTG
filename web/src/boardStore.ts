/**
 * 보드 저장소 — **설정은 서버, 지금 상태는 창.**
 *
 * ## 무엇이 문제였나 (2026-08-22)
 *
 * 보드는 **창을 여러 개 띄우는 화면**이다. 모니터 세 대에 K1·K2·K3 를 따로 띄우려고
 * 만들었다. 그런데 상태를 전부 `localStorage` 에 넣고 있었고, **localStorage 는 창끼리
 * 공유된다.** 창 A 가 K1 을 불러오면 그 배치가 저장되고, 창 B 가 K2 를 불러오면 그걸
 * 덮어쓴다. 서로 리셋시키고 있었다 — **만든 기능이 스스로를 망가뜨리고 있었다.**
 *
 * ## 가르는 기준
 *
 *   **설정** = 「K1 은 무슨 칸들로 이루어졌나」 → **서버**. 기기·창이 달라도 같아야 한다.
 *   **지금 상태** = 「이 창이 지금 뭘 띄우고 있나」 → **창(sessionStorage)**. 달라야 한다.
 *
 * 둘을 한 곳에 두면 반드시 서로 덮어쓴다. 이건 취향이 아니라 구조다.
 *
 * ## 읽기만 localStorage 를 본다
 *
 * 새 창은 sessionStorage 가 비어 있다. 그때 예전 localStorage 값을 **읽어서** 이어받되,
 * **쓰기는 sessionStorage 로만** 한다. 그래야 쓰던 배치를 잃지 않으면서 창끼리 안 싸운다.
 */

export const winStore = {
  get(key: string): string | null {
    try {
      const mine = sessionStorage.getItem(key);
      if (mine !== null) return mine;
      // 이 창에 아직 없으면 예전 값을 이어받는다 (읽기만)
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      sessionStorage.setItem(key, value);
    } catch {
      /* 못 적어도 이번 화면에서는 그대로 쓴다 */
    }
  },
  remove(key: string): void {
    try {
      sessionStorage.removeItem(key);
      // 예전 값이 남아 있으면 되살아나므로 같이 지운다
      localStorage.removeItem(key);
    } catch {
      /* 무시 */
    }
  },
};
