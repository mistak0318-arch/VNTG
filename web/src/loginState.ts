/**
 * 「로그인이 필요하다」를 앱 전체가 함께 아는 자리.
 *
 * ## 왜 따로 두나 — authGuard 와 뭐가 다른가
 *
 * [authGuard](./authGuard.ts) 는 **앞에 선 Cloudflare Access** 의 세션이 끝난 것을
 * 알아채는 곳이다. 그건 우리가 어떻게 해 줄 수 없어서 배너로 「새로고침하세요」라고
 * 말하는 게 전부다.
 *
 * 이쪽은 **우리 서버의 로그인**이다. 우리가 만든 문이라 우리가 열 수 있다 —
 * 배너가 아니라 로그인 칸을 띄운다. 둘은 원인도 대응도 달라서 섞으면 안 된다.
 *
 * ## 왜 전역인가
 *
 * 401 은 **아무 화면에서나** 온다(세션이 도중에 끝나면 열려 있던 화면이 그때
 * 데이터를 부르다 받는다). 그 화면이 각자 로그인 칸을 그리면 여러 개가 겹친다.
 * 그래서 신호만 전역으로 올리고, 칸은 제일 바깥의 LoginGate 하나가 그린다.
 */

let needLogin = false;
const listeners = new Set<(v: boolean) => void>();

export function onNeedLogin(fn: (v: boolean) => void): () => void {
  listeners.add(fn);
  fn(needLogin);
  return () => {
    listeners.delete(fn);
  };
}

export function markNeedLogin(): void {
  if (needLogin) return;
  needLogin = true;
  for (const l of listeners) l(true);
}

export function clearNeedLogin(): void {
  if (!needLogin) return;
  needLogin = false;
  for (const l of listeners) l(false);
}
