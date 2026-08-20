/**
 * 인증이 끊긴 것을 알아채고 알린다.
 *
 * ## 왜 필요한가
 *
 * 밖에서 접속할 때는 Cloudflare Access 가 앞을 지키는데, **세션은 여섯 시간이면 끝난다.**
 * 끝난 뒤에도 화면은 그대로 떠 있고, 그때부터 나가는 요청만 조용히 로그인 페이지로
 * 리다이렉트된다. 브라우저는 그걸 다른 출처로 보므로 CORS 로 막고, 우리 쪽에는
 * 그냥 「실패」로 온다.
 *
 * 화면마다 그 실패를 각자 삼키므로 결과는 **아무 말 없는 빈 칸**이다.
 * 실제로 보드에서 칸 절반이 비었는데, 앱이 고장 난 것처럼 보였지 인증이 끊겼다고는
 * 아무도 생각하지 못했다. **틀린 게 아니라 말을 안 한 것이 문제였다.**
 *
 * ## 어떻게 가려내나
 *
 * 리다이렉트를 따라가면 CORS 에서 막혀 `TypeError` 만 남고, 그건 **인터넷이 끊긴
 * 경우와 구분이 안 된다.** 그래서 실패했을 때 한 번 더, 이번엔 `redirect: "manual"`
 * 로 물어본다. 응답 형태가 `opaqueredirect` 면 서버가 다른 데로 보내려 한 것이고,
 * 우리 API 는 리다이렉트를 쓰지 않으므로 그건 **앞의 문지기**다.
 *
 * 집에서(로컬) 쓸 때는 Access 자체가 없어서 이 길로 올 일이 없다.
 */

let expired = false;
const listeners = new Set<(v: boolean) => void>();

export function onAuthExpired(fn: (v: boolean) => void): () => void {
  listeners.add(fn);
  fn(expired);
  return () => {
    listeners.delete(fn);
  };
}

function mark(v: boolean): void {
  if (expired === v) return;
  expired = v;
  for (const l of listeners) l(v);
}

/** 다시 들어온 뒤 배너를 내린다 */
export function clearAuthExpired(): void {
  mark(false);
}

/*
 * 확인은 **한 번에 하나만** 돈다.
 * 화면 열 곳이 동시에 실패하면 확인 요청도 열 개가 나가는데, 이미 막힌 문을
 * 열 번 두드리는 것일 뿐이다.
 */
let checking: Promise<void> | null = null;

export function noteFetchFailure(): void {
  if (expired || checking) return;
  checking = (async () => {
    try {
      const res = await fetch("/api/overview/status", { redirect: "manual" });
      // 다른 곳으로 보내려 했다 = 앞의 문지기가 막은 것
      if (res.type === "opaqueredirect" || res.status === 401 || res.status === 403) mark(true);
    } catch {
      /* 이것마저 실패하면 인증인지 회선인지 알 수 없다 — 함부로 단정하지 않는다 */
    } finally {
      checking = null;
    }
  })();
}
