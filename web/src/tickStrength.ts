/**
 * **지금 체결강도** — `/api/market/ticks/:code` 의 `strength` 하나만 (2026-09-22).
 *
 * 차트 띠가 오늘 봉을 짚었을 때 「체결강도(지금)」을 붙이려고 뺐다(벤티지: "체결강도랑").
 * 같은 주소를 종목 상세 요약줄(PriceHeader)도 10초마다 부르므로, 여기서 **10초 캐시 + 진행 중
 * 합치기**를 해 둔다 — 띠는 십자선이 움직일 때마다 묻는데 그때마다 나가면 안 된다.
 *
 * 체결강도는 **봉마다 있는 값이 아니다.** 지금 이 순간의 값 하나뿐이라, 지난 봉에 붙이면
 * 거짓말이 된다. 부르는 쪽이 「마지막 봉일 때만」 쓴다.
 */

const TTL_MS = 10_000;
const cache = new Map<string, { at: number; v: number | null }>();
const inflight = new Map<string, Promise<number | null>>();

export function getTickStrength(code: string): Promise<number | null> {
  const hit = cache.get(code);
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.v);
  const going = inflight.get(code);
  if (going) return going;
  const p = fetch(`/api/market/ticks/${encodeURIComponent(code)}`)
    .then((r) => r.json() as Promise<{ strength?: number | null }>)
    .then((j) => {
      const v = typeof j.strength === "number" && Number.isFinite(j.strength) ? j.strength : null;
      cache.set(code, { at: Date.now(), v });
      return v;
    })
    .catch(() => (hit ? hit.v : null))
    .finally(() => inflight.delete(code));
  inflight.set(code, p);
  return p;
}

/** 캐시에 있는 값만 — 그리는 쪽이 동기로 먼저 쓰고, 없으면 `getTickStrength` 를 걸어 둔다 */
export function peekTickStrength(code: string): number | null | undefined {
  const hit = cache.get(code);
  return hit && Date.now() - hit.at < TTL_MS ? hit.v : undefined;
}
