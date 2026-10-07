import type { NextFunction, Request, Response } from "express";

/**
 * **같은 조회가 겹치면 한 번만** — 창을 여럿 띄워 쓰는 사람을 위한 한 겹 (2026-10-08).
 *
 * 벤티지: 모니터 셋에 보드를 띄우고 **종목연동**으로 쓴다. 종목 하나를 누르면 세 화면이
 * **같은 종목의 같은 길**을 각자 부른다. 종목 화면 한 장이 길 열다섯을 여니 한 번에 마흔다섯이다.
 *
 * ## 왜 자리 수로는 못 고치나
 *
 * 실측(2026-10-08 07시)에서 거의 모든 길의 중앙 할당량이 **500~560MB 로 똑같았다.**
 * 그건 그 길들이 각자 그만큼 쓴다는 뜻이 아니라 **그 시간대에 서버 전체가 그만큼 쓰고
 * 있었다**는 뜻이다. 동시에 도는 것을 늘리면 한꺼번에 더 할당해 GC 가 더 멈추고,
 * 줄이면 대기가 길어진다. **일 자체를 줄여야 한다.**
 *
 * ## 단일 비행 — 묵은 값을 주지 않는다
 *
 * 같은 `GET` 이 **이미 돌고 있으면** 새로 시작하지 않고 그 결과를 같이 받는다.
 * 캐시가 아니다 — **끝난 것은 안 나눠 준다.** 그러니 혼자 불렀을 때와 **똑같은 값**이고,
 * 묵은 값을 줄 걱정이 없다. 세 보드가 같은 순간에 누르면 서버는 한 번만 일한다.
 *
 * 이 파일이 `hantooClient` 의 요청 합치기보다 **한 겹 위**인 것이 요점이다. 거기서는
 * 한투 호출만 합쳐지는데, 여기서는 키움·네이버·파일 읽기까지 **그 길이 하는 일 전부**가 합쳐진다.
 *
 * ## 안 합치는 것
 *
 *  · `GET` 이 아닌 것 — 주문·설정은 두 번 부르면 두 번 일어나야 한다.
 *  · 생사 확인(`/api/health`)·실시간(SSE) — 전자는 감시자 것이고 후자는 끝나지 않는다.
 *  · 응답이 `res.json` 이 아닌 길 — 받아 둘 방법이 없다. 기다리던 쪽은 제 힘으로 다시 간다.
 */

type Waiter = (v: { status: number; body: unknown } | null) => void;

const flying = new Map<string, Waiter[]>();

/** 지금 겹쳐서 아낀 건수 — 계기판이 적는다. 늘수록 창을 여럿 띄워 쓰는 보람이 있다 */
let saved = 0;
export function shareGetStats(): { 겹쳐서아낌: number; 지금도는것: number } {
  return { 겹쳐서아낌: saved, 지금도는것: flying.size };
}

function shareable(req: Request): boolean {
  if (req.method !== "GET") return false;
  const p = req.path;
  if (!p.startsWith("/api/")) return false;
  if (p === "/api/health" || p.startsWith("/api/health/")) return false;
  if (p.startsWith("/api/realtime/")) return false;
  /* 계기판 자신은 합치지 않는다 — 합친 수를 보려고 부르는 길이다 */
  if (p.startsWith("/api/sys/")) return false;
  return true;
}

export function shareGet(req: Request, res: Response, next: NextFunction): void {
  if (!shareable(req)) {
    next();
    return;
  }
  /* 열쇠는 **주소 전부**다 — 질의까지 같아야 같은 답이다 */
  const key = req.originalUrl;

  const queue = flying.get(key);
  if (queue) {
    /* 이미 누가 가고 있다 — 결과를 같이 받는다 */
    saved += 1;
    queue.push((v) => {
      if (!v) {
        /* 앞선 쪽이 json 으로 안 끝났다(또는 실패했다) — 제 힘으로 다시 간다 */
        next();
        return;
      }
      res.status(v.status).json(v.body);
    });
    return;
  }

  /* 내가 앞장선다 */
  const waiters: Waiter[] = [];
  flying.set(key, waiters);

  let answered = false;
  const tell = (v: { status: number; body: unknown } | null) => {
    if (answered) return;
    answered = true;
    flying.delete(key);
    for (const w of waiters) {
      try {
        w(v);
      } catch {
        /* 한 쪽이 터져도 나머지는 받아야 한다 */
      }
    }
  };

  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    tell({ status: res.statusCode, body });
    return json(body);
  };
  /*
   * json 없이 끝난 경우(파일·스트림·중간에 끊김)에도 **반드시 알려 줘야** 한다.
   * 안 그러면 기다리던 쪽이 영영 안 깨어나고, 열쇠도 지도에 남아 다음 요청까지 묶인다.
   */
  res.on("finish", () => tell(null));
  res.on("close", () => tell(null));

  next();
}
