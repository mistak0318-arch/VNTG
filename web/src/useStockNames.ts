import { useEffect, useState } from "react";
import { api } from "./api";

/**
 * **코드를 종목명으로** — 화면 여러 곳이 같이 쓴다 (2026-09-09).
 *
 * 벤티지: "종목코드가 보이네. 종목명이 보여야지. 코드로는 무슨 종목인지 모르잖어"
 *
 * 화제·버즈·키워드 카드가 관련 종목을 **코드로** 찍고 있었다 — 「227950」 으로는 아무것도
 * 알 수 없다. 화제 카드는 서버가 이름을 붙여 주게 고쳤는데, 나머지 둘은 서버 응답이 달라서
 * 같은 손질을 하려면 서버를 세 군데 고쳐야 했다. 그래서 **화면 쪽에 하나** 둔다.
 *
 * ## 조회를 어떻게 아끼나
 *
 *   · **한 번 찾은 이름은 모듈에 남긴다** — 카드를 여닫아도 다시 안 묻는다
 *   · 여러 카드가 같은 순간에 물어도 **한 번만** 나간다(같은 약속을 나눠 쓴다)
 *   · 못 찾은 코드도 기억한다 — 없는 코드를 매번 다시 묻지 않게
 *
 * 못 찾으면 **코드를 그대로 보여 준다.** 이름이 없다고 칩을 지우면 눌러 갈 길이 사라진다.
 */
const cache = new Map<string, string>();
const missed = new Set<string>();
const inFlight = new Map<string, Promise<void>>();

async function fetchOne(code: string): Promise<void> {
  const already = inFlight.get(code);
  if (already) return already;
  const p = api
    .searchStocks(code)
    .then((r) => {
      const hit = r.results.find((x) => x.code.replace(/[^0-9A-Za-z]/g, "").slice(0, 6) === code);
      if (hit?.name) cache.set(code, hit.name);
      else missed.add(code);
    })
    .catch(() => {
      /* 한 번 실패했다고 영영 안 묻지는 않는다 — 다음에 다시 시도한다 */
    })
    .finally(() => {
      inFlight.delete(code);
    });
  inFlight.set(code, p);
  return p;
}

export function useStockNames(codes: string[]): Record<string, string> {
  const [, bump] = useState(0);
  const key = codes.join(",");

  useEffect(() => {
    const need = codes
      .map((c) => String(c).replace(/[^0-9A-Za-z]/g, "").slice(0, 6))
      .filter((c) => c.length === 6 && !cache.has(c) && !missed.has(c));
    if (need.length === 0) return;
    let alive = true;
    void Promise.all(need.map(fetchOne)).then(() => {
      if (alive) bump((v) => v + 1);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const out: Record<string, string> = {};
  for (const c of codes) {
    const k = String(c).replace(/[^0-9A-Za-z]/g, "").slice(0, 6);
    const nm = cache.get(k);
    if (nm) out[c] = nm;
  }
  return out;
}
