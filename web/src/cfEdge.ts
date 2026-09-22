import { useEffect, useState } from "react";
import { useTabActive } from "./tabActive";

/**
 * **지금 어느 Cloudflare 엣지에 붙어 있나** (2026-09-23 — 벤티지: "설정에 저 부분에다가
 * 클라우드플레어 어디 서버에 붙어있는지 써줄 수 있나? 실시간으로?").
 *
 * 2026-09-21~22 에 Cloudflare 홍콩 엣지가 말썽을 부려 앱이 통째로 느려졌다. 그때 「느리다」만
 * 가지고 서버·터널·키움을 한 시간 넘게 뒤졌는데, **어디에 붙었는지 한 줄만 보였어도** 바로
 * 갈렸을 일이었다(실측: 홍콩 44ms·도쿄 40ms 대 서울 5ms). 그래서 설정 › 정보에 붙인다.
 *
 * ## 어떻게 아나
 *
 * `/cdn-cgi/trace` 는 **Cloudflare 엣지가 직접 답한다** — 터널도 서버도 안 탄다. 그 응답의
 * `colo` 가 공항 코드다(ICN 인천, NRT 나리타…). 왕복 시간도 같이 재면 「가깝나」까지 보인다.
 *
 * ## Cloudflare 를 안 거칠 때
 *
 * tailnet 우회로(`http://100.88.182.35:4000`)로 들어오면 그런 주소가 없다 — 우리 서버의 SPA
 * 되돌림이 `index.html` 을 준다. 그때 **「모른다」가 아니라 「안 거친다」**고 적어야 맞다.
 * 그 둘은 뜻이 완전히 다르다.
 */

export interface EdgeInfo {
  /** 공항 코드 — ICN·NRT·HKG… */
  colo: string;
  /** 사람이 읽는 이름 */
  place: string;
  /** 엣지까지 왕복(ms) */
  ms: number;
  /** 서울(ICN)인가 — 한국에서 여기가 정상이다 */
  home: boolean;
}

/**
 * 공항 코드 → 도시. **우리가 실제로 본 것 + 한국에서 흔히 걸리는 곳**만 적는다.
 * 목록에 없으면 코드를 그대로 보여 준다 — 억지로 이름을 지어내는 것보다 낫다.
 */
const PLACE: Record<string, string> = {
  ICN: "서울",
  NRT: "도쿄",
  KIX: "오사카",
  HKG: "홍콩",
  SIN: "싱가포르",
  TPE: "타이베이",
  PVG: "상하이",
  LAX: "로스앤젤레스",
  SJC: "산호세",
  SEA: "시애틀",
  FRA: "프랑크푸르트",
  AMS: "암스테르담",
  LHR: "런던",
};

/** `colo=ICN` 같은 줄들을 객체로 */
function parseTrace(text: string): Record<string, string> {
  return Object.fromEntries(
    text
      .trim()
      .split("\n")
      .map((l) => {
        const i = l.indexOf("=");
        return i < 0 ? ["", ""] : [l.slice(0, i), l.slice(i + 1)];
      }),
  );
}

/** 아직 재는 중 / 붙은 엣지 / Cloudflare 를 안 거침 */
export type EdgeState = { kind: "loading" } | { kind: "edge"; info: EdgeInfo } | { kind: "direct" };

/**
 * @param everyMs 다시 재는 주기. 엣지는 자주 안 바뀌므로 넉넉히 둔다(기본 1분).
 */
export function useCfEdge(everyMs = 60_000): EdgeState {
  const [state, setState] = useState<EdgeState>({ kind: "loading" });
  /* 숨은 탭에서는 안 잰다 — 이 앱의 탭은 언마운트가 아니라 display:none 이다 (2026-09-22) */
  const tabActive = useTabActive();

  useEffect(() => {
    if (!tabActive) return;
    let alive = true;

    const probe = async () => {
      const t0 = Date.now();
      try {
        const r = await fetch("/cdn-cgi/trace", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
        const text = await r.text();
        if (!alive) return;
        const kv = parseTrace(text);
        /*
         * Cloudflare 가 아니면 `colo` 가 없다 — 우리 서버가 SPA 되돌림으로 `index.html` 을 준다.
         * 그걸 「못 읽었다」로 적으면 거짓말이다. 직통으로 들어온 것이니 그렇게 말한다.
         */
        if (!kv.colo) {
          setState({ kind: "direct" });
          return;
        }
        const colo = kv.colo.toUpperCase();
        setState({
          kind: "edge",
          info: { colo, place: PLACE[colo] ?? colo, ms: Date.now() - t0, home: colo === "ICN" },
        });
      } catch {
        /* 못 받으면 **지난 값을 지우지 않는다** — 한 번 튄 것으로 화면이 비면 더 헷갈린다 */
        if (alive) setState((s) => (s.kind === "loading" ? { kind: "direct" } : s));
      }
    };

    void probe();
    const t = window.setInterval(() => void probe(), everyMs);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [everyMs, tabActive]);

  return state;
}
