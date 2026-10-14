import type { Request, Response, NextFunction } from "express";

/**
 * **길목마다 얼마나 걸리나** — 느린 것만이 아니라 **전부** 센다 (2026-10-14).
 *
 * 벤티지: "종목 상세 들어갈 때 로딩이 걸리는데 이유 좀 분석해 봐."
 *
 * 이걸 쫓다가 **헛다리를 세 번** 짚었다. 까닭은 매번 같았다 — 숫자가 없어서
 * 추측으로 메웠다는 것이다:
 *
 *   ① 일봉 캐시가 버려졌다 다시 읽히나 → 아니었다(복구 0회)
 *   ② 정적 파일이 과부하 관문에 줄 서나 → 아니었다(`/api/` 아니면 통과)
 *   ③ 브라우저의 여섯 개 동시 제한인가 → **벤티지의 경로엔 그 제한이 없다**
 *      (`vntgts.com` 은 Cloudflare 라 HTTP/2 다. 내가 잰 건 로컬 HTTP/1.1 이었다)
 *
 * 기존 「무거운 요청」 기록은 **4초를 넘긴 것만** 남긴다. 그런데 종목상세를 여는 길에는
 * 4초짜리가 하나도 없다 — 1~3초가 스무 개다. 그래서 로그가 통째로 비어 있었고,
 * 나는 **내 노트북의 로컬 측정**으로 메웠다. 그 값이 벤티지의 화면과 달랐던 것이다.
 *
 * 전부 세면 그 자리가 메워진다. 느린 하나가 아니라 **합이 큰 것**이 보이고, 그건
 * 「어디를 고쳐야 체감이 바뀌나」에 바로 답한다.
 *
 * ## 값은 싸게 둔다
 *
 * 길목마다 숫자 네 개(건수·합·최대·느린건수)뿐이다. 샘플을 들고 있으면 메모리가 늘고,
 * 이 서버는 메모리로 죽어 본 적이 있다(10/07). 중앙값 대신 **평균**으로 만족한다 —
 * 「어느 길목이 비싼가」를 가리는 데는 평균이면 충분하고, 꼬리는 최대가 말해 준다.
 *
 * ## ⚠️ 길목 이름은 묶는다
 *
 * `/api/market/info/005930` 을 그대로 키로 쓰면 종목 수만큼 칸이 생긴다. 여섯 자리
 * 숫자(와 `_AL`)는 `{code}` 로 접는다 — 보고 싶은 것은 「info 가 비싼가」지
 * 「삼성전자의 info 가 비싼가」가 아니다.
 */

interface Stat {
  n: number;
  sum: number;
  max: number;
  /** 1초 넘긴 건수 — 평균이 낮아도 가끔 튀는 길목을 가린다 */
  slow: number;
}

const stats = new Map<string, Stat>();
let since = Date.now();

/** 종목코드·날짜처럼 끝없이 갈라지는 조각을 접는다 */
function norm(path: string): string {
  return path
    .replace(/\/\d{6}(_AL)?(?=\/|$)/g, "/{code}")
    .replace(/\/\d{8}(?=\/|$)/g, "/{date}")
    .replace(/\/[0-9a-f]{16,}(?=\/|$)/gi, "/{id}");
}

export function routeStats(req: Request, res: Response, next: NextFunction): void {
  if (!req.path.startsWith("/api/")) {
    next();
    return;
  }
  const t0 = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - t0;
    const key = `${req.method} ${norm(req.path)}`;
    let s = stats.get(key);
    if (!s) {
      /* 칸이 끝없이 늘지 않게 — 접고도 400 개를 넘으면 그날은 더 안 받는다 */
      if (stats.size >= 400) return;
      s = { n: 0, sum: 0, max: 0, slow: 0 };
      stats.set(key, s);
    }
    s.n += 1;
    s.sum += ms;
    if (ms > s.max) s.max = ms;
    if (ms >= 1000) s.slow += 1;
  });
  next();
}

/** 합이 큰 순서 — 「어디를 고치면 체감이 바뀌나」의 답이 여기 있다 */
export function routeStatsTop(limit = 15): {
  잰시각부터: string;
  길목: { 길: string; 건수: number; 평균ms: number; 최대ms: number; 느린건수: number; 합초: number }[];
} {
  const rows = [...stats.entries()]
    .map(([k, s]) => ({
      길: k,
      건수: s.n,
      평균ms: Math.round(s.sum / s.n),
      최대ms: s.max,
      느린건수: s.slow,
      합초: Math.round(s.sum / 100) / 10,
    }))
    .sort((a, b) => b.합초 - a.합초)
    .slice(0, limit);
  return { 잰시각부터: new Date(since).toISOString(), 길목: rows };
}

/** 하루가 바뀌면 비운다 — 어제 것이 섞이면 「지금 무엇이 비싼가」가 안 보인다 */
export function resetRouteStats(): void {
  stats.clear();
  since = Date.now();
}
